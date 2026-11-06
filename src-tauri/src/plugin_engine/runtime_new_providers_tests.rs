use crate::plugin_engine::{endpoint_url, host_api, manifest};
use rquickjs::{Context, Function, Object, Runtime};
use serde_json::{json, Value};

// Load the production bundle (including supportingScripts), but expose only
// synthetic host operations. Native line builders and the native line parser
// remain in the path so a permissive Node fixture cannot hide a lost field.
fn probe_result(id: &str, setup: &str) -> Result<Value, String> {
    let plugin = manifest::load_plugins_from_dir(
        &std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins"),
    )
    .into_iter()
    .find(|plugin| plugin.manifest.id == id)
    .unwrap_or_else(|| panic!("production manifest failed to load: {id}"));
    let runtime = Runtime::new().unwrap();
    let context = Context::full(&runtime).unwrap();
    context.with(|vm| {
        let allowed_env: Vec<_> = plugin.manifest.config.iter()
            .flat_map(|config| &config.fields)
            .flat_map(|field| &field.environment_variables)
            .collect();
        vm.eval::<(), _>(format!("const allowedEnv={};", serde_json::to_string(&allowed_env).unwrap())).unwrap();
        vm.globals()
            .set(
                "normalizeConfiguredBaseUrl",
                Function::new(vm.clone(), |value: String| {
                    endpoint_url::normalize_configured_base_url(&value)
                })
                .unwrap(),
            )
            .unwrap();
        vm.eval::<(), _>(r#"
          const calls=[],logs=[],config={};
          const denied=()=>{throw new Error('Unexpected synthetic host operation');};
          const ctx={nowIso:'2026-11-06T00:00:00Z',host:{
            config:{get:key=>config[key]===undefined?null:config[key]},
            env:{get:key=>allowedEnv.includes(key)?null:denied()},fs:{readText:denied,writeText:denied,exists:denied},
            keychain:{readGenericPassword:denied},
            http:{request:denied,normalizeConfiguredBaseUrl},
            log:{info:value=>logs.push(value),warn:value=>logs.push(value),error:value=>logs.push(value)}
          }};
          globalThis.__openusage_ctx=ctx;
          const reply=(body,status=200)=>({status,bodyText:JSON.stringify(body)});
        "#).unwrap();
        host_api::inject_utils(&vm).unwrap();
        vm.eval::<(), _>(plugin.entry_script.as_bytes())
            .unwrap_or_else(|error| panic!("{id} production bundle failed in QuickJS: {error}"));
        vm.eval::<(), _>(setup).unwrap();
        let output: Object = vm
            .eval("__openusage_plugin.probe(ctx)")
            .map_err(|_| super::extract_error_string(&vm))?;
        let lines = super::parse_lines(&output)?;
        let metadata: String = vm.eval("JSON.stringify({calls,logs})").unwrap();
        let mut result: Value = serde_json::from_str(&metadata).unwrap();
        result["lines"] = serde_json::to_value(&lines).unwrap();
        result["plan"] = json!(output.get::<_, String>("plan").ok());
        result["resources"] = Value::Array(
            plugin.manifest.lines.iter().filter_map(|line| {
                let resource = line.limit_resource.as_ref()?;
                Some(json!({"label":line.label,"key":resource.key,"unit":resource.count_unit}))
            }).collect(),
        );
        assert!(result["lines"].as_array().unwrap().iter().all(|line| line["label"] != "Error"), "{id}: {result}");
        Ok(result)
    })
}

fn probe(id: &str, setup: &str) -> Value {
    probe_result(id, setup).unwrap_or_else(|error| panic!("{id} probe failed: {error}"))
}

fn line<'a>(result: &'a Value, label: &str) -> &'a Value {
    result["lines"]
        .as_array()
        .unwrap()
        .iter()
        .find(|line| line["label"] == label)
        .unwrap_or_else(|| panic!("missing {label}: {result}"))
}

fn resource(result: &Value, label: &str, key: &str, unit: Option<&str>) {
    assert_eq!(line(result, label)["type"], "progress");
    assert!(
        result["resources"]
            .as_array()
            .unwrap()
            .contains(&json!({"label":label,"key":key,"unit":unit})),
        "{result}"
    );
}

