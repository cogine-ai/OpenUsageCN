//! Production bundles and production JS utilities, with no native host injection.
use crate::plugin_engine::{host_api, manifest};
use rquickjs::{Context, Runtime};
use serde_json::Value;
use std::path::PathBuf;

fn probe(id: &str, setup: &str) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins");
    let plugin = manifest::load_plugins_from_dir(&root)
        .into_iter()
        .find(|plugin| plugin.manifest.id == id)
        .unwrap();
    assert!(!plugin.manifest.supporting_scripts.is_empty());
    let runtime = Runtime::new().unwrap();
    Context::full(&runtime).unwrap().with(|vm| {
        vm.eval::<(), _>(r#"
          const calls=[], logs=[];
          const denied=()=>{throw new Error('Unexpected synthetic host operation')};
          const ctx={nowIso:'2026-11-04T00:00:00.000Z',app:{platform:'macos',version:'test'},host:{
            fs:{exists:()=>false,existsStrict:()=>false,readText:denied,writeText:denied,listDir:denied},
            env:{get:()=>null},config:{get:()=>null},
            sqlite:{query:denied,queryReadOnly:denied},
            http:{request:denied},keychain:{readGenericPassword:denied},
            log:{error:s=>logs.push(s),warn:s=>logs.push(s),info:s=>logs.push(s)}
          }};
          globalThis.__openusage_ctx=ctx;
          const reply=(body,status=200)=>({status,bodyText:JSON.stringify(body)});
          const credit={resourceType:'CREDIT',currentUsageWithPrecision:120,usageLimitWithPrecision:100,
            currentOveragesWithPrecision:20,overageCapWithPrecision:50,bonuses:[],nextDateReset:1793750400};
          const usage={usageBreakdownList:[credit],overageConfiguration:{overageStatus:'ENABLED'}};
        "#).unwrap();
        host_api::inject_utils(&vm).unwrap();
        vm.eval::<(), _>(plugin.entry_script.as_bytes()).unwrap();
        vm.eval::<(), _>(setup).unwrap();
        let serialized: String = vm.eval(r#"
          JSON.stringify((()=>{try{return {output:__openusage_plugin.probe(ctx),calls,logs}}
          catch(error){return {error:String(error),calls,logs}}})())
        "#).unwrap();
        serde_json::from_str(&serialized).unwrap()
    })
}
const CLI: &str = r#"
  ctx.host.fs.exists=ctx.host.fs.existsStrict=path=>path==='~/Library/Application Support/kiro-cli/data.sqlite3';
  ctx.host.sqlite.queryReadOnly=(db,sql)=>JSON.stringify(sql.includes('auth_kv')?
    [{value:JSON.stringify({access_token:'synthetic-kiro-token'})}]:[]);
  ctx.host.http.request=request=>{
    if(request.url!=='https://codewhisperer.us-east-1.amazonaws.com/'||request.method!=='POST'||request.bodyText!=='{}')return denied();
    calls.push(request.url);
    return reply(usage);
  };
"#;
fn line<'a>(value: &'a Value, name: &str) -> &'a Value {
    value["output"]["lines"]
        .as_array()
        .unwrap()
        .iter()
        .find(|line| line["label"] == name)
        .unwrap()
}

#[test]
fn kiro_cli_bundle_splits_plan_and_overage_without_native_credentials() {
    let result = probe("kiro", CLI);
    assert_eq!(line(&result, "Credits")["used"], 100);
    assert_eq!(line(&result, "Credits")["limit"], 100);
    assert_eq!(line(&result, "Overage Credits")["used"], 20);
    assert_eq!(line(&result, "Overage Credits")["limit"], 50);
    assert_eq!(result["calls"].as_array().unwrap().len(), 1);
}
#[test]
fn kiro_bonus_inclusive_api_never_fabricates_a_separated_main_pool() {
    let result = probe("kiro", &format!("{CLI}\ncredit.bonuses=[{{currentUsage:30,usageLimit:50,expiresAt:'2026-11-07T00:30:00Z'}}];credit.currentUsageWithPrecision=150;"));
    assert_eq!(line(&result, "Credits")["type"], "badge");
    assert_eq!(line(&result, "Bonus Credits")["used"], 30);
    assert!(line(&result, "Bonus Credits").get("resetsAt").is_none());
    assert_eq!(
        line(&result, "Bonus Expiry")["value"],
        "2026-11-07T00:30:00.000Z"
    );
    assert_eq!(line(&result, "Overage Credits")["used"], 20);
}
#[test]
fn kiro_cli_denied_request_cannot_fall_back_to_desktop() {
    let result = probe("kiro", &format!("{CLI}\nctx.host.http.request=request=>{{calls.push(request.url);return reply({{}},401)}};"));
    assert_eq!(
        result["error"],
        "Kiro CLI session expired. Run kiro-cli login again."
    );
    assert_eq!(result["calls"].as_array().unwrap().len(), 1);
    assert!(!result["logs"].to_string().contains("synthetic-kiro-token"));
}
const ZAI: &str = r#"
  ctx.host.config.get=name=>name==='apiKey'?'synthetic-zai-key':null;
  ctx.host.http.request=request=>{
    if(request.method!=='GET'||request.headers.Authorization!=='Bearer synthetic-zai-key')return denied();
    calls.push(request.url);
    if(request.url.includes('subscription'))return reply({data:[]});
    if(request.url.includes('/quota/'))return reply({data:{limits:[{type:'CREDIT_LIMIT',unit:3,number:5,percentage:64}]}});
    if(!request.url.endsWith('/customer-package-reset/list?targetType=PERSONAL'))return denied();
    return resetResponse;
  };
"#;
#[test]
fn zai_coupons_bundle_preserves_utc8_crossing_midnight_and_equal_expiries() {
    let result = probe(
        "zai",
        &format!(
            r#"{ZAI}
      const row=id=>({{recordId:id,available:true,expireTime:'2026-11-05 00:30:00',grantType:'GLOBAL'}});
      const resetResponse=reply({{data:{{fiveHourResets:[row(11),row(12)],weekResets:[row(21)]}}}});
    "#
        ),
    );
    assert_eq!(line(&result, "5h Reset Coupons")["value"], "2");
    assert_eq!(line(&result, "Weekly Reset Coupons")["value"], "1");
    assert_eq!(line(&result, "Coupon Expiry")["value"], "2026-11-05 00:30");
    assert_eq!(line(&result, "Coupon Expiry")["subtitle"], "UTC+08:00");
    assert_eq!(result["calls"].as_array().unwrap().len(), 3);
    assert!(!result["output"].to_string().contains("recordId"));
}
#[test]
fn zai_optional_coupon_failure_leaves_the_primary_meter_available() {
    let result = probe(
        "zai",
        &format!("{ZAI}\nconst resetResponse=reply({{}},403);"),
    );
    assert_eq!(line(&result, "Session")["used"], 64);
    assert_eq!(line(&result, "5h Reset Coupons")["value"], "Unavailable");
    assert!(!result["logs"].to_string().contains("synthetic-zai-key"));
}
