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
    open_with, session,
    state::SharedState,
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
    /// Port and capability of the media proxy used by `<img>`/`<video>`.
    media_port: Option<u16>,
    media_token: Option<String>,
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
    let runtime = state.runtime_info();
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        paths: state.paths.clone(),
        logged_in: config.logged_in,
        me: config.me,
        last_workspace_id: config.last_workspace_id,
        poll_interval_secs: config.poll_interval_secs,
        runtime_port: runtime.as_ref().map(|runtime| runtime.port),
        media_port: runtime.as_ref().map(|runtime| runtime.port),
        media_token: runtime.map(|runtime| runtime.media_token),
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
pub async fn session_logout(
    app: AppHandle,
    state: State<'_, SharedState>,
) -> Result<(), String> {
    let snapshot = {
        let mut config = state.config.lock().expect("config lock");
        config.logged_in = false;
        config.me = None;
        config.last_session_url = None;
        config.clone()
    };
    state.save_config(&snapshot).map_err(|error| error.to_string())?;

    // Drop cached user/project/bug data: it belongs to the session being ended.
    // Best effort — a broken cache must never block logging out.
    if let Err(error) = state.cache.clear() {
        tracing::warn!(%error, "failed to clear offline cache on logout");
    }

    // Keep the URL watcher from resurrecting the old session while we navigate.
    session::begin_logout_guard(6000);

    if let Some(window) = app.get_webview_window(session::SESSION_LABEL) {
        // Deleting cookies explicitly is more reliable than the bulk clear on
        // macOS, where the removal is asynchronous.
        let mut removed = 0usize;
        if let Ok(cookies) = window.cookies() {
            for cookie in cookies {
                let domain = cookie.domain().unwrap_or_default().to_ascii_lowercase();
                if domain == "tapd.cn" || domain.ends_with(".tapd.cn") {
                    if window.delete_cookie(cookie.clone()).is_ok() {
                        removed += 1;
                    }
                }
            }
        }
        let _ = window.clear_all_browsing_data();

        // Park the SPA first: navigating straight to tapd.cn would let the
        // still-loaded page (or an in-flight request) restore the session.
        if let Ok(blank) = tauri::Url::parse("about:blank") {
            let _ = window.navigate(blank);
        }

        let window_for_reload = window.clone();
        let app_for_emit = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(400)).await;
            let _ = window_for_reload.clear_all_browsing_data();
            if let Ok(home) = tauri::Url::parse(session::TAPD_HOME) {
                let _ = window_for_reload.navigate(home);
            }
            let _ = window_for_reload.show();
            let _ = window_for_reload.set_focus();
            let _ = app_for_emit.emit("session://changed", ());
        });

        tracing::info!(cookies_removed = removed, "session cleared");
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
    state: State<'_, SharedState>,
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
    let context = WorkspaceContext { user, workspaces };

    // Write-through: the UI renders exactly this payload from cache next time.
    state.cache.put_workspace_context(&context);

    Ok(context)
}

#[tauri::command]
pub async fn bug_list(
    app: AppHandle,
    state: State<'_, SharedState>,
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

    let page = parse_bug_list(&root)?;
    state.cache.put_bug_list(&query, &page);
    state.cache.put_bug_records(&query.workspace_id, &page.bugs);

    Ok(page)
}

#[tauri::command]
pub async fn bug_detail(
    app: AppHandle,
    state: State<'_, SharedState>,
    workspace_id: String,
    bug_id: String,
) -> Result<BugDetail, String> {
    // Cached here (not in `fetch_bug_detail`) so MCP/export callers, which need
    // the freshest detail for their own output, don't pay for cache writes.
    let detail = fetch_bug_detail(&app, &workspace_id, &bug_id).await?;
    state.cache.put_bug_detail(&workspace_id, &bug_id, &detail);

    Ok(detail)
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
    /// Path of the opencode global config, when it can be discovered.
    config_path: Option<String>,
    /// Whether that config already registers `tapd-mcp`.
    imported: bool,
}

/// Path to the bundled `tapd-mcp` sidecar (falls back to PATH lookup in dev).
pub(crate) fn sidecar_command_path() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("tapd-mcp")))
        .filter(|path| path.exists())
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| "tapd-mcp".to_string())
}