const CLAUDE: &str = r#"
  config.cookieHeader='sessionKey=synthetic-session';
  ctx.host.http.request=options=>{
    calls.push(options.url);
    if(options.method!=='GET'||options.headers.Cookie!==config.cookieHeader)return denied();
    if(options.url==='https://platform.claude.com/api/organizations')return reply([{uuid:'synthetic-org',capabilities:['api']}]);
    if(options.url==='https://platform.claude.com/api/organizations/synthetic-org/prepaid/credits')return reply({
      amount:12345,currency:'USD',balance:{credits:{exponent:2}},
      promo_tranches:[{program_id:'subscription_api_credit',granted_amount_minor_units:20000,remaining_amount_minor_units:12500,expires_at:'2026-12-01T00:00:00Z'}],
      tranches:[{granted_amount_minor_units:5000,remaining_amount_minor_units:2500,expires_at:'2026-12-02T00:00:00Z'}]
    });
    if(options.url==='https://platform.claude.com/api/organizations/synthetic-org/current_spend')return reply({amount:250});
    return denied();
  };
"#;

#[test]
fn claude_platform_keeps_currency_expiry_and_separate_resources_through_native_builders() {
    let result = probe("claude-platform", CLAUDE);
    assert_eq!(line(&result, "Prepaid Balance")["value"], "$123.45");
    assert_eq!(line(&result, "API Credit")["used"].as_f64(), Some(37.5));
    assert_eq!(line(&result, "API Credit")["format"]["kind"], "percent");
    assert_eq!(
        line(&result, "API Credit Remaining")["value"],
        "$125.00 / $200.00"
    );
    assert_eq!(
        line(&result, "API Credit Remaining")["subtitle"],
        "Expires 2026-12-01 (UTC)"
    );
    assert_eq!(line(&result, "This Month Spend")["subtitle"], "UTC");
    resource(&result, "API Credit", "apiCredit", None);
    resource(&result, "Purchased Credit", "purchasedCredit", None);
    assert!(line(&result, "API Credit")["resetsAt"].is_null());
    assert_eq!(result["calls"].as_array().unwrap().len(), 3);
}

const LITELLM: &str = r#"
  config.baseUrl='https://gateway.example/proxy/v1/';config.apiKey='synthetic-key';
  ctx.host.http.request=options=>{
    calls.push(options.url);
    if(options.method!=='GET'||options.headers.Authorization!=='Bearer synthetic-key')return denied();
    if(options.url==='https://gateway.example/proxy/key/info')return reply({info:{user_id:'synthetic-user',team_id:'synthetic-team',spend:1}});
    if(options.url==='https://gateway.example/proxy/user/info?user_id=synthetic-user')return reply({
      user_info:{user_id:'synthetic-user',spend:12,max_budget:100,budget_reset_at:'2026-12-01T00:00:00Z'},
      teams:[{team_id:'synthetic-team',spend:20,max_budget:200}]
    });
    return denied();
  };
"#;

#[test]
fn litellm_normalizes_real_gateway_and_keeps_personal_team_dollar_budgets_separate() {
    let result = probe("litellm", LITELLM);
    assert_eq!(
        line(&result, "Personal Budget")["used"].as_f64(),
        Some(12.0)
    );
    assert_eq!(
        line(&result, "Personal Budget")["limit"].as_f64(),
        Some(100.0)
    );
    assert_eq!(
        line(&result, "Personal Budget")["format"]["kind"],
        "dollars"
    );
    assert_eq!(
        line(&result, "Personal Budget")["resetsAt"],
        "2026-12-01T00:00:00.000Z"
    );
    assert_eq!(line(&result, "Team Budget")["used"].as_f64(), Some(20.0));
    resource(&result, "Personal Budget", "personalBudget", Some("USD"));
    resource(&result, "Team Budget", "teamBudget", Some("USD"));
    assert_eq!(result["calls"].as_array().unwrap().len(), 2);
}

