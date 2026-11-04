use crate::plugin_engine::manifest;
use rquickjs::{Context, Runtime};
use serde_json::Value;
use std::path::PathBuf;

// Evaluate the production manifest bundle in a fresh VM. This harness never injects
// native host APIs: every credential, file and HTTP operation is synthetic or denied.
fn probe(id: &str, setup: &str) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins");
    let plugin = manifest::load_plugins_from_dir(&root)
        .into_iter()
        .find(|plugin| plugin.manifest.id == id)
        .unwrap_or_else(|| panic!("production manifest failed to load: {id}"));
    assert!(!plugin.manifest.supporting_scripts.is_empty());
    let runtime = Runtime::new().unwrap();
    let context = Context::full(&runtime).unwrap();
    context.with(|vm| {
        let prelude = r#"
        const calls = [], config = {}, logs = [];
        const denied = () => { throw new Error('Unexpected synthetic host operation'); };
        const ctx = {
          nowIso:'2026-11-04T00:00:00.000Z',
          app:{platform:'darwin',pluginDataDir:'/synthetic/plugin'},
          host:{
            config:{get:name=>config[name]===undefined?null:config[name]},
            env:{get:denied},
            fs:{exists:()=>false,existsStrict:()=>false,readText:denied,writeText:denied},
            sqlite:{query:()=> '[]',exec:denied},
            keychain:{readGenericPassword:denied,readGenericPasswordForCurrentUser:denied},
            ls:{discover:()=>null},http:{request:denied,normalizeHttpsBaseUrl:value=>value},
            log:{info:message=>logs.push(message),warn:message=>logs.push(message),error:message=>logs.push(message)}
          },
          line:{
            text:options=>Object.assign({type:'text'},options),
            progress:options=>Object.assign({type:'progress'},options),
            badge:options=>Object.assign({type:'badge'},options),
            barChart:options=>Object.assign({type:'barChart'},options)
          },
          fmt:{planLabel:value=>value},
          util:{tryParseJson:text=>{try{return JSON.parse(text)}catch(_){return null}},
            isAuthStatus:status=>status===401||status===403,
            request:options=>ctx.host.http.request(options)}
        };
        const reply = (body,status=200) => ({status,bodyText:JSON.stringify(body)});
        "#;
        vm.eval::<(), _>(prelude).unwrap();
        vm.eval::<(), _>(plugin.entry_script.as_bytes())
            .unwrap_or_else(|error| panic!("{id} production bundle failed in QuickJS: {error}"));
        vm.eval::<(), _>(setup)
            .unwrap_or_else(|error| panic!("{id} synthetic setup failed: {error}"));
        let json: String = vm
            .eval("JSON.stringify({output:__openusage_plugin.probe(ctx),calls,logs})")
            .unwrap_or_else(|error| panic!("{id} production probe failed in QuickJS: {error}"));
        serde_json::from_str(&json).unwrap()
    })
}

fn line<'a>(value: &'a Value, label: &str) -> &'a Value {
    value["output"]["lines"]
        .as_array()
        .unwrap()
        .iter()
        .find(|line| line["label"] == label)
        .unwrap_or_else(|| panic!("missing {label}: {value}"))
}

#[test]
fn antigravity_production_bundle_reads_distinct_summary_windows_in_quickjs() {
    let result = probe(
        "antigravity",
        r#"
      ctx.host.fs.exists=path=>path==='/synthetic/plugin/auth.json';
      ctx.host.fs.readText=path=>{
        if(path!=='/synthetic/plugin/auth.json')return denied();
        return JSON.stringify({accessToken:'synthetic-antigravity-token',expiresAtMs:Date.now()+3600000});
      };
      ctx.host.ls.discover=denied;
      ctx.host.http.request=options=>{
        calls.push(options.url);
        if(options.headers.Authorization!=='Bearer synthetic-antigravity-token')return denied();
        if(options.url.endsWith(':loadCodeAssist'))return reply({cloudaicompanionProject:'synthetic-project',paidTier:{name:'Synthetic Plan'}});
        if(!options.url.endsWith(':retrieveUserQuotaSummary')||JSON.parse(options.bodyText).project!=='synthetic-project')return denied();
        const production=options.url.startsWith('https://cloudcode-pa.');
        return reply({groups:[{buckets:production?
          [{bucketId:'gemini-5h',remainingFraction:0.8}]:
          [{bucketId:'gemini-5h',remainingFraction:0.1},{bucketId:'gemini-weekly',remainingFraction:0.6},{bucketId:'3p-5h',remainingFraction:0},{bucketId:'3p-weekly',remainingFraction:0.5}]
        },{displayName:'Gemini 4 Argon',buckets:[{bucketId:'separate-argon',window:'weekly',remainingFraction:0.7}]}]});
      };
    "#,
    );
    assert_eq!(result["output"]["plan"], "Synthetic Plan");
    assert_eq!(line(&result, "Gemini")["used"], 20);
    assert_eq!(line(&result, "Gemini")["periodDurationMs"], 18_000_000);
    assert_eq!(line(&result, "Gemini Weekly")["used"], 40);
    assert_eq!(
        line(&result, "Gemini Weekly")["periodDurationMs"],
        604_800_000
    );
    assert_eq!(line(&result, "Claude")["used"], 100);
    assert_eq!(
        line(&result, "Claude Weekly")["periodDurationMs"],
        604_800_000
    );
    assert_eq!(line(&result, "Argon Weekly")["used"], 30);
    assert_eq!(result["output"]["lines"].as_array().unwrap().len(), 5);
    assert_eq!(result["calls"].as_array().unwrap().len(), 3);
}

