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

#[cfg(test)]
mod tests {
    use super::normalize_https_base_url;

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