const SILICON: &str = r#"
  config.region='international';config.apiKey='synthetic-key';
  ctx.host.http.request=options=>{
    calls.push(options.url);
    if(options.url!=='https://api.siliconflow.com/v1/user/info'||options.headers.Authorization!=='Bearer synthetic-key')return denied();
    return reply({code:20000,status:true,data:{totalBalance:'88.88',chargeBalance:'88.00',balance:'0.88',status:'normal',email:'private@example.invalid'}});
  };
"#;

#[test]
fn siliconflow_keeps_original_region_currency_and_uses_no_fake_quota_resource() {
    let result = probe("siliconflow", SILICON);
    assert_eq!(line(&result, "Balance")["value"], "$88.88");
    assert_eq!(line(&result, "Purchased")["value"], "$88.00");
    assert_eq!(line(&result, "Bonus")["value"], "$0.88");
    assert_eq!(line(&result, "Region")["value"], "International · USD");
    assert!(result["resources"].as_array().unwrap().is_empty());
    assert!(!result["lines"].to_string().contains("private"));
}

const WORKBUDDY: &str = r#"
  config.cookie='session=synthetic';config.userAgent='Synthetic Browser/1.0';
  ctx.host.http.request=options=>{
    calls.push(options.url);
    if(options.method!=='POST'||options.url!=='https://www.workbuddy.cn/billing/meter/get-user-resource-summary'||options.headers.Cookie!==config.cookie||options.headers['User-Agent']!==config.userAgent)return denied();
    return reply({code:0,data:{SubscriptionPackageName:'Pro',
      Packages:[{CapacityUnit:'credits',CycleTotalCapacity:'500',CycleRemainCapacity:'450',CycleFrozenCapacity:'5'}],
      CreditGroups:[{Kind:'benefit',CapacityUnit:'credits',CycleTotalCapacity:'100',CycleRemainCapacity:'90'}]
    }});
  };
"#;

#[test]
fn workbuddy_keeps_numeric_credits_and_rewards_without_double_counting() {
    let result = probe("workbuddy", WORKBUDDY);
    assert_eq!(result["plan"], "Pro");
    assert_eq!(line(&result, "Credits")["used"].as_f64(), Some(50.0));
    assert_eq!(line(&result, "Credits")["limit"].as_f64(), Some(500.0));
    assert_eq!(
        line(&result, "Credits")["format"],
        json!({"kind":"count","suffix":"credits"})
    );
    assert_eq!(line(&result, "Rewards")["used"].as_f64(), Some(10.0));
    assert_eq!(line(&result, "Reserved")["value"], "5 credits");
    resource(&result, "Credits", "credits", Some("credits"));
    assert_eq!(result["calls"].as_array().unwrap().len(), 1);
}

const TRAE: &str = r#"
  config.cookie='session=synthetic';
  ctx.host.http.request=options=>{
    calls.push(options.url);
    if(options.method!=='POST'||options.headers.Cookie!==config.cookie)return denied();
    if(options.url==='https://api.trae.cn/cloudide/api/v3/common/GetUserToken')return reply({Result:{Token:'synthetic-short-token'}});
    if(options.url!=='https://api.trae.cn/trae/api/v2/pay/user_current_entitlement_list'||options.headers.Authorization!=='Cloud-IDE-JWT synthetic-short-token')return denied();
    return reply({is_credits_billing:true,usage_summary:{total_amount:100,consumed_amount:25},user_entitlement_pack_list:[{group_type:0,status:1,display_desc:'Pro'}]});
  };
"#;

#[test]
fn trae_cn_uses_the_refresh_local_token_and_preserves_credit_counts() {
    let result = probe("trae-cn", TRAE);
    assert_eq!(result["plan"], "Pro");
    assert_eq!(line(&result, "Usage")["used"].as_f64(), Some(25.0));
    assert_eq!(line(&result, "Usage")["limit"].as_f64(), Some(100.0));
    assert_eq!(
        line(&result, "Usage")["format"],
        json!({"kind":"count","suffix":"credits"})
    );
    assert_eq!(line(&result, "Remaining")["value"], "75 credits");
    resource(&result, "Usage", "credits", Some("credits"));
    assert_eq!(result["calls"].as_array().unwrap().len(), 2);
}

