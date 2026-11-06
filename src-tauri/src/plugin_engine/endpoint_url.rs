pub(crate) fn normalize_https_base_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains('\\') || trimmed.chars().any(char::is_control) {
        return None;
    }

    let parsed = reqwest::Url::parse(trimmed).ok()?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }

    let authority = trimmed
        .split_once("://")?
        .1
        .split(|character| matches!(character, '/' | '?' | '#'))
        .next()?;
    if authority.is_empty() || authority.contains('@') {
        return None;
    }

    Some(parsed.to_string().trim_end_matches('/').to_string())
}

/// A gateway explicitly configured by the user. Cleartext is limited to local/private targets.
pub(crate) fn normalize_configured_base_url(raw: &str) -> Option<String> {
    if let Some(url) = normalize_https_base_url(raw) {
        return Some(url);
    }
    let trimmed = raw.trim();
    if trimmed.contains('\\') || trimmed.chars().any(char::is_control) {
        return None;
    }
    let url = reqwest::Url::parse(trimmed).ok()?;
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let authority = trimmed.split_once("://")?.1.split(['/', '?', '#']).next()?;
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    let host = url.host_str()?.trim_matches(['[', ']']);
    let private = match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(std::net::IpAddr::V6(ip)) => {
            ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()
        }
        Err(_) => host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local"),
    };
    private.then(|| url.to_string().trim_end_matches('/').to_string())
}

#[cfg(test)]
mod tests {
    use super::normalize_https_base_url;

    #[test]
    fn configured_gateways_require_https_or_an_explicit_private_http_origin() {
        for url in [
            "http://localhost:4000/v1",
            "http://127.0.0.1:4000",
            "http://192.168.1.8:4000",
            "http://[::1]:4000",
            "http://[fd00::1]:4000",
            "http://proxy.local:4000",
            "https://proxy.example/v1",
        ] {
            assert!(super::normalize_configured_base_url(url).is_some(), "{url}");
        }
        for url in [
            "http://proxy.example",
            "http://8.8.8.8",
            "http://user:secret@localhost",
            "http://@localhost",
            "http://localhost?key=secret",
            "http://localhost#fragment",
            "file:///tmp/key",
            "http://localhost\\@public.example",
        ] {
            assert!(super::normalize_configured_base_url(url).is_none(), "{url}");
        }
    }

    #[test]
    fn normalizes_only_unambiguous_https_base_urls() {
        let valid = [
            (
                " https://OpenRouter.ai/api/v1/// ",
                "https://openrouter.ai/api/v1",
            ),
            (
                "https://gateway.example:8443/openrouter/v1/",
                "https://gateway.example:8443/openrouter/v1",
            ),
            (
                "HTTPS://gateway.example/api/v1",
                "https://gateway.example/api/v1",
            ),
            ("https://[::1]:8443/v1/", "https://[::1]:8443/v1"),
        ];
        for (raw, expected) in valid {
            assert_eq!(
                normalize_https_base_url(raw).as_deref(),
                Some(expected),
                "expected a valid base URL for {raw:?}"
            );
        }

        let invalid = [
            "https://openrouter.ai@attacker.example/api/v1",
            "https://user:password@example.com/api/v1",
            "https://@example.com/api/v1",
            "http://openrouter.ai/api/v1",
            "https://openrouter.ai/api/v1?route=credits",
            "https://openrouter.ai/api/v1?",
            "https://openrouter.ai/api/v1#credits",
            "https://openrouter.ai/api/v1#",
            "https://openrouter.ai\\@attacker.example/api/v1",
            "https://openrouter.ai/\napi/v1",
            "https:///api/v1",
            "https://openrouter.ai:not-a-port/api/v1",
        ];
        for raw in invalid {
            assert_eq!(
                normalize_https_base_url(raw),
                None,
                "expected an invalid base URL for {raw:?}"
            );
        }
    }
}
