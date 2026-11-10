use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tapd_core::{
    bridge::{BridgeHttpResult, BridgePing, CapturedRequest},
    tapd::{
        api::{
            bug_detail_body, bug_detail_url, bug_list_url, parse_bug_detail, parse_bug_list,
            parse_workspaces, user_workspace_url, BugQuery,
        },
        changes_list_url, parse_changes_html, BugDetail, BugListPage, ChangeHistory, Workspace,
    },
};

use crate::{
    session,
    state::{SharedState},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    nick: String,
    user_id: String,
    company: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContext {
    user: UserProfile,
    workspaces: Vec<Workspace>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    paths: tapd_core::paths::AppPaths,
    logged_in: bool,
    me: Option<String>,
    last_workspace_id: Option<String>,
    poll_interval_secs: u64,
    runtime_port: Option<u16>,
    session_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    exists: bool,
    visible: bool,
    url: Option<String>,
    logged_in: bool,
}

#[tauri::command]
pub fn app_info(state: State<'_, SharedState>) -> AppInfo {
    let config = state.config_snapshot();
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        paths: state.paths.clone(),
        logged_in: config.logged_in,
        me: config.me,
        last_workspace_id: config.last_workspace_id,
        poll_interval_secs: config.poll_interval_secs,
        runtime_port: state.runtime_info().map(|runtime| runtime.port),
        session_url: config.last_session_url,
    }
}

#[tauri::command]
pub fn session_status(app: AppHandle, state: State<'_, SharedState>) -> SessionStatus {
    let window = app.get_webview_window(session::SESSION_LABEL);
    let (exists, visible, url) = match window {
        Some(window) => (
            true,
            window.is_visible().unwrap_or(false),
            window.url().ok().map(|url| url.to_string()),
        ),
        None => (false, false, None),
    };

    SessionStatus {
        exists,
        visible,
        url,
        logged_in: state.config.lock().expect("config lock").logged_in,
    }
}

