use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// Open an http(s) URL in the system default browser. Used by the plugin
/// connector OAuth flow (the authorize page must run in a real browser, not
/// the app webview). Scheme allowlist keeps arbitrary local schemes
/// (file://, custom protocols) out of reach of the webview.
#[tauri::command]
pub fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("invalid_external_url".to_string());
    }
    app.opener()
        .open_url(trimmed, None::<&str>)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn external_url_scheme_allowlist_rejects_non_http() {
        // The command needs an AppHandle, so test the guard logic inline.
        for url in ["file:///etc/passwd", "javascript:alert(1)", "ftp://x", ""] {
            let trimmed = url.trim();
            assert!(
                !(trimmed.starts_with("https://") || trimmed.starts_with("http://")),
                "{url} should be rejected"
            );
        }
        assert!("https://example.com/auth".starts_with("https://"));
    }
}