#[tauri::command]
pub fn mcp_config(state: State<'_, SharedState>) -> McpConfigInfo {
    let command_path = sidecar_command_path();

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
        command_path: command_path.clone(),
        snippet,
        transport: "stdio".to_string(),
        read_only: false,
        tools: vec![
            "tapd_whoami",
            "tapd_list_projects",
            "tapd_list_bugs",
            "tapd_list_my_bugs",
            "tapd_get_bug",
            "tapd_export_bug_md",
            "tapd_get_bug_transitions",
            "tapd_add_bug_comment",
            "tapd_update_bug_status",
        ],
        port: state.runtime_info().map(|runtime| runtime.port),
        config_path: crate::mcp_import::opencode_config_path()
            .map(|path| path.to_string_lossy().to_string()),
        imported: crate::mcp_import::is_imported(&command_path),
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

const MEDIA_DOWNLOAD_LIMIT: u64 = 300 * 1024 * 1024;
const MEDIA_USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

/// Opens a TAPD resource locally.
///
/// `mode`:
/// - `file`    download to the media cache, then open with the chosen app
/// - `browser` open the TAPD URL in the default browser
/// - `reveal`  download, then reveal it in Finder
/// - `path`    download only, returning the local path
///
/// For `file`, `target` overrides the saved "open with" choice; `kind`
/// (`image` / `video` / `file`) selects which saved choice applies.
#[tauri::command]
pub async fn open_media(
    app: AppHandle,
    state: State<'_, SharedState>,
    url: String,
    mode: String,
    kind: Option<String>,
    target: Option<String>,
) -> Result<String, String> {
    if !is_tapd_media_url(&url) {
        return Err("只支持 TAPD 站内资源地址".to_string());
    }

    match mode.as_str() {
        "browser" => {
            run_open(&[url.as_str()])?;
            Ok(String::new())
        }
        "file" => {
            let kind = open_with::normalize_kind(kind.as_deref().unwrap_or("file"));
            let selected = match target {
                Some(target) if !target.trim().is_empty() => target,
                _ => {
                    let open_with = state
                        .config
                        .lock()
                        .expect("config lock")
                        .open_with
                        .clone();
                    open_with::selected_target(kind, &open_with)
                }
            };

            if selected == open_with::BROWSER_TARGET {
                run_open(&[url.as_str()])?;
                return Ok(String::new());
            }

            let path = download_media(&app, &state.paths, &url).await?;
            open_local(&path, &selected)?;
            Ok(path.to_string_lossy().to_string())
        }
        "reveal" => {
            let path = download_media(&app, &state.paths, &url).await?;
            run_open(&["-R", &path.to_string_lossy()])?;
            Ok(path.to_string_lossy().to_string())
        }
        "path" => {
            let path = download_media(&app, &state.paths, &url).await?;
            Ok(path.to_string_lossy().to_string())
        }
        other => Err(format!("不支持的打开方式：{other}")),
    }
}

/// Opens a downloaded file with the selected target app (or the system default).
fn open_local(path: &std::path::Path, target: &str) -> Result<(), String> {
    let path = path.to_string_lossy().to_string();
    if target == open_with::SYSTEM_TARGET {
        return run_open(&[path.as_str()]);
    }

    let app = open_with::app_path_for(target)
        .ok_or_else(|| format!("找不到要使用的应用：{target}"))?;
    run_open(&["-a", &app.to_string_lossy(), path.as_str()])
}

/// Runs `open` and waits for it, so a bad app path surfaces as an error instead
/// of silently doing nothing.
fn run_open(args: &[&str]) -> Result<(), String> {
    let status = std::process::Command::new("open")
        .args(args)
        .status()
        .map_err(|error| format!("启动打开命令失败：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("打开失败（open 退出码 {status}）"))
    }
}

/// Port and capability of the media proxy, so the UI can (re)build the URL even
/// when `app_info` was read before the local server was ready.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    name: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    /// Resolved directory (a dropped file resolves to its parent folder).
    path: String,
    parent: Option<String>,
    entries: Vec<DirEntryInfo>,
}

/// Lists sub-directories for the folder picker. Accepts a file path (drag &
/// drop) and resolves it to the containing folder.
#[tauri::command]
pub fn list_dirs(path: Option<String>) -> Result<DirListing, String> {
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("/"));
    let requested = path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or(home);

    let mut base = if requested.is_file() {
        requested
            .parent()
            .map(std::path::Path::to_path_buf)
            .unwrap_or(requested)
    } else {
        requested
    };
    base = base.canonicalize().unwrap_or(base);
    if !base.is_dir() {
        return Err(format!("目录不存在：{}", base.display()));
    }

    let mut entries: Vec<DirEntryInfo> = Vec::new();
    let read = std::fs::read_dir(&base).map_err(|error| error.to_string())?;
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        if !is_dir {
            continue;
        }
        entries.push(DirEntryInfo {
            path: entry.path().to_string_lossy().to_string(),
            name,
        });
    }
    entries.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));

    Ok(DirListing {
        path: base.to_string_lossy().to_string(),
        parent: base
            .parent()
            .map(|parent| parent.to_string_lossy().to_string()),
        entries,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaEndpoint {
    port: u16,
    token: String,
}

#[tauri::command]
pub fn media_endpoint(state: State<'_, SharedState>) -> Result<MediaEndpoint, String> {
    let runtime = state
        .runtime_info()
        .ok_or_else(|| "本地服务尚未就绪".to_string())?;
    Ok(MediaEndpoint {
        port: runtime.port,
        token: runtime.media_token,
    })
}

/// Lists the "打开方式" options for a resource kind, plus the saved choice.
#[tauri::command]
pub async fn open_targets(
    state: State<'_, SharedState>,
    kind: String,
) -> Result<open_with::OpenTargetSet, String> {
    let cache_dir = state.paths.data_dir.join("app-icons");
    let open_with = state
        .config
        .lock()
        .expect("config lock")
        .open_with
        .clone();

    tokio::task::spawn_blocking(move || open_with::target_set(&kind, &cache_dir, &open_with))
        .await
        .map_err(|error| error.to_string())
}

/// Remembers the chosen app for a resource kind.
#[tauri::command]
pub fn set_open_target(
    state: State<'_, SharedState>,
    kind: String,
    id: String,
) -> Result<(), String> {
    let kind = open_with::normalize_kind(&kind).to_string();
    let snapshot = {
        let mut config = state.config.lock().expect("config lock");
        config.open_with.insert(kind, id);
        config.clone()
    };
    state
        .save_config(&snapshot)
        .map_err(|error| error.to_string())
}

/// Downloads into `media-cache`, reusing a previous download for the same URL.
async fn download_media(
    app: &AppHandle,
    paths: &tapd_core::paths::AppPaths,
    url: &str,
) -> Result<std::path::PathBuf, String> {
    let dir = paths.data_dir.join("media-cache");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;

    let name = format!("{:016x}-{}", fnv1a(url), media_filename(url));
    let path = dir.join(&name);
    if std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() > 0) {
        return Ok(path);
    }

    let window = app
        .get_webview_window(session::SESSION_LABEL)
        .ok_or_else(|| "会话窗口尚未创建".to_string())?;
    let cookie = session::cookie_header(&window)?;

    let response = reqwest::Client::builder()
        .user_agent(MEDIA_USER_AGENT)
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|error| error.to_string())?
        .get(url)
        .header(reqwest::header::COOKIE, cookie)
        .header(reqwest::header::REFERER, "https://www.tapd.cn/")
        .send()
        .await
        .map_err(|error| error.to_string())?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载失败（HTTP {status}）"));
    }
    if response.content_length().unwrap_or(0) > MEDIA_DOWNLOAD_LIMIT {
        return Err("文件超过 300MB，已跳过".to_string());
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MEDIA_DOWNLOAD_LIMIT {
        return Err("文件超过 300MB，已跳过".to_string());
    }
    if content_type.starts_with("text/html") && !bytes.starts_with(b"\x89PNG") {
        return Err(format!("下载被拒绝（{content_type}）"));
    }

    let path = with_content_extension(path, &content_type);
    std::fs::write(&path, &bytes).map_err(|error| error.to_string())?;
    Ok(path)
}

