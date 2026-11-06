use crate::plugin_engine::{host_api, manifest};
use rquickjs::{Context, Function, Object, Runtime};
use serde_json::{json, Value};

// Full production bundles, actual host line builders and native parsing. Only
// credentials/HTTP are synthetic; unexpected filesystem mutations fail the probe.
fn probe(id: &str, setup: &str) -> Result<Value, String> {
    let plugin = manifest::load_plugins_from_dir(
        &std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins"),
    )
    .into_iter()
    .find(|plugin| plugin.manifest.id == id)
    .unwrap();
    let runtime = Runtime::new().unwrap();
    Context::full(&runtime).unwrap().with(|vm| {
        vm.globals().set("sha256", Function::new(vm.clone(), |value: String| crate::safe_file::sha256_hex(value.as_bytes())).unwrap()).unwrap();
        vm.eval::<(), _>(r#"
          const calls=[],logs=[];
          const denied=()=>{throw 'Unexpected synthetic host operation';};
          const ctx={nowIso:'2026-10-20T00:00:00Z',app:{platform:'darwin'},host:{
            config:{get:()=>null},env:{get:()=>null},crypto:{sha256Hex:sha256},
            fs:{exists:()=>false,readText:denied,writeText:denied},
            sqlite:{query:()=> '[]',exec:denied},keychain:{readGenericPassword:()=>null,writeGenericPassword:denied},
            http:{request:denied},log:{info:s=>logs.push(s),warn:s=>logs.push(s),error:s=>logs.push(s)}
          }};
          globalThis.__openusage_ctx=ctx;
          const reply=(body,status=200)=>({status,bodyText:JSON.stringify(body)});
        "#).unwrap();
        host_api::inject_utils(&vm).unwrap();
        vm.eval::<(), _>(plugin.entry_script.as_bytes()).unwrap();
        vm.eval::<(), _>(setup).unwrap();
        let output: Object = vm.eval("__openusage_plugin.probe(ctx)")
            .map_err(|_| super::extract_error_string(&vm))?;
        let lines = super::parse_lines(&output)?;
        let metadata: String = vm.eval("JSON.stringify({calls,logs})").unwrap();
        let mut result: Value = serde_json::from_str(&metadata).unwrap();
        result["lines"] = serde_json::to_value(lines).unwrap();
        assert!(result["lines"].as_array().unwrap().iter().all(|line| line["label"] != "Error"), "{id}: {result}");
        Ok(result)
    })
}

fn line<'a>(result: &'a Value, label: &str) -> &'a Value {
    result["lines"]
        .as_array()
        .unwrap()
        .iter()
        .find(|line| line["label"] == label)
        .unwrap_or_else(|| panic!("missing {label}: {result}"))
}

const CLAUDE: &str = r#"
  ctx.host.keychain.readGenericPassword=()=>JSON.stringify({claudeAiOauth:{accessToken:'synthetic-oauth',subscriptionType:'pro'}});
  let usage={five_hour:{utilization:20},seven_day:{utilization:10},extra_usage:{is_enabled:true,currency:'BHD',decimal_places:3,used_credits:1234,monthly_limit:10000},
    limits:[{kind:'weekly_scoped',group:'weekly',percent:0.5,resets_at:'2026-12-01T00:00:00Z',scope:{model:{id:'private-fable',display_name:'Fable'}}},
      {kind:'weekly_scoped',group:'weekly',percent:25,scope:{model:{id:'private-other',display_name:'New Model'}}}]};
  ctx.host.http.request=options=>{calls.push(options.url);if(!options.url.endsWith('/api/oauth/usage'))return denied();return reply(usage)};
"#;

#[test]
fn claude_full_bundle_keeps_bhd_precision_and_dynamic_models_through_native_parser() {
    let result = probe("claude", CLAUDE).unwrap();
    assert_eq!(line(&result, "Extra Spent")["value"], "BHD 1.234");
    assert_eq!(line(&result, "Extra Limit")["value"], "BHD 10.000");
    assert_eq!(line(&result, "Fable Weekly")["limitResourceKey"], "fable");
    assert_eq!(line(&result, "Fable Weekly")["used"].as_f64(), Some(0.5));
    assert_eq!(
        line(&result, "New Model Weekly")["format"],
        json!({"kind":"percent"})
    );
    assert!(line(&result, "New Model Weekly")
        .get("limitResourceKey")
        .is_none());
    assert!(!result["lines"].to_string().contains("private-"));
    assert!(!result["lines"]
        .as_array()
        .unwrap()
        .iter()
        .any(|line| line["label"] == "Extra usage spent"));
}