#[test]
fn openrouter_production_bundle_completes_management_pages_without_activity_in_quickjs() {
    let result = probe(
        "openrouter",
        r#"
      config.apiKey='synthetic-openrouter-key';
      ctx.host.env.get=()=>null;
      const row=i=>({hash:String(i).padStart(64,'0'),disabled:true,expires_at:'2020-01-01T00:00:00Z',
        usage_daily:1,usage_weekly:2,usage_monthly:3,byok_usage_daily:4,byok_usage_weekly:5,byok_usage_monthly:6});
      ctx.host.http.request=options=>{
        calls.push(options.url);
        if(options.headers.Authorization!=='Bearer synthetic-openrouter-key')return denied();
        if(options.url.endsWith('/key'))return reply({data:{is_management_key:true,workspace_id:'00000000-0000-4000-8000-000000000001'}});
        if(options.url.endsWith('/credits'))return reply({},403);
        if(options.url.endsWith('/keys?include_disabled=true&include_expired=true&offset=0'))return reply({data:Array.from({length:100},(_,i)=>row(i))});
        if(options.url.endsWith('/keys?include_disabled=true&include_expired=true&offset=100'))return reply({data:[row(100)]});
        return denied();
      };
    "#,
    );
    assert_eq!(line(&result, "Listed Keys Daily Spend")["value"], "$101.00");
    assert_eq!(
        line(&result, "Listed Keys Monthly Spend")["value"],
        "$303.00"
    );
    assert_eq!(line(&result, "BYOK Daily Spend")["value"], "$404.00");
    assert_eq!(
        line(&result, "Balance Status")["text"],
        "Balance Unavailable"
    );
    assert_eq!(result["calls"].as_array().unwrap().len(), 4);
    assert!(
        result["calls"]
            .as_array()
            .unwrap()
            .iter()
            .all(|url| !url.as_str().unwrap().contains("activity"))
    );
}

#[test]
fn minimax_production_bundle_keeps_percent_units_and_independent_weekly_window_in_quickjs() {
    let result = probe(
        "minimax",
        r#"
      config.source='webChina';config.webCookie='session=synthetic-minimax-cookie';
      ctx.host.http.request=options=>{
        calls.push(options.url);
        if(options.url!=='https://www.minimax.cn/backend/account/token_plan/remains_percent'||options.headers.Cookie!==config.webCookie)return denied();
        return reply({base_resp:{status_code:0},model_remains:[{model_name:'general',current_interval_used_percent:'8%',current_interval_total_percent:'100%',
          remains_time:3600000,current_weekly_used_percent:'45%',current_weekly_total_percent:'150%',weekly_remains_time:7200000}]});
      };
    "#,
    );
    assert_eq!(line(&result, "Session")["used"], 8);
    assert_eq!(line(&result, "Weekly")["used"], 30);
    assert_eq!(
        line(&result, "Session")["resetsAt"],
        "2026-11-04T01:00:00.000Z"
    );
    assert_eq!(
        line(&result, "Weekly Capacity")["value"],
        "150% of base quota"
    );
    assert_eq!(result["calls"].as_array().unwrap().len(), 1);
}

#[test]
fn perplexity_production_bundle_keeps_personal_org_and_cap_credits_separate_in_quickjs() {
    let result = probe(
        "perplexity",
        r#"
      config.source='webSubscription';config.webCookie='authjs.session-token=synthetic-perplexity-cookie';
      ctx.host.sqlite.query=denied;
      ctx.host.http.request=options=>{
        calls.push(options.url);
        if(!options.url.startsWith('https://www.perplexity.ai/rest/billing/credits?')||options.headers.Cookie!==config.webCookie)return denied();
        return reply({balance_cents:900,renewal_date_ts:1793836800,current_period_purchased_cents:500,total_usage_cents:1300,
          credit_grants:[{type:'recurring',amount_cents:1000},{type:'purchased',amount_cents:500},{type:'promotional',amount_cents:200,expires_at_ts:1893456000}],
          org_pool_draws_cents:100,org_user_cap_cents:800,is_org_pool_depleted:false});
      };
    "#,
    );
    assert_eq!(line(&result, "Subscription Credits")["used"], 1000);
    assert_eq!(line(&result, "Purchased Credits")["used"], 300);
    assert_eq!(line(&result, "Promotional Credits")["limit"], 200);
    assert_eq!(line(&result, "Organization Credits")["used"], 100);
    assert_eq!(line(&result, "Organization Credits")["limit"], 600);
    assert_eq!(
        line(&result, "Member Cap Remaining")["value"],
        "700 credits"
    );
    assert_eq!(
        line(&result, "Organization Credits")["format"]["kind"],
        "count"
    );
    assert_eq!(
        line(&result, "Organization Credits")["format"]["suffix"],
        "credits"
    );
    assert_eq!(result["calls"].as_array().unwrap().len(), 1);
}
