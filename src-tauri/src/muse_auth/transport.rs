use super::*;
use std::io::Read;
pub(super) struct Reply {
    pub status: u16,
    pub body: String,
}
impl Reply {
    pub fn json(&self) -> Result<Value, String> {
        serde_json::from_str(&self.body).map_err(|_| invalid())
    }
}
pub(super) trait Http {
    fn request(
        &self,
        url: &str,
        form: &[(&str, &str)],
        token: Option<&str>,
    ) -> Result<Reply, String>;
}
pub(super) struct Client;
impl Http for Client {
    fn request(
        &self,
        url: &str,
        form: &[(&str, &str)],
        token: Option<&str>,
    ) -> Result<Reply, String> {
        let client = crate::config::blocking_client_builder()
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "无法建立授权连接。")?;
        let mut request = client.post(url);
        if let Some(token) = token {
            request = request
                .bearer_auth(token)
                .header("x-api-version", "1.0.0")
                .header("content-type", "application/json")
                .body(r#"{"onboard":false}"#);
        } else {
            let mut encoded = reqwest::Url::parse("https://auth.meta.com").expect("fixed auth URL");
            encoded.query_pairs_mut().extend_pairs(form.iter().copied());
            request = request
                .header("content-type", "application/x-www-form-urlencoded")
                .body(encoded.query().unwrap_or_default().to_string());
        }
        let response = request.send().map_err(|_| {
            log::warn!("Muse device authorization network request failed");
            "授权连接失败，请检查网络后重试。"
        })?;
        let status = response.status().as_u16();
        let mut body = String::new();
        response
            .take(1_048_577)
            .read_to_string(&mut body)
            .map_err(|_| "无法读取授权响应，请重试。")?;
        if body.len() > 1_048_576 {
            return Err(invalid());
        }
        if status >= 400 {
            log::warn!("Muse device authorization returned HTTP {status}");
        }
        Ok(Reply { status, body })
    }
}