#[test]
fn claude_usd_resource_keeps_reported_decimal_scale_and_bad_money_is_partial() {
    let usd = probe(
        "claude",
        &format!("{CLAUDE}\nusage.extra_usage.currency='USD';"),
    )
    .unwrap();
    assert_eq!(
        line(&usd, "Extra usage spent")["used"].as_f64(),
        Some(1.234)
    );
    assert_eq!(
        line(&usd, "Extra usage spent")["format"],
        json!({"kind":"dollars"})
    );
    let invalid = probe(
        "claude",
        &format!("{CLAUDE}\nusage.extra_usage.decimal_places=-1;"),
    )
    .unwrap();
    assert_eq!(line(&invalid, "Extra Spent")["value"], "Unavailable");
    assert_eq!(line(&invalid, "Session")["used"].as_f64(), Some(20.0));
}

const SYNTHETIC: &str = r#"
  ctx.host.env.get=name=>name==='SYNTHETIC_API_KEY'?'synthetic-key':null;
  let usage={planWeeklyLimit:{percentRemaining:0.5,nextRegenAt:'2026-11-07T00:30:00+08:00',nextRegenPercent:0.5},
    rollingFiveHourLimit:{max:100,remaining:0,limited:true},subscription:{limit:500,requests:0},search:{hourly:{limit:250,requests:5}}};
  ctx.host.http.request=options=>{calls.push(options.url);if(options.url!=='https://api.synthetic.new/v2/quotas'||options.headers.Authorization!=='Bearer synthetic-key')return denied();return reply({data:usage})};
"#;

#[test]
fn synthetic_full_bundle_preserves_weekly_precision_and_regeneration_text_without_reset() {
    let result = probe("synthetic", SYNTHETIC).unwrap();
    assert_eq!(line(&result, "Weekly")["used"].as_f64(), Some(99.5));
    assert!(line(&result, "Weekly")["resetsAt"].is_null());
    assert!(line(&result, "Weekly")["periodDurationMs"].is_null());
    assert_eq!(
        line(&result, "Next Regen")["value"],
        "2026-11-06T16:30:00.000Z"
    );
    assert_eq!(
        line(&result, "Next Regen")["subtitle"],
        "UTC · Partial Regeneration, Not A Full Reset"
    );
    assert_eq!(line(&result, "Regen Percent")["value"], "0.5%");
    assert_eq!(result["lines"].as_array().unwrap().len(), 4);
}

#[test]
fn synthetic_invalid_new_plan_does_not_fall_back_to_retired_counter() {
    let error = probe(
        "synthetic",
        &format!("{SYNTHETIC}\nusage.planWeeklyLimit=null;"),
    )
    .unwrap_err();
    assert_eq!(
        error,
        "Synthetic weekly plan usage is unavailable. Try again later."
    );
}

const CURSOR: &str = r#"
  const token='a.'+ctx.base64.encode(JSON.stringify({sub:'auth0|synthetic-user',exp:9999999999}))+'.c';
  ctx.host.sqlite.query=(_db,sql)=>sql.includes('cursorAuth/accessToken')?JSON.stringify([{value:token}]):'[]';
  ctx.host.http.request=options=>{
    calls.push(options.url);
    if(options.url.endsWith('GetCurrentPeriodUsage'))return reply({enabled:true,planUsage:{limit:2000,totalSpend:500,totalPercentUsed:25},spendLimitUsage:{individualLimit:1000,individualRemaining:750}});
    if(options.url.endsWith('GetPlanInfo'))return reply({planInfo:{planName:'Pro'}});
    if(options.url.endsWith('/api/usage-summary'))return reply({membershipType:'unified_ultra',limitType:'user'});
    if(options.url.endsWith('/api/dashboard/v2/usage-status?scope=user')){
      if(options.headers.Cookie!=='WorkosCursorSessionToken=synthetic-user%3A%3A'+token)return denied();
      return reply({availability:'available',monthlyUsage:{usedCents:93,limitCents:1000,creditsUsedCents:500,periodStart:'2026-10-01T00:00:00Z',resetsAt:'2026-11-01T00:00:00Z'}});
    }
    return reply({});
  };
"#;

#[test]
fn cursor_full_bundle_exports_one_monthly_resource_without_changing_included_usage() {
    let result = probe("cursor", CURSOR).unwrap();
    assert_eq!(line(&result, "On-demand")["limitResourceKey"], "onDemand");
    assert_eq!(line(&result, "On-demand")["used"].as_f64(), Some(0.93));
    assert_eq!(line(&result, "On-demand")["limit"].as_f64(), Some(10.0));
    assert_eq!(
        line(&result, "On-demand")["resetsAt"],
        "2026-11-01T00:00:00Z"
    );
    assert_eq!(line(&result, "Total usage")["used"].as_f64(), Some(25.0));
    assert_eq!(line(&result, "Billing Scope")["value"], "Current User");
    assert_eq!(
        result["lines"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|line| line["label"] == "On-demand")
            .count(),
        1
    );
    assert!(!result["calls"].to_string().contains("usage-events"));
}
