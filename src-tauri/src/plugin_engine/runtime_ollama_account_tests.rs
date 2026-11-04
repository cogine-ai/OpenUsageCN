use rquickjs::{Context, Runtime};
use serde_json::Value;

fn execute(setup: &str, entry: &str) -> Value {
    let plugin = super::super::manifest::load_plugins_from_dir(
        &std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins"),
    )
    .into_iter()
    .find(|p| p.manifest.id == "ollama")
    .unwrap();
    let runtime = Runtime::new().unwrap();
    let context = Context::full(&runtime).unwrap();
    context.with(|vm| {
        vm.globals().set("hash", rquickjs::Function::new(vm.clone(), |s: String| crate::safe_file::sha256_hex(s.as_bytes())).unwrap()).unwrap();
        vm.eval::<(), _>(r#"
          const calls=[],logs=[],config={source:'apiKey',apiKey:'synthetic-managed-key'};
          const denied=()=>{throw 'Unexpected host operation';};
          const ctx={nowIso:'2026-11-04T00:00:00Z',host:{config:{get:k=>config[k]},env:{get:denied},crypto:{sha256Hex:hash},
            log:{info:s=>logs.push(s),warn:s=>logs.push(s),error:s=>logs.push(s)}},
            util:{request:denied},fmt:{planLabel:s=>s},line:{progress:o=>({type:'progress',...o}),text:o=>({type:'text',...o}),barChart:o=>({type:'barChart',...o})}};
          const reply=(body,status=200)=>({status,bodyText:JSON.stringify(body)});
          const user={Id:'synthetic-user-one',Name:'Synthetic User',Email:'synthetic@example.invalid',Plan:'pro'};
          const balance={included:{allowance_usd:100,balance_usd:76,period:{from:'2026-11-01T00:00:00Z',until:'2026-12-01T00:00:00Z'}},purchased:{balance_usd:20}};
        "#).unwrap();
        vm.eval::<(), _>(plugin.entry_script.as_bytes()).unwrap();
        vm.eval::<(), _>(setup).unwrap();
        let code = format!(r#"(()=>{{try{{return JSON.stringify({{output:{entry},calls,logs}})}}catch(error){{return JSON.stringify({{error:typeof error==='string'?error:JSON.stringify(error),calls,logs}})}}}})()"#);
        let encoded: String = vm.eval(code).unwrap();
        serde_json::from_str(&encoded).unwrap()
    })
}

const VALID: &str = r#"
ctx.util.request=options=>{
  calls.push({url:options.url,method:options.method,timeout:options.timeoutMs});
  if(options.headers.Authorization!=='Bearer synthetic-managed-key')return denied();
  if(options.url.endsWith('/api/me'))return reply(user);
  if(options.url.endsWith('/api/balance'))return reply(balance);
  return denied();
};
"#;

#[test]
fn managed_probe_checks_id_before_and_after_balance_with_only_the_selected_key() {
    let result = execute(VALID, "__openusage_ollama_account(ctx)");
    assert!(result.get("error").is_none(), "{result}");
    let calls = result["calls"].as_array().unwrap();
    assert_eq!(calls.len(), 3);
    assert!(calls[0]["url"].as_str().unwrap().ends_with("/api/me"));
    assert_eq!(calls[0]["method"], "POST");
    assert!(calls[1]["url"].as_str().unwrap().ends_with("/api/balance"));
    assert!(calls[2]["url"].as_str().unwrap().ends_with("/api/me"));
    assert_eq!(
        result["output"]["identity"]["fingerprint"],
        crate::safe_file::sha256_hex(br#"["ollama-user","synthetic-user-one"]"#)
    );
    assert_eq!(result["output"]["lines"][0]["used"], 24);
    assert_eq!(
        result["output"]["identity"]["email"],
        "synthetic@example.invalid"
    );
    assert_eq!(result["output"]["plan"], "pro");
}

#[test]
fn identity_changed_during_balance_discards_the_whole_result() {
    let setup = format!(
        "{VALID}\nconst request=ctx.util.request;let identityCalls=0;ctx.util.request=options=>{{if(options.url.endsWith('/api/me')&&++identityCalls===2){{calls.push({{url:options.url}});return reply({{...user,Id:'different-user'}})}}return request(options)}};"
    );
    let result = execute(&setup, "__openusage_ollama_account(ctx)");
    assert!(
        result["error"]
            .as_str()
            .unwrap()
            .contains("identityChanged")
    );
    assert!(result.get("output").is_none());
    assert!(!result["logs"].to_string().contains("different-user"));
    assert!(!result["logs"].to_string().contains("synthetic-managed-key"));
}

#[test]
fn missing_stable_id_does_not_fall_back_to_a_display_name_or_email() {
    let setup = format!("{VALID}\ndelete user.Id;");
    let result = execute(&setup, "__openusage_ollama_account(ctx)");
    assert!(
        result["error"]
            .as_str()
            .unwrap()
            .contains("identity is unavailable")
    );
    assert_eq!(result["calls"].as_array().unwrap().len(), 1);
}

#[test]
fn api_rejection_is_classified_and_never_tries_another_source() {
    for (status, code) in [
        (401, "authExpired"),
        (403, "permissionDenied"),
        (429, "rateLimited"),
    ] {
        let setup = format!(
            "ctx.util.request=options=>{{calls.push(options.url);return reply({{private:'synthetic-private'}},{status})}};"
        );
        let result = execute(&setup, "__openusage_ollama_account(ctx)");
        assert!(result["error"].as_str().unwrap().contains(code));
        assert_eq!(result["calls"].as_array().unwrap().len(), 1);
        assert!(
            !result["error"]
                .as_str()
                .unwrap()
                .contains("synthetic-private")
        );
    }
}

#[test]
fn managed_reports_refuse_a_different_stable_user_before_fetching_usage() {
    let setup = format!("{VALID}\nconfig.managedAccountFingerprint='wrong-account';");
    let result = execute(&setup, "__openusage_ollama_reports(ctx)");
    assert!(
        result["error"]
            .as_str()
            .unwrap()
            .contains("identity changed")
    );
    assert_eq!(result["calls"].as_array().unwrap().len(), 1);
}

#[test]
fn known_different_identity_clears_scope_before_a_denied_balance_can_hide_it() {
    let setup = format!(
        "{VALID}\nconfig.managedAccountFingerprint='different-saved-account';const request=ctx.util.request;ctx.util.request=options=>options.url.endsWith('/api/balance')?reply({{}},403):request(options);"
    );
    let result = execute(&setup, "__openusage_ollama_account(ctx)");
    assert!(
        result["error"]
            .as_str()
            .unwrap()
            .contains("identityChanged")
    );
    assert_eq!(result["calls"].as_array().unwrap().len(), 1);
    assert!(
        result["calls"][0]["url"]
            .as_str()
            .unwrap()
            .ends_with("/api/me")
    );
}
