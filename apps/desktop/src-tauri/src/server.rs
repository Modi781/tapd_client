use std::time::Duration;

use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tapd_core::runtime::RuntimeInfo;

use crate::{session, state::SharedState};

#[derive(Deserialize)]
struct ExportRequest {
    workspace_id: String,
    bug_id: String,
    #[serde(default)]
    workspace_name: Option<String>,
}

#[derive(Deserialize)]
struct EvalRequest {
    expression: String,
    #[serde(default = "default_eval_timeout")]
    timeout_secs: u64,
}

fn default_eval_timeout() -> u64 {
    15
}

#[derive(Clone)]
struct ApiState {
    app: AppHandle,
    state: SharedState,
}

/// Starts the loopback API consumed by the `tapd-mcp` sidecar and dev tooling.
pub async fn run(app: AppHandle, state: SharedState) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| error.to_string())?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;

    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let runtime = RuntimeInfo {
        app: "tapd-client".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        pid: std::process::id(),
        port: address.port(),
        token,
        started_at: chrono::Utc::now().to_rfc3339(),
    };
    runtime
        .write(&state.paths.runtime_file)
        .map_err(|error| error.to_string())?;
    *state.runtime.lock().expect("runtime lock") = Some(runtime);

    tracing::info!(port = address.port(), "local API listening");

    let api_state = ApiState {
        app,
        state: state.clone(),
    };

    let router = Router::new()
        .route("/healthz", get(healthz))
        .route("/session/ping", get(session_ping))
        .route("/capture/snapshot", get(capture_snapshot))
        .route("/dev/eval", post(dev_eval))
        .route("/dev/call", post(dev_call))
        .route("/dev/cookies", get(dev_cookies))
        .route("/dev/export", post(dev_export))
        .route("/mcp/call", post(mcp_call))
        .with_state(api_state);

    axum::serve(listener, router)
        .await
        .map_err(|error| error.to_string())
}

async fn healthz(State(state): State<ApiState>) -> impl IntoResponse {
    let logged_in = state.state.config.lock().expect("config lock").logged_in;
    let port = state.state.runtime_info().map(|runtime| runtime.port);

    Json(json!({
        "ok": true,
        "app": "tapd-client",
        "version": env!("CARGO_PKG_VERSION"),
        "pid": std::process::id(),
        "port": port,
        "loggedIn": logged_in,
    }))
}

async fn session_ping(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    if !authorized(&ctx.state, &headers) {
        return unauthorized();
    }
    let Some(window) = ctx.app.get_webview_window(session::SESSION_LABEL) else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "error": "session_window_missing" })),
        );
    };

    match session::eval_sync_json(&window, "window.__TAPDCB__.ping()", Duration::from_secs(8))
        .await
    {
        Ok(value) => (StatusCode::OK, Json(json!({ "ok": true, "ping": value }))),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": error })),
        ),
    }
}

async fn capture_snapshot(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    if !authorized(&ctx.state, &headers) {
        return unauthorized();
    }
    let Some(window) = ctx.app.get_webview_window(session::SESSION_LABEL) else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "error": "session_window_missing" })),
        );
    };

    match session::eval_sync_json(
        &window,
        "window.__TAPDCB__.snapshot()",
        Duration::from_secs(20),
    )
    .await
    {
        Ok(value) => (StatusCode::OK, Json(json!({ "ok": true, "captures": value }))),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": error })),
        ),
    }
}

async fn mcp_call(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> (StatusCode, Json<Value>) {
    if !authorized(&ctx.state, &headers) {
        return unauthorized();
    }

    let tool = payload
        .get("tool")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let arguments = payload
        .get("arguments")
        .cloned()
        .unwrap_or(Value::Null);
    let client = payload
        .get("client")
        .and_then(Value::as_str)
        .unwrap_or("unknown");

    match crate::mcp::handle(&ctx.app, &ctx.state, tool, &arguments, client).await {
        Ok(data) => (StatusCode::OK, Json(json!({ "ok": true, "data": data }))),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": error })),
        ),
    }
}

/// Runs the same export pipeline used by the desktop UI.
async fn dev_export(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<ExportRequest>,
) -> (StatusCode, Json<Value>) {
    if !authorized(&ctx.state, &headers) {
        return unauthorized();
    }

    let paths = ctx.state.paths.clone();
    match crate::export::run_export(
        &ctx.app,
        &paths,
        &request.workspace_id,
        &request.bug_id,
        request.workspace_name,
    )
    .await
    {
        Ok(result) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "result": result })),
        ),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": error })),
        ),
    }
}

/// Returns the webview's cookie jar (including HttpOnly) for diagnostics.
/// Values are only exposed over the token-protected loopback endpoint.
async fn dev_cookies(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    if !authorized(&ctx.state, &headers) {
        return unauthorized();
    }
    let Some(window) = ctx.app.get_webview_window(session::SESSION_LABEL) else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "error": "session_window_missing" })),
        );
    };

    match window.cookies() {
        Ok(cookies) => {
            let list: Vec<Value> = cookies
                .iter()
                .map(|cookie| {
                    json!({
                        "name": cookie.name(),
                        "value": cookie.value(),
                        "domain": cookie.domain(),
                        "path": cookie.path(),
                        "secure": cookie.secure(),
                        "httpOnly": cookie.http_only(),
                    })
                })
                .collect();
            (StatusCode::OK, Json(json!({ "ok": true, "cookies": list })))
        }
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": error.to_string() })),
        ),
    }
}

/// Token-protected escape hatch used while mapping TAPD's internal API.
async fn dev_eval(    State(ctx): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<EvalRequest>,
) -> (StatusCode, Json<Value>) {
    if !authorized(&ctx.state, &headers) {
        return unauthorized();
    }
    let Some(window) = ctx.app.get_webview_window(session::SESSION_LABEL) else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "error": "session_window_missing" })),
        );
    };

    let timeout = Duration::from_secs(request.timeout_secs.clamp(1, 60));
    match session::eval_sync_json(&window, &request.expression, timeout).await {
        Ok(value) => (StatusCode::OK, Json(json!({ "ok": true, "value": value }))),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": error })),
        ),
    }
}

/// Same as `/dev/eval`, but resolves through the injected IPC callback.
async fn dev_call(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<EvalRequest>,
) -> (StatusCode, Json<Value>) {
    if !authorized(&ctx.state, &headers) {
        return unauthorized();
    }
    let Some(window) = ctx.app.get_webview_window(session::SESSION_LABEL) else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "error": "session_window_missing" })),
        );
    };

    let timeout = Duration::from_secs(request.timeout_secs.clamp(1, 60));
    match session::eval_async_json(&window, &request.expression, timeout).await {
        Ok(value) => (StatusCode::OK, Json(json!({ "ok": true, "value": value }))),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": error })),
        ),
    }
}

fn unauthorized() -> (StatusCode, Json<Value>) {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "ok": false, "error": "unauthorized" })),
    )
}

fn authorized(state: &SharedState, headers: &HeaderMap) -> bool {
    let Some(runtime) = state.runtime_info() else {
        return false;
    };
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };

    value == format!("Bearer {}", runtime.token)
}
