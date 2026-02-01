use crate::plugin_engine::host_api;
use crate::plugin_engine::manifest::LoadedPlugin;
use rquickjs::{Array, Context, Error, Object, Promise, Runtime, Value};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MetricLine {
    Text {
        label: String,
        value: String,
        color: Option<String>,
    },
    Progress {
        label: String,
        value: f64,
        max: f64,
        unit: Option<String>,
        color: Option<String>,
    },
    Badge {
        label: String,
        text: String,
        color: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginOutput {
    pub provider_id: String,
    pub display_name: String,
    pub lines: Vec<MetricLine>,
    pub icon_url: String,
}

pub fn run_probe(
    plugin: &LoadedPlugin,
    app_data_dir: &PathBuf,
    app_version: &str,
) -> PluginOutput {
    let fallback = error_output(plugin, "runtime error".to_string());

    let rt = match Runtime::new() {
        Ok(rt) => rt,
        Err(_) => return fallback,
    };

    let ctx = match Context::full(&rt) {
        Ok(ctx) => ctx,
        Err(_) => return fallback,
    };

    let plugin_id = plugin.manifest.id.clone();
    let display_name = plugin.manifest.name.clone();
    let entry_script = plugin.entry_script.clone();
    let icon_url = plugin.icon_data_url.clone();
    let app_data = app_data_dir.clone();

    ctx.with(|ctx| {
        if host_api::inject_host_api(&ctx, &plugin_id, &app_data, app_version).is_err() {
            return error_output(plugin, "host api injection failed".to_string());
        }
        if host_api::patch_http_wrapper(&ctx).is_err() {
            return error_output(plugin, "http wrapper patch failed".to_string());
        }

        if ctx.eval::<(), _>(entry_script.as_bytes()).is_err() {
            return error_output(plugin, "script eval failed".to_string());
        }

        let globals = ctx.globals();
        let plugin_obj: Object = match globals.get("__openusage_plugin") {
            Ok(obj) => obj,
            Err(_) => return error_output(plugin, "missing __openusage_plugin".to_string()),
        };

        let probe_fn: rquickjs::Function = match plugin_obj.get("probe") {
            Ok(f) => f,
            Err(_) => return error_output(plugin, "missing probe()".to_string()),
        };

        let probe_ctx: Value = globals
            .get("__openusage_ctx")
            .unwrap_or_else(|_| Value::new_undefined(ctx.clone()));

        let result_value: Value = match probe_fn.call((probe_ctx,)) {
            Ok(r) => r,
            Err(_) => return error_output(plugin, "probe() failed".to_string()),
        };
        let result: Object = if result_value.is_promise() {
            let promise: Promise = match result_value.into_promise() {
                Some(promise) => promise,
                None => return error_output(plugin, "probe() returned invalid promise".to_string()),
            };
            match promise.finish::<Object>() {
                Ok(obj) => obj,
                Err(Error::WouldBlock) => {
                    return error_output(plugin, "probe() returned unresolved promise".to_string())
                }
                Err(_) => return error_output(plugin, "probe() promise rejected".to_string()),
            }
        } else {
            match result_value.into_object() {
                Some(obj) => obj,
                None => return error_output(plugin, "probe() returned non-object".to_string()),
            }
        };

        let lines = match parse_lines(&result) {
            Ok(lines) if !lines.is_empty() => lines,
            Ok(_) => vec![error_line("no lines returned".to_string())],
            Err(msg) => vec![error_line(msg)],
        };

        PluginOutput {
            provider_id: plugin_id,
            display_name,
            lines,
            icon_url,
        }
    })
}

pub fn run_all_probes(
    plugins: &[LoadedPlugin],
    app_data_dir: &PathBuf,
    app_version: &str,
) -> Vec<PluginOutput> {
    plugins
        .iter()
        .map(|p| run_probe(p, app_data_dir, app_version))
        .collect()
}

fn parse_lines(result: &Object) -> Result<Vec<MetricLine>, String> {
    let lines: Array = result
        .get("lines")
        .map_err(|_| "missing lines".to_string())?;

    let mut out = Vec::new();
    let len = lines.len();
    for idx in 0..len {
        let line: Object = lines
            .get(idx)
            .map_err(|_| format!("invalid line at index {}", idx))?;

        let line_type: String = line.get("type").unwrap_or_default();
        let label = line.get::<_, String>("label").unwrap_or_default();
        let color = line.get::<_, String>("color").ok();

        match line_type.as_str() {
            "text" => {
                let value = line.get::<_, String>("value").unwrap_or_default();
                out.push(MetricLine::Text { label, value, color });
            }
            "progress" => {
                let mut value = line.get::<_, f64>("value").unwrap_or(0.0);
                let mut max = line.get::<_, f64>("max").unwrap_or(0.0);
                if !value.is_finite() || !max.is_finite() {
                    log::error!(
                        "invalid progress values at index {} (value={}, max={})",
                        idx,
                        value,
                        max
                    );
                    value = -1.0;
                    max = 0.0;
                }
                let unit = line.get::<_, String>("unit").ok();
                out.push(MetricLine::Progress {
                    label,
                    value,
                    max,
                    unit,
                    color,
                });
            }
            "badge" => {
                let text = line.get::<_, String>("text").unwrap_or_default();
                out.push(MetricLine::Badge { label, text, color });
            }
            _ => {
                return Err(format!("unknown line type: {}", line_type));
            }
        }
    }

    Ok(out)
}

fn error_output(plugin: &LoadedPlugin, message: String) -> PluginOutput {
    PluginOutput {
        provider_id: plugin.manifest.id.clone(),
        display_name: plugin.manifest.name.clone(),
        lines: vec![error_line(message)],
        icon_url: plugin.icon_data_url.clone(),
    }
}

fn error_line(message: String) -> MetricLine {
    MetricLine::Badge {
        label: "Error".to_string(),
        text: message,
        color: Some("#ef4444".to_string()),
    }
}