fn fnv1a(value: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn media_filename(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let raw = path.rsplit('/').next().unwrap_or_default();
    let cleaned: String = raw
        .chars()
        .filter(|character| character.is_alphanumeric() || matches!(character, '.' | '-' | '_'))
        .take(90)
        .collect();
    let cleaned = cleaned.trim_matches(['.', '-', '_']).to_string();
    if cleaned.is_empty() {
        "media".to_string()
    } else {
        cleaned
    }
}

fn with_content_extension(path: std::path::PathBuf, content_type: &str) -> std::path::PathBuf {
    let has_extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| !extension.is_empty());
    if has_extension {
        return path;
    }

    let extension = match content_type.split(';').next().unwrap_or("") {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "application/pdf" => "pdf",
        "application/zip" => "zip",
        _ => "",
    };
    if extension.is_empty() {
        path
    } else {
        let name = format!(
            "{}.{extension}",
            path.file_name().and_then(|name| name.to_str()).unwrap_or("media")
        );
        path.with_file_name(name)
    }
}

pub(crate) fn is_tapd_media_url(url: &str) -> bool {
    ["https://www.tapd.cn/", "https://file.tapd.cn/", "https://tdl.tapd.cn/"]
        .iter()
        .any(|prefix| url.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_allows_tapd_media_urls() {
        assert!(is_tapd_media_url(
            "https://www.tapd.cn/tfl/captures/2026-11/a.png"
        ));
        assert!(is_tapd_media_url("https://file.tapd.cn/1/attachments/download/2/a.png"));
        assert!(!is_tapd_media_url("https://evil.example.com/a.png"));
        assert!(!is_tapd_media_url("file:///etc/passwd"));
    }

    #[test]
    fn builds_stable_cache_names() {
        assert_eq!(fnv1a("abc"), fnv1a("abc"));
        assert_ne!(fnv1a("abc"), fnv1a("abd"));
        assert_eq!(
            media_filename("https://file.tapd.cn/1/attachments/download/2/log.ips?x=1"),
            "log.ips"
        );
        assert_eq!(media_filename("https://www.tapd.cn/"), "media");
        assert_eq!(media_filename("https://www.tapd.cn/a/../b"), "b");
    }
}