const MUSE: &str = r#"
  config.accessToken='dca:synthetic';
  ctx.host.http.request=options=>{
    calls.push(options.url);
    if(options.method!=='POST'||options.url!=='https://api.meta.ai/muse-code/key'||options.headers.Authorization!=='Bearer dca:synthetic'||options.bodyText!=='{"onboard":false}')return denied();
    return reply({is_subs_active:true,subs_tier_name:'Power Usage',user_email:'private@example.invalid',api_key:'LLM|private',subs_usage:{window:{used_percent:42,resets_at:1794000000},weekly:{used_percent:18}}});
  };
"#;

#[test]
fn muse_keeps_window_durations_and_resets_without_model_key_or_identity() {
    let result = probe("muse", MUSE);
    assert_eq!(result["plan"], "Power Usage");
    assert_eq!(line(&result, "Session")["used"].as_f64(), Some(42.0));
    assert_eq!(line(&result, "Session")["format"]["kind"], "percent");
    assert_eq!(line(&result, "Session")["periodDurationMs"], 18_000_000);
    assert_eq!(
        line(&result, "Session")["resetsAt"],
        "2026-11-06T21:20:00.000Z"
    );
    assert_eq!(line(&result, "Weekly")["periodDurationMs"], 604_800_000);
    resource(&result, "Session", "session", None);
    resource(&result, "Weekly", "weekly", None);
    assert!(!result["lines"].to_string().contains("private"));
}

#[test]
fn all_six_auth_failures_reach_native_error_extraction_without_private_response_values() {
    for (id, fixture, message) in [
        ("claude-platform", CLAUDE, "session expired"),
        ("litellm", LITELLM, "invalid or expired"),
        ("siliconflow", SILICON, "invalid or lacks access"),
        ("workbuddy", WORKBUDDY, "session expired"),
        ("trae-cn", TRAE, "session expired"),
        ("muse", MUSE, "session expired"),
    ] {
        let status = if id == "litellm" { 403 } else { 401 };
        let setup = format!("{fixture}\nctx.host.http.request=options=>{{calls.push(options.url);return reply({{private:'PRIVATE_RESPONSE'}},{status})}};");
        let error = probe_result(id, &setup).unwrap_err();
        let expected = if id == "litellm" {
            "access was denied"
        } else {
            message
        };
        assert!(error.contains(expected), "{id}: {error}");
        assert!(!error.contains("PRIVATE_RESPONSE"), "{id}: {error}");
        assert!(!error.contains("synthetic"), "{id}: {error}");
    }
}

#[test]
fn optional_claude_spend_denial_preserves_native_credit_lines_and_warning() {
    let setup = format!("{CLAUDE}\nconst original=ctx.host.http.request;ctx.host.http.request=options=>options.url.endsWith('/current_spend')?reply({{private:'PRIVATE_RESPONSE'}},403):original(options);");
    let result = probe("claude-platform", &setup);
    assert_eq!(line(&result, "Prepaid Balance")["value"], "$123.45");
    assert_eq!(line(&result, "This Month Spend")["value"], "Unavailable");
    assert!(!result["logs"].as_array().unwrap().is_empty());
    assert!(!result["logs"].to_string().contains("PRIVATE_RESPONSE"));
}

#[test]
fn optional_litellm_team_denial_keeps_validated_personal_budget_and_partial_status() {
    let setup = format!("{LITELLM}\nconst original=ctx.host.http.request;ctx.host.http.request=options=>{{if(options.url.includes('/user/info'))return reply({{user_info:{{user_id:'synthetic-user',spend:12,max_budget:100}}}});if(options.url.includes('/team/info'))return reply({{private:'PRIVATE_RESPONSE'}},403);return original(options)}};");
    let result = probe("litellm", &setup);
    assert_eq!(
        line(&result, "Personal Budget")["used"].as_f64(),
        Some(12.0)
    );
    assert_eq!(
        line(&result, "Status")["value"],
        "Some Budget Data Unavailable"
    );
    assert_eq!(
        line(&result, "Status")["subtitle"],
        "Team Or Membership Data Could Not Be Verified"
    );
    assert!(!result["logs"].to_string().contains("PRIVATE_RESPONSE"));
}