#[tauri::command]
pub fn session_show(app: AppHandle, state: State<'_, SharedState>) -> Result<(), String> {
    let window = session::ensure_session_window(&app, state.inner(), true)?;
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
pub fn session_hide(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(session::SESSION_LABEL) {
        let _ = window.hide();
    }
    Ok(())
}

#[tauri::command]
pub fn session_mark_logged_in(
    app: AppHandle,
    state: State<'_, SharedState>,
    nick: Option<String>,
) -> Result<(), String> {
    let snapshot = {
        let mut config = state.config.lock().expect("config lock");
        config.logged_in = true;
        if let Some(nick) = nick {
            let trimmed = nick.trim();
            if !trimmed.is_empty() {
                config.me = Some(trimmed.to_string());
            }
        }
        config.clone()
    };

    state.save_config(&snapshot).map_err(|error| error.to_string())?;

    if let Some(window) = app.get_webview_window(session::SESSION_LABEL) {
        let _ = window.hide();
    }
    let _ = app.emit("session://changed", ());
    Ok(())
}

#[tauri::command]
pub fn session_logout(app: AppHandle, state: State<'_, SharedState>) -> Result<(), String> {
    let snapshot = {
        let mut config = state.config.lock().expect("config lock");
        config.logged_in = false;
        config.me = None;
        config.last_session_url = None;
        config.clone()
    };
    state.save_config(&snapshot).map_err(|error| error.to_string())?;

    if let Some(window) = app.get_webview_window(session::SESSION_LABEL) {
        // Drop cookies and local storage, then reload the login entry point.
        let _ = window.clear_all_browsing_data();
        if let Ok(url) = tauri::Url::parse(session::TAPD_HOME) {
            let _ = window.navigate(url);
        }
        let _ = window.show();
        let _ = window.set_focus();
    }

    let _ = app.emit("session://changed", ());
    Ok(())
}

#[tauri::command]
pub async fn session_ping(
    app: AppHandle,
    _state: State<'_, SharedState>,
) -> Result<BridgePing, String> {
    let window = app
        .get_webview_window(session::SESSION_LABEL)
        .ok_or_else(|| "会话窗口尚未创建，请先打开登录窗口".to_string())?;

    let value = session::eval_sync_json(
        &window,
        "window.__TAPDCB__.ping()",
        Duration::from_secs(8),
    )
    .await?;

    serde_json::from_value(value)
        .map_err(|error| format!("unexpected ping payload: {error}"))
}

#[tauri::command]
pub async fn session_http(
    app: AppHandle,
    _state: State<'_, SharedState>,
    method: String,
    url: String,
    body: Option<String>,
    headers: Option<serde_json::Value>,
) -> Result<BridgeHttpResult, String> {
    let window = app
        .get_webview_window(session::SESSION_LABEL)
        .ok_or_else(|| "会话窗口尚未创建，请先打开登录窗口".to_string())?;

    let payload = serde_json::json!({
        "method": method,
        "url": url,
        "body": body,
        "headers": headers.unwrap_or_else(|| serde_json::json!({})),
    });
    let expression = format!("window.__TAPDCB__.request({payload})");

    let value = session::eval_async_json(&window, &expression, Duration::from_secs(30)).await?;

    serde_json::from_value(value)
        .map_err(|error| format!("unexpected HTTP bridge payload: {error}"))
}

#[tauri::command]
pub async fn workspace_context(
    app: AppHandle,
    _state: State<'_, SharedState>,
) -> Result<WorkspaceContext, String> {
    let root = session_request_json(
        &app,
        "GET",
        &user_workspace_url("0"),
        None,
        Duration::from_secs(30),
    )
    .await?;

    let user_data = root
        .pointer("/data/get_current_user_ret/data")
        .ok_or_else(|| "unexpected identity response".to_string())?;
    let user = UserProfile {
        nick: string_field(user_data, "user_nick"),
        user_id: string_field(user_data, "user_id"),
        company: string_field(user_data, "company"),
    };
    let workspaces = parse_workspaces(&root)?;

    Ok(WorkspaceContext { user, workspaces })
}

#[tauri::command]
pub async fn bug_list(
    app: AppHandle,
    query: BugQuery,
) -> Result<BugListPage, String> {
    let body = query.body();
    let root = session_request_json(
        &app,
        "POST",
        &bug_list_url(),
        Some(body),
        Duration::from_secs(45),
    )
    .await?;

    parse_bug_list(&root)
}

#[tauri::command]
pub async fn bug_detail(
    app: AppHandle,
    workspace_id: String,
    bug_id: String,
) -> Result<BugDetail, String> {
    fetch_bug_detail(&app, &workspace_id, &bug_id).await
}

/// Loads a bug together with its change history.
///
/// The history lives in a legacy HTML page, so a failure there only degrades
/// that section instead of failing the whole detail.
pub(crate) async fn fetch_bug_detail(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
) -> Result<BugDetail, String> {
    let body = bug_detail_body(workspace_id, bug_id);
    let url = bug_detail_url();
    let detail_future = session_request_json(
        app,
        "POST",
        &url,
        Some(body),
        Duration::from_secs(45),
    );
    let changes_future = fetch_change_history(app, workspace_id, bug_id);

    let (root, changes) = tokio::join!(detail_future, changes_future);
    let mut detail = parse_bug_detail(&root?)?;
    detail.changes = changes.unwrap_or_else(|error| ChangeHistory {
        error: Some(error),
        ..ChangeHistory::default()
    });

    Ok(detail)
}

/// The legacy page returns at most one page of changes per request.
const MAX_CHANGE_PAGES: u32 = 10;

pub(crate) async fn fetch_change_history(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
) -> Result<ChangeHistory, String> {
    let mut history = ChangeHistory::default();
    let mut previous_first_seq: Option<u32> = None;

    for page in 1..=MAX_CHANGE_PAGES {
        let http = session_request_text(
            app,
            "GET",
            &changes_list_url(workspace_id, bug_id, page),
            None,
            Duration::from_secs(30),
        )
        .await?;
        let parsed = parse_changes_html(&http.body)?;

        if page == 1 {
            history.total = parsed.total;
        }
        let Some(first_seq) = parsed.changes.first().map(|change| change.seq) else {
            break;
        };
        // Guard against the server ignoring `page` and repeating the first page.
        if page > 1 && previous_first_seq == Some(first_seq) {
            break;
        }
        previous_first_seq = Some(first_seq);

        for change in parsed.changes {
            if history
                .changes
                .iter()
                .any(|existing| existing.seq == change.seq)
            {
                continue;
            }
            history.changes.push(change);
        }

        if history.changes.len() as u32 >= history.total {
            break;
        }
    }

    if history.total < history.changes.len() as u32 {
        history.total = history.changes.len() as u32;
    }

    Ok(history)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigInfo {
    command_path: String,
    snippet: String,
    transport: String,
    read_only: bool,
    tools: Vec<&'static str>,
    port: Option<u16>,
}

#[tauri::command]
pub fn mcp_config(state: State<'_, SharedState>) -> McpConfigInfo {
    let command_path = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("tapd-mcp")))
        .filter(|path| path.exists())
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| "tapd-mcp".to_string());

    let snippet = serde_json::to_string_pretty(&serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "mcp": {
            "servers": {
                "tapd": {
                    "type": "local",
                    "command": [command_path.clone()]
                }
            }
        }
    }))
    .unwrap_or_default();

    McpConfigInfo {
        command_path,
        snippet,
        transport: "stdio".to_string(),
        read_only: true,
        tools: vec![
            "tapd_whoami",
            "tapd_list_projects",
            "tapd_list_bugs",
            "tapd_list_my_bugs",
            "tapd_get_bug",
            "tapd_export_bug_md",
        ],
        port: state.runtime_info().map(|runtime| runtime.port),
    }
}

