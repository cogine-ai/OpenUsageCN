const COMMON_CORS_HEADERS: &str = "\
Access-Control-Allow-Methods: GET, OPTIONS\r\n\
Access-Control-Allow-Headers: Content-Type";

pub(super) fn cors_headers(origin: Option<&str>) -> String {
    match allowed_origin(origin) {
        Some(origin) => format!(
            "Access-Control-Allow-Origin: {}\r\nVary: Origin\r\n{}",
            origin, COMMON_CORS_HEADERS
        ),
        None => COMMON_CORS_HEADERS.to_string(),
    }
}

fn allowed_origin(origin: Option<&str>) -> Option<String> {
    let origin = origin?.trim().trim_end_matches('/');
    if origin.is_empty() || origin.contains('\r') || origin.contains('\n') {
        return None;
    }

    let normalized = origin.to_ascii_lowercase();
    if normalized == "tauri://localhost" {
        return Some(origin.to_string());
    }

    let authority = normalized
        .strip_prefix("http://")
        .or_else(|| normalized.strip_prefix("https://"))?;
    if authority.contains('/') || authority.contains('@') {
        return None;
    }

    let host = authority_host(authority)?;
    if matches!(
        host,
        "127.0.0.1" | "localhost" | "tauri.localhost" | "[::1]"
    ) {
        Some(origin.to_string())
    } else {
        None
    }
}

fn authority_host(authority: &str) -> Option<&str> {
    if authority.starts_with('[') {
        let closing = authority.find(']')?;
        let host = &authority[..=closing];
        let rest = &authority[(closing + 1)..];
        if rest.is_empty() || valid_port(rest.strip_prefix(':')?) {
            return Some(host);
        }
        return None;
    }

    let host = match authority.split_once(':') {
        Some((host, port)) => {
            if !valid_port(port) {
                return None;
            }
            host
        }
        None => authority,
    };
    if host.is_empty() {
        return None;
    }
    Some(host.trim_end_matches('.'))
}

fn valid_port(port: &str) -> bool {
    !port.is_empty() && port.chars().all(|c| c.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cors_headers_reflect_loopback_origins() {
        let headers = cors_headers(Some("http://localhost:3000"));

        assert!(headers.contains("Access-Control-Allow-Origin: http://localhost:3000"));
        assert!(headers.contains("Vary: Origin"));
        assert!(headers.contains("Access-Control-Allow-Methods: GET, OPTIONS"));
    }

    #[test]
    fn cors_headers_reflect_ipv6_loopback_origins() {
        let headers = cors_headers(Some("http://[::1]:3000"));

        assert!(headers.contains("Access-Control-Allow-Origin: http://[::1]:3000"));
    }

    #[test]
    fn cors_headers_reflect_tauri_app_origins() {
        let headers = cors_headers(Some("tauri://localhost"));

        assert!(headers.contains("Access-Control-Allow-Origin: tauri://localhost"));
    }

    #[test]
    fn cors_headers_omit_origin_for_public_origins() {
        let headers = cors_headers(Some("https://evil.example"));

        assert!(!headers.contains("Access-Control-Allow-Origin"));
        assert!(headers.contains("Access-Control-Allow-Methods: GET, OPTIONS"));
    }

    #[test]
    fn cors_headers_omit_origin_when_origin_is_absent() {
        let headers = cors_headers(None);

        assert!(!headers.contains("Access-Control-Allow-Origin"));
    }

    #[test]
    fn cors_headers_omit_origin_for_crlf_injection_attempts() {
        let headers = cors_headers(Some("http://localhost\r\nInjected: yes"));

        assert!(!headers.contains("Access-Control-Allow-Origin"));
    }

    #[test]
    fn cors_headers_omit_origin_for_invalid_ports() {
        let headers = cors_headers(Some("http://localhost:abc"));

        assert!(!headers.contains("Access-Control-Allow-Origin"));
    }

    #[test]
    fn cors_headers_omit_origin_for_credentials_in_authority() {
        let headers = cors_headers(Some("http://user@localhost:3000"));

        assert!(!headers.contains("Access-Control-Allow-Origin"));
    }

    #[test]
    fn cors_headers_reflect_tauri_localhost_origins() {
        let headers = cors_headers(Some("http://tauri.localhost:1420"));

        assert!(headers.contains("Access-Control-Allow-Origin: http://tauri.localhost:1420"));
    }
}
