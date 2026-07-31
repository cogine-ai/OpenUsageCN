use super::*;
use rquickjs::{Context, Function, Object, Runtime};
use serial_test::serial;
use std::ffi::OsString;
use std::io::{ErrorKind, Read, Write};
use std::net::TcpListener;
use std::thread;
use std::time::{Duration, Instant};

struct EnvVarGuard {
    name: &'static str,
    old: Option<OsString>,
}

impl EnvVarGuard {
    fn set(name: &'static str, value: &str) -> Self {
        let old = std::env::var_os(name);
        // SAFETY: this serial test restores every changed variable before returning.
        unsafe { std::env::set_var(name, value) };
        Self { name, old }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        if let Some(value) = self.old.take() {
            // SAFETY: this restores the process environment captured by the guard.
            unsafe { std::env::set_var(self.name, value) };
        } else {
            // SAFETY: the variable was absent before this serial test.
            unsafe { std::env::remove_var(self.name) };
        }
    }
}

#[test]
#[serial]
fn plugin_http_request_inherits_environment_proxy_without_manual_proxy() {
    assert!(
        crate::config::get_resolved_proxy().is_none(),
        "proxy inheritance test requires no manual OpenUsageCN proxy"
    );

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind proxy listener");
    listener
        .set_nonblocking(true)
        .expect("set proxy listener nonblocking");
    let proxy_url = format!("http://{}", listener.local_addr().expect("proxy address"));
    let server = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        let (mut stream, _) = loop {
            match listener.accept() {
                Ok(connection) => break connection,
                Err(error)
                    if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("accept proxy request: {error}"),
            }
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("set proxy read timeout");
        let mut request = [0_u8; 4096];
        let bytes_read = stream.read(&mut request).expect("read proxy request");
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .expect("write proxy response");
        String::from_utf8_lossy(&request[..bytes_read]).into_owned()
    });

    let _env = [
        EnvVarGuard::set("HTTP_PROXY", &proxy_url),
        EnvVarGuard::set("http_proxy", &proxy_url),
        EnvVarGuard::set("ALL_PROXY", &proxy_url),
        EnvVarGuard::set("all_proxy", &proxy_url),
        EnvVarGuard::set("NO_PROXY", ""),
        EnvVarGuard::set("no_proxy", ""),
    ];

    let runtime = Runtime::new().expect("runtime");
    let context = Context::full(&runtime).expect("context");
    let response = context.with(|ctx| -> rquickjs::Result<String> {
        inject_host_api(
            &ctx,
            "test",
            &std::env::temp_dir(),
            env!("CARGO_PKG_VERSION"),
        )?;
        let probe_ctx: Object = ctx.globals().get("__openusage_ctx")?;
        let host: Object = probe_ctx.get("host")?;
        let http: Object = host.get("http")?;
        let request_raw: Function = http.get("_requestRaw")?;
        request_raw.call((
            r#"{"url":"http://example.invalid/proxy-regression","timeoutMs":2000}"#.to_string(),
        ))
    });

    let proxy_request = server.join().expect("proxy server");
    let response: serde_json::Value =
        serde_json::from_str(&response.expect("proxied request")).expect("response JSON");

    assert_eq!(response["status"], 200);
    assert_eq!(response["bodyText"], "ok");
    assert!(
        proxy_request.starts_with("GET http://example.invalid/proxy-regression HTTP/1.1"),
        "unexpected proxy request: {proxy_request}"
    );
}

#[test]
#[serial]
fn plugin_http_request_bypasses_environment_proxy_for_loopback() {
    assert!(
        crate::config::get_resolved_proxy().is_none(),
        "proxy bypass test requires no manual OpenUsageCN proxy"
    );

    let target = TcpListener::bind("127.0.0.1:0").expect("bind loopback target");
    let target_addr = target.local_addr().expect("target address");
    let target_url = format!("http://{target_addr}/local-ls");
    let target_server = thread::spawn(move || {
        let (mut stream, _) = target.accept().expect("accept loopback request");
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("set target read timeout");
        let mut request = [0_u8; 4096];
        let bytes_read = stream.read(&mut request).expect("read loopback request");
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\ndirect",
            )
            .expect("write loopback response");
        String::from_utf8_lossy(&request[..bytes_read]).into_owned()
    });

    let proxy = TcpListener::bind("127.0.0.1:0").expect("bind proxy listener");
    proxy
        .set_nonblocking(true)
        .expect("set proxy listener nonblocking");
    let proxy_url = format!("http://{}", proxy.local_addr().expect("proxy address"));
    let proxy_server = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_millis(400);
        loop {
            match proxy.accept() {
                Ok(_) => return true,
                Err(error)
                    if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => return false,
                Err(error) => panic!("accept proxy request: {error}"),
            }
        }
    });

    let _env = [
        EnvVarGuard::set("HTTP_PROXY", &proxy_url),
        EnvVarGuard::set("http_proxy", &proxy_url),
        EnvVarGuard::set("HTTPS_PROXY", &proxy_url),
        EnvVarGuard::set("https_proxy", &proxy_url),
        EnvVarGuard::set("ALL_PROXY", &proxy_url),
        EnvVarGuard::set("all_proxy", &proxy_url),
        EnvVarGuard::set("NO_PROXY", ""),
        EnvVarGuard::set("no_proxy", ""),
    ];

    let runtime = Runtime::new().expect("runtime");
    let context = Context::full(&runtime).expect("context");
    let response = context.with(|ctx| -> rquickjs::Result<String> {
        inject_host_api(
            &ctx,
            "test",
            &std::env::temp_dir(),
            env!("CARGO_PKG_VERSION"),
        )?;
        let probe_ctx: Object = ctx.globals().get("__openusage_ctx")?;
        let host: Object = probe_ctx.get("host")?;
        let http: Object = host.get("http")?;
        let request_raw: Function = http.get("_requestRaw")?;
        let payload = format!(
            r#"{{"url":"{target_url}","timeoutMs":2000,"headers":{{"x-codeium-csrf-token":"secret-csrf"}}}}"#
        );
        request_raw.call((payload,))
    });

    let target_request = target_server.join().expect("loopback server");
    let proxy_was_hit = proxy_server.join().expect("proxy server");
    let response: serde_json::Value =
        serde_json::from_str(&response.expect("direct loopback request")).expect("response JSON");

    assert_eq!(response["status"], 200);
    assert_eq!(response["bodyText"], "direct");
    assert!(
        target_request.starts_with("GET /local-ls HTTP/1.1"),
        "unexpected loopback request: {target_request}"
    );
    assert!(
        target_request.contains("x-codeium-csrf-token: secret-csrf"),
        "csrf header missing on direct loopback request: {target_request}"
    );
    assert!(
        !proxy_was_hit,
        "loopback request must not traverse HTTP_PROXY when NO_PROXY is empty"
    );
}