#[tauri::command]
pub fn set_current_user(
    state: State<'_, SharedState>,
    nick: String,
) -> Result<(), String> {
    let snapshot = {
        let mut config = state.config.lock().expect("config lock");
        let trimmed = nick.trim();
        if !trimmed.is_empty() {
            config.me = Some(trimmed.to_string());
        }
        config.clone()
    };
    state.save_config(&snapshot).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_last_workspace(
    state: State<'_, SharedState>,
    workspace_id: String,
) -> Result<(), String> {
    let snapshot = {
        let mut config = state.config.lock().expect("config lock");
        config.last_workspace_id = Some(workspace_id);
        config.clone()
    };
    state.save_config(&snapshot).map_err(|error| error.to_string())
}

pub(crate) async fn session_request_json(
    app: &AppHandle,
    method: &str,
    url: &str,
    body: Option<Value>,
    timeout: Duration,
) -> Result<Value, String> {
    let http = session_request_text(app, method, url, body, timeout).await?;

    serde_json::from_str(&http.body)
        .map_err(|error| format!("invalid TAPD JSON response: {error}"))
}

/// Same as [`session_request_json`] but returns the raw body, for the legacy
/// pages TAPD renders as HTML.
pub(crate) async fn session_request_text(
    app: &AppHandle,
    method: &str,
    url: &str,
    body: Option<Value>,
    timeout: Duration,
) -> Result<BridgeHttpResult, String> {
    let window = app
        .get_webview_window(session::SESSION_LABEL)
        .ok_or_else(|| "会话窗口尚未创建，请先打开登录窗口".to_string())?;

    let payload = serde_json::json!({
        "method": method,
        "url": url,
        "body": body.map(|body| body.to_string()),
    });
    let expression = format!("window.__TAPDCB__.request({payload})");
    let value = session::eval_async_json(&window, &expression, timeout).await?;
    let http: BridgeHttpResult = serde_json::from_value(value)
        .map_err(|error| format!("unexpected bridge payload: {error}"))?;

    if !http.ok {
        let preview: String = http.body.chars().take(240).collect();
        return Err(format!(
            "TAPD 请求失败（HTTP {}）：{}",
            http.status, preview
        ));
    }

    Ok(http)
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

#[tauri::command]
pub async fn capture_snapshot(app: AppHandle) -> Result<Vec<CapturedRequest>, String> {
    snapshot_captures(&app).await
}

#[tauri::command]
pub async fn capture_clear(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(session::SESSION_LABEL) else {
        return Ok(());
    };
    session::eval_sync_json(&window, "window.__TAPDCB__.clear()", Duration::from_secs(8))
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn capture_export(
    app: AppHandle,
    state: State<'_, SharedState>,
) -> Result<String, String> {
    let captures = snapshot_captures(&app).await?;
    let names = format!(
        "capture-{}-{}.json",
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        captures.len()
    );
    let path = state.paths.captures_dir.join(names);
    let raw = serde_json::to_vec_pretty(&captures).map_err(|error| error.to_string())?;
    std::fs::write(&path, raw).map_err(|error| error.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }

    let display_path = path.to_string_lossy().to_string();
    tracing::info!(path = %display_path, count = captures.len(), "capture exported");
    Ok(display_path)
}

async fn snapshot_captures(app: &AppHandle) -> Result<Vec<CapturedRequest>, String> {
    let Some(window) = app.get_webview_window(session::SESSION_LABEL) else {
        return Ok(Vec::new());
    };

    let value = session::eval_sync_json(
        &window,
        "window.__TAPDCB__.snapshot()",
        Duration::from_secs(15),
    )
    .await?;

    serde_json::from_value(value)
        .map_err(|error| format!("unexpected capture payload: {error}"))
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

const MEDIA_PREVIEW_LIMIT: u64 = 12 * 1024 * 1024;
const MEDIA_USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

/// Downloads a TAPD-hosted image with the session cookies and returns it as a
/// `data:` URL, so the main window can show a thumbnail without having the
/// tapd.cn cookies itself (cross-site image loads are blocked by SameSite).
#[tauri::command]
pub async fn media_preview(app: AppHandle, url: String) -> Result<String, String> {
    if !is_tapd_media_url(&url) {
        return Err("只支持 TAPD 站内资源地址".to_string());
    }

    let window = app
        .get_webview_window(session::SESSION_LABEL)
        .ok_or_else(|| "会话窗口尚未创建".to_string())?;
    let cookie = session::cookie_header(&window)?;

    let response = reqwest::Client::builder()
        .user_agent(MEDIA_USER_AGENT)
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| error.to_string())?
        .get(&url)
        .header(reqwest::header::COOKIE, cookie)
        .header(reqwest::header::REFERER, "https://www.tapd.cn/")
        .send()
        .await
        .map_err(|error| error.to_string())?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    // TAPD often replies with a bare `image` instead of `image/png`.
    if !content_type.starts_with("image") {
        return Err(format!("不是图片（{content_type}）"));
    }
    if response.content_length().unwrap_or(0) > MEDIA_PREVIEW_LIMIT {
        return Err("图片超过 12MB，已跳过预览".to_string());
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MEDIA_PREVIEW_LIMIT {
        return Err("图片超过 12MB，已跳过预览".to_string());
    }

    let mime = if content_type.contains('/') {
        content_type
    } else {
        sniff_image_mime(&bytes).to_string()
    };

    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

/// Minimal magic-number sniffing for the formats TAPD stores.
fn sniff_image_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return "image/png";
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return "image/jpeg";
    }
    if bytes.starts_with(b"GIF8") {
        return "image/gif";
    }
    if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return "image/webp";
    }
    if bytes.starts_with(b"BM") {
        return "image/bmp";
    }
    "image/png"
}

fn is_tapd_media_url(url: &str) -> bool {
    ["https://www.tapd.cn/", "https://file.tapd.cn/", "https://tdl.tapd.cn/"]
        .iter()
        .any(|prefix| url.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_image_mime_from_magic_bytes() {
        assert_eq!(sniff_image_mime(&[0x89, b'P', b'N', b'G', 1]), "image/png");
        assert_eq!(sniff_image_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), "image/jpeg");
        assert_eq!(sniff_image_mime(b"GIF89a"), "image/gif");
        assert_eq!(sniff_image_mime(b"RIFF1234WEBPVP8 "), "image/webp");
        assert_eq!(sniff_image_mime(b"not-an-image"), "image/png");
    }

    #[test]
    fn only_allows_tapd_media_urls() {
        assert!(is_tapd_media_url(
            "https://www.tapd.cn/tfl/captures/2026-11/a.png"
        ));
        assert!(is_tapd_media_url("https://file.tapd.cn/1/attachments/download/2/a.png"));
        assert!(!is_tapd_media_url("https://evil.example.com/a.png"));
        assert!(!is_tapd_media_url("file:///etc/passwd"));
    }
}
