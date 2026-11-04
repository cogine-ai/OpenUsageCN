use super::*;
use crate::plugin_engine::manifest::{self, PluginManifest};
use std::sync::{Arc, atomic::AtomicBool};

fn fixture(script: &str) -> LoadedPlugin {
    LoadedPlugin {
        manifest: PluginManifest {
            schema_version: 1,
            id: "synthetic".into(),
            name: "Fixture".into(),
            version: "0.0.0".into(),
            entry: "plugin.js".into(),
            supporting_scripts: vec![],
            icon: "icon.svg".into(),
            brand_color: None,
            lines: vec![],
            links: vec![],
            status_page: None,
            config: None,
            account_support: None,
        },
        plugin_dir: PathBuf::from("."),
        entry_script: script.into(),
        icon_data_url: String::new(),
    }
}

fn run(plugin: &LoadedPlugin) -> Result<crate::provider_reports::ReportsOutput, String> {
    run_reports(
        plugin,
        &std::env::temp_dir(),
        "0.0.0",
        Instant::now() + Duration::from_secs(2),
        Arc::new(AtomicBool::new(false)),
    )
}

#[test]
fn report_runtime_accepts_empty_partial_sections_and_keeps_negative_credit_text() {
    let output = run(&fixture(r#"globalThis.__openusage_plugin={probeReports:ctx=>({scopeKey:'a'.repeat(64),lines:[ctx.line.text({label:'Credits',value:'-2 credits'})],reports:[{id:'credits',label:'Credits',status:'partial',coverage:{fromDate:'2026-10-01',toDate:'2026-10-02',timeZone:'UTC',reportedDates:['2026-10-01'],missingDates:['2026-10-02']}}]})}"#)).unwrap();
    assert!(matches!(&output.lines[0], MetricLine::Text { value, .. } if value == "-2 credits"));
    assert!(run(&fixture(r#"globalThis.__openusage_plugin={probeReports:()=>({scopeKey:'a'.repeat(64),lines:[],reports:[{id:'counts',label:'Counts',status:'permissionDenied'}]})}"#)).unwrap().lines.is_empty());
}

#[test]
fn reports_reject_invalid_scope_duplicate_dates_negative_chart_and_quota_lines() {
    for body in [
        "{scopeKey:'private-id',lines:[],reports:[{id:'x',label:'X',status:'ready'}]}",
        "{scopeKey:'a'.repeat(64),lines:[{type:'barChart',label:'Credits',points:[{label:'Date',value:-1}]}],reports:[{id:'x',label:'X',status:'ready'}]}",
        "{scopeKey:'a'.repeat(64),lines:[{type:'progress',label:'Quota',used:1,limit:10,format:{kind:'percent'}}],reports:[{id:'x',label:'X',status:'ready'}]}",
        "{scopeKey:'a'.repeat(64),lines:[],reports:[{id:'x',label:'X',status:'ready',coverage:{fromDate:'2026-10-01',toDate:'2026-10-02',timeZone:'UTC',reportedDates:['2026-10-01'],missingDates:['2026-10-01']}}]}",
    ] {
        assert!(
            run(&fixture(&format!(
                "globalThis.__openusage_plugin={{probeReports:()=>({body})}}"
            )))
            .is_err()
        );
    }
}

#[test]
fn reports_have_a_deadline_and_do_not_run_quota_or_local_history() {
    let plugin = fixture(
        "globalThis.__openusage_plugin={probe:()=>{throw 'quota'},probeHistory:()=>{throw 'local'},probeReports:()=>{while(true){}}}",
    );
    let error = run_reports(
        &plugin,
        &std::env::temp_dir(),
        "0.0.0",
        Instant::now() + Duration::from_millis(50),
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap_err();
    assert!(error.contains("timed out"));
    let cancellation = Arc::new(AtomicBool::new(true));
    assert!(
        run_reports(
            &plugin,
            &std::env::temp_dir(),
            "0.0.0",
            Instant::now() + Duration::from_secs(2),
            cancellation
        )
        .unwrap_err()
        .contains("cancelled")
    );
}

#[test]
fn actual_codex_supporting_script_runs_in_quickjs_with_synthetic_auth_and_http() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins");
    let mut plugin = manifest::load_plugins_from_dir(&root)
        .into_iter()
        .find(|p| p.manifest.id == "codex")
        .unwrap();
    let setup = r#"
    const syntheticAuth=JSON.stringify({tokens:{access_token:'header.eyJzdWIiOiJmdWxsLXN5bnRoZXRpYy11c2VyIn0.signature',account_id:'workspace-synthetic'}});
    __openusage_ctx.host.fs.exists=path=>path==='~/.config/codex/auth.json';
    __openusage_ctx.host.fs.existsStrict=__openusage_ctx.host.fs.exists;
    __openusage_ctx.host.fs.readText=()=>syntheticAuth;
    __openusage_ctx.host.env.get=()=>null;
    __openusage_ctx.host.keychain.readGenericPassword=()=>{throw 'must not read real keychain'};
    __openusage_ctx.host.fs.writeText=()=>{throw 'reports must not write auth'};
    __openusage_ctx.host.ccusage.query=()=>{throw 'reports must not query local history'};
    __openusage_ctx.util.request=opts=>{
      if(opts.headers['ChatGPT-Account-Id']!=='workspace-synthetic')throw 'workspace mismatch';
      const date=new Date().toISOString().slice(0,10);
      const body=opts.url.includes('analytics/')?{data:[{date,totals:{turns:2,text_total_tokens:12}}]}:
        opts.url.includes('token-usage-breakdown')?{data:[{date,premium_usage_values:{credit_usage_credits:{cli:-1.5}}}]}:{plan_type:'team'};
      return {status:200,headers:{},bodyText:JSON.stringify(body)};
    };
    "#;
    plugin.entry_script = format!("{setup}\n{}", plugin.entry_script);
    let output = run(&plugin).unwrap();
    assert_eq!(output.scope_key.len(), 64);
    assert!(
        output
            .lines
            .iter()
            .any(|line| matches!(line, MetricLine::Text {value,..} if value == "-1.5 credits"))
    );
    assert!(
        output
            .lines
            .iter()
            .any(|line| matches!(line, MetricLine::BarChart {label,..} if label == "Daily Tokens"))
    );
    assert_eq!(output.reports.len(), 2);
    assert!(matches!(
        output.reports[0].status,
        crate::provider_reports::ReportStatus::Partial
    ));
}

#[test]
fn actual_ollama_and_openrouter_report_bundles_run_with_synthetic_inputs_only() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins");
    for id in ["ollama", "openrouter"] {
        let mut plugin = manifest::load_plugins_from_dir(&root)
            .into_iter()
            .find(|plugin| plugin.manifest.id == id)
            .unwrap();
        let setup = r#"
        __openusage_ctx.host.config.get=name=>name==='source'?'apiKey':name==='apiKey'?'synthetic-key':null;
        __openusage_ctx.host.env.get=()=>null;
        __openusage_ctx.host.keychain.readGenericPassword=()=>{throw 'no real credentials'};
        __openusage_ctx.host.fs.readText=()=>{throw 'no real files'};
        __openusage_ctx.util.request=opts=>{
          const body=opts.url.includes('/api/me')?{Email:'synthetic@example.invalid',ID:'whole-user'}:
            opts.url.includes('/api/usage')?{granularity:'day',buckets:[]}:
            opts.url.endsWith('/key')?{data:{is_management_key:true}}:{data:[]};
          return {status:200,headers:{},bodyText:JSON.stringify(body)};
        };
        "#;
        plugin.entry_script = format!("{setup}\n{}", plugin.entry_script);
        let output = run(&plugin).unwrap();
        assert_eq!(output.scope_key.len(), 64);
        assert_eq!(output.reports.len(), if id == "ollama" { 2 } else { 1 });
        assert!(output.reports.iter().all(|report| matches!(
            report.status,
            crate::provider_reports::ReportStatus::Partial
        )));
    }
}
