//! opencode server adapter (per-task `opencode serve` + SSE event stream).
//!
//! The agent worker keeps the TUI in a PTY and uses this module to observe turn
//! completion and permission requests, and to reply to those requests over
//! HTTP.
//!
//! The adapter is deliberately tolerant about the opencode HTTP surface:
//! - readiness is probed on `GET /doc` (v1: OpenAPI JSON, v2: web UI);
//! - the event stream is `GET /event` (v1) or `GET /api/event` (v2);
//! - permission replies / aborts use the v1 path first and fall back to the v2
//!   path when the first route is missing (`404`/`405` or an HTML page).
//!
//! Every event is appended verbatim to `agent-events/<taskId>.jsonl` so that a
//! future opencode version can be adapted without guessing past payloads.

#![allow(dead_code)]

use std::{
    io::{self, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;

/// Basic-auth user used by `opencode serve` (the password is random per task).
pub const SERVER_USERNAME: &str = "opencode";
/// Environment variable read by both `opencode serve` and the TUI client.
pub const SERVER_PASSWORD_ENV: &str = "OPENCODE_SERVER_PASSWORD";
/// How long we wait for `opencode serve` to answer before falling back.
pub const READY_TIMEOUT: Duration = Duration::from_secs(15);

pub const SIGTERM: i32 = 15;
pub const SIGKILL: i32 = 9;

#[cfg(unix)]
extern "C" {
    fn setsid() -> i32;
    fn kill(pid: i32, sig: i32) -> i32;
}

/// A pending permission prompt surfaced to the UI.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionReview {
    pub id: String,
    pub session_id: String,
    pub action: String,
    pub resource: String,
    pub title: String,
    /// ACP permission options, in the order the agent offered them. Empty for
    /// the legacy opencode 3-way prompt.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<crate::acp::PermissionOption>,
    /// `opencode` for the PTY path, `acp` for the protocol path.
    #[serde(default)]
    pub transport: String,
}

/// Which HTTP surface the running opencode server exposes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApiFlavor {
    Unknown,
    V1,
    V2,
}

impl ApiFlavor {
    fn encode(self) -> u8 {
        match self {
            Self::Unknown => 0,
            Self::V1 => 1,
            Self::V2 => 2,
        }
    }

    fn decode(value: u8) -> Self {
        match value {
            1 => Self::V1,
            2 => Self::V2,
            _ => Self::Unknown,
        }
    }
}

/// Turn boundary derived from a server event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TurnSignal {
    Succeeded,
    Failed(String),
    /// The session is still busy; useful only to suppress noise.
    Busy,
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

/// A per-task `opencode serve` child, started in its own session so the whole
/// process group can be signalled at teardown.
pub struct ServerProcess {
    base_url: String,
    password: String,
    child: Mutex<Option<Child>>,
    flavor: AtomicU8,
    stopped: AtomicBool,
    log_path: PathBuf,
}

impl ServerProcess {
    /// Picks a free loopback port, starts `opencode serve` and waits for the
    /// process to spawn (readiness is awaited separately).
    pub fn spawn(binary: &str, cwd: &Path, log_path: &Path) -> Result<Self, String> {
        let port = free_port()?;
        let password = random_password();
        let base_url = format!("http://127.0.0.1:{port}");

        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .map_err(|error| format!("无法创建 agent 服务日志：{error}"))?;
        let stderr = log
            .try_clone()
            .map_err(|error| format!("无法复用 agent 服务日志句柄：{error}"))?;

        let mut command = Command::new(binary);
        command
            // A Finder-launched app only has `/usr/bin:/bin:/usr/sbin:/sbin`;
            // the server needs the user's shell PATH for its own tool calls.
            .env("PATH", crate::shell_path::user_path())
            .arg("serve")
            .arg("--hostname")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .env(SERVER_PASSWORD_ENV, &password)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(stderr));

        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // SAFETY: `setsid` is async-signal-safe and only touches the child
            // between fork and exec.
            unsafe {
                command.pre_exec(|| {
                    if setsid() == -1 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }

        let child = command
            .spawn()
            .map_err(|error| format!("无法启动 opencode serve：{error}"))?;

        tracing::info!(port, cwd = %cwd.display(), "opencode serve started");

        Ok(Self {
            base_url,
            password,
            child: Mutex::new(Some(child)),
            flavor: AtomicU8::new(ApiFlavor::Unknown.encode()),
            stopped: AtomicBool::new(false),
            log_path: log_path.to_path_buf(),
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn password(&self) -> &str {
        &self.password
    }

    pub fn log_path(&self) -> &Path {
        &self.log_path
    }

    pub fn flavor(&self) -> ApiFlavor {
        ApiFlavor::decode(self.flavor.load(Ordering::SeqCst))
    }

    fn set_flavor(&self, flavor: ApiFlavor) {
        self.flavor.store(flavor.encode(), Ordering::SeqCst);
    }

    /// Polls the server until it answers, the child exits, `cancel` is set or
    /// the timeout expires.
    pub async fn wait_ready(&self, timeout: Duration, cancel: &AtomicBool) -> Result<(), String> {
        let client = match reqwest::Client::builder()
            .connect_timeout(Duration::from_millis(1_500))
            .timeout(Duration::from_secs(3))
            .build()
        {
            Ok(client) => client,
            Err(error) => return Err(format!("无法创建 HTTP 客户端：{error}")),
        };

        let started = Instant::now();
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err("已取消".to_string());
            }
            if let Some(status) = self.exit_status() {
                return Err(format!("opencode serve 已退出（{status}）"));
            }

            let url = format!("{}/doc", self.base_url);
            match client
                .get(&url)
                .basic_auth(SERVER_USERNAME, Some(&self.password))
                .send()
                .await
            {
                Ok(response) if response.status().as_u16() != 401 => return Ok(()),
                Ok(response) => {
                    tracing::warn!(status = %response.status(), "opencode serve rejected the password");
                }
                Err(_) => {}
            }

            if started.elapsed() >= timeout {
                return Err(format!(
                    "opencode 服务在 {} 秒内没有就绪",
                    timeout.as_secs()
                ));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    fn exit_status(&self) -> Option<std::process::ExitStatus> {
        let mut guard = self.child.lock().expect("opencode server child lock");
        let child = guard.as_mut()?;
        child.try_wait().ok().flatten()
    }

    /// Opens the SSE stream, detects the HTTP flavor and starts the pump task.
    pub async fn subscribe_events(
        self: &Arc<Self>,
        sink: mpsc::UnboundedSender<Value>,
        events_path: PathBuf,
        cancel: Arc<AtomicBool>,
    ) -> Result<(tauri::async_runtime::JoinHandle<()>, ApiFlavor), String> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .build()
            .map_err(|error| format!("无法创建事件流客户端：{error}"))?;

        let (response, flavor) = self.open_stream(&client).await?;
        self.set_flavor(flavor);

        let process = self.clone();
        let handle = tauri::async_runtime::spawn(async move {
            pump_events(process, client, response, sink, events_path, cancel).await;
        });

        Ok((handle, flavor))
    }

    async fn open_stream(
        &self,
        client: &reqwest::Client,
    ) -> Result<(reqwest::Response, ApiFlavor), String> {
        match self.try_stream(client, "/event").await {
            Ok(response) => Ok((response, ApiFlavor::V1)),
            Err(v1_error) => match self.try_stream(client, "/api/event").await {
                Ok(response) => Ok((response, ApiFlavor::V2)),
                Err(v2_error) => Err(format!("{v1_error}；{v2_error}")),
            },
        }
    }

    async fn try_stream(
        &self,
        client: &reqwest::Client,
        path: &str,
    ) -> Result<reqwest::Response, String> {
        let url = format!("{}{path}", self.base_url);
        let response = tokio::time::timeout(
            Duration::from_secs(10),
            client
                .get(&url)
                .basic_auth(SERVER_USERNAME, Some(&self.password))
                .header(reqwest::header::ACCEPT, "text/event-stream")
                .send(),
        )
        .await
        .map_err(|_| format!("{path} 请求超时"))?
        .map_err(|error| format!("{path} 请求失败：{error}"))?;

        let status = response.status();
        let is_sse = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.starts_with("text/event-stream"))
            .unwrap_or(false);

        if !status.is_success() || !is_sse {
            return Err(format!("{path} 不是事件流（HTTP {status}）"));
        }
        Ok(response)
    }

    /// Best-effort abort of the active turn (`POST /session/{id}/abort`, v2
    /// fallback `POST /api/session/{id}/interrupt`).
    pub async fn abort_session(&self, session_id: &str) -> Result<(), String> {
        if session_id.trim().is_empty() {
            return Err("缺少会话 ID".to_string());
        }
        let client = self.client()?;
        let v1 = format!("/session/{session_id}/abort");
        let v2 = format!("/api/session/{session_id}/interrupt");

        let attempts: Vec<(&str, Option<Value>)> = match self.flavor() {
            ApiFlavor::V2 => vec![(v2.as_str(), None), (v1.as_str(), Some(json!({})))],
            _ => vec![(v1.as_str(), Some(json!({}))), (v2.as_str(), None)],
        };

        let mut last_error = String::new();
        for (path, body) in attempts {
            let url = format!("{}{path}", self.base_url);
            let mut request = client
                .post(&url)
                .basic_auth(SERVER_USERNAME, Some(&self.password));
            if let Some(body) = body {
                let bytes = serde_json::to_vec(&body).map_err(|error| error.to_string())?;
                request = request
                    .header(reqwest::header::CONTENT_TYPE, "application/json")
                    .body(bytes);
            }

            match request.send().await {
                Ok(response) => {
                    let status = response.status();
                    let html = is_html(&response);
                    if status.is_success() && !html {
                        return Ok(());
                    }
                    last_error = format!("{path} 返回 HTTP {status}");
                    if status.is_success() && html {
                        continue;
                    }
                    if status.as_u16() != 404 && status.as_u16() != 405 {
                        break;
                    }
                }
                Err(error) => {
                    last_error = format!("{path} 请求失败：{error}");
                    break;
                }
            }
        }

        Err(if last_error.is_empty() {
            "中止会话失败".to_string()
        } else {
            last_error
        })
    }

    /// Replies to a pending permission request. `response` is one of `once`,
    /// `always`, `reject`.
    pub async fn reply_permission(
        &self,
        session_id: &str,
        permission_id: &str,
        response: &str,
        remember: bool,
    ) -> Result<(), String> {
        if session_id.trim().is_empty() || permission_id.trim().is_empty() {
            return Err("缺少会话或权限请求 ID".to_string());
        }
        let client = self.client()?;

        let v1 = format!("/session/{session_id}/permissions/{permission_id}");
        let v1_body = json!({ "response": response, "remember": remember });
        let v2 = format!("/api/session/{session_id}/permission/{permission_id}/reply");
        let v2_body = json!({ "decision": response });

        let attempts: Vec<(&str, &Value)> = match self.flavor() {
            ApiFlavor::V2 => vec![(v2.as_str(), &v2_body), (v1.as_str(), &v1_body)],
            _ => vec![(v1.as_str(), &v1_body), (v2.as_str(), &v2_body)],
        };

        let mut last_error = String::new();
        for (path, body) in attempts {
            let url = format!("{}{path}", self.base_url);
            let bytes = serde_json::to_vec(body).map_err(|error| error.to_string())?;
            match client
                .post(&url)
                .basic_auth(SERVER_USERNAME, Some(&self.password))
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(bytes)
                .send()
                .await
            {
                Ok(response) => {
                    let status = response.status();
                    let html = is_html(&response);
                    if status.is_success() && !html {
                        return Ok(());
                    }
                    last_error = format!("{path} 返回 HTTP {status}");
                    if status.is_success() && html {
                        continue;
                    }
                    if status.as_u16() != 404 && status.as_u16() != 405 {
                        break;
                    }
                }
                Err(error) => {
                    last_error = format!("{path} 请求失败：{error}");
                    break;
                }
            }
        }

        Err(if last_error.is_empty() {
            "回复权限请求失败".to_string()
        } else {
            last_error
        })
    }

    fn client(&self) -> Result<reqwest::Client, String> {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|error| format!("无法创建 HTTP 客户端：{error}"))
    }

    /// Terminates the whole server process group. Idempotent.
    pub fn stop(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut guard = self.child.lock().expect("opencode server child lock");
        let Some(mut child) = guard.take() else {
            return;
        };

        let pid = child.id();
        #[cfg(unix)]
        let signalled = kill_process_group(pid, SIGTERM);
        #[cfg(not(unix))]
        let signalled = false;

        if !signalled {
            let _ = child.kill();
        }

        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(2) {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }

        #[cfg(unix)]
        kill_process_group(pid, SIGKILL);
        let _ = child.kill();
        let _ = child.wait();
        tracing::warn!(pid, "opencode serve did not exit cleanly; killed");
    }
}

impl Drop for ServerProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

impl std::fmt::Debug for ServerProcess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServerProcess")
            .field("base_url", &self.base_url)
            .field("flavor", &self.flavor())
            .field("log_path", &self.log_path)
            .finish()
    }
}

fn is_html(response: &reqwest::Response) -> bool {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.contains("text/html"))
        .unwrap_or(false)
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("无法分配本地端口：{error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("无法读取本地端口：{error}"))
}

fn random_password() -> String {
    let first = uuid::Uuid::new_v4().simple().to_string();
    let second = uuid::Uuid::new_v4().simple().to_string();
    format!("{first}{second}")
}

/// Sends `signal` to the process group led by `pid`.
#[cfg(unix)]
pub fn kill_process_group(pid: u32, signal: i32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: plain syscall wrapper, no memory is shared.
    unsafe { kill(-(pid as i32), signal) == 0 }
}

#[cfg(not(unix))]
pub fn kill_process_group(_pid: u32, _signal: i32) -> bool {
    false
}

// ---------------------------------------------------------------------------
// SSE pump
// ---------------------------------------------------------------------------

async fn pump_events(
    process: Arc<ServerProcess>,
    client: reqwest::Client,
    mut response: reqwest::Response,
    sink: mpsc::UnboundedSender<Value>,
    events_path: PathBuf,
    cancel: Arc<AtomicBool>,
) {
    if let Some(parent) = events_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&events_path)
        .ok();

    loop {
        if cancel.load(Ordering::SeqCst) || sink.is_closed() {
            return;
        }
        consume_stream(&mut response, &sink, &mut log, &cancel).await;

        if cancel.load(Ordering::SeqCst) || sink.is_closed() {
            return;
        }

        // The stream ended without a cancel: reconnect while the task lives.
        tokio::time::sleep(Duration::from_millis(500)).await;
        if cancel.load(Ordering::SeqCst) || sink.is_closed() {
            return;
        }
        match process.open_stream(&client).await {
            Ok((next, flavor)) => {
                process.set_flavor(flavor);
                response = next;
            }
            Err(error) => {
                tracing::warn!(%error, "opencode event stream reconnect failed");
                tokio::time::sleep(Duration::from_secs(1)).await;
                // Keep the old (ended) response; the next iteration reconnects.
                continue;
            }
        }
    }
}

async fn consume_stream(
    response: &mut reqwest::Response,
    sink: &mpsc::UnboundedSender<Value>,
    log: &mut Option<std::fs::File>,
    cancel: &AtomicBool,
) {
    let mut buffer: Vec<u8> = Vec::new();

    loop {
        if cancel.load(Ordering::SeqCst) || sink.is_closed() {
            return;
        }
        match response.chunk().await {
            Ok(Some(chunk)) => {
                buffer.extend_from_slice(&chunk);
                // A malformed/huge non-newline payload must not balloon memory.
                if buffer.len() > 1024 * 1024 {
                    buffer.clear();
                }
                for line in take_sse_lines(&mut buffer) {
                    let Some(payload) = sse_data_line(&line) else {
                        continue;
                    };
                    let Ok(value) = serde_json::from_str::<Value>(payload) else {
                        tracing::debug!(payload, "ignoring non-JSON opencode event");
                        continue;
                    };
                    if let Some(file) = log.as_mut() {
                        let _ = writeln!(file, "{payload}");
                        let _ = file.flush();
                    }
                    if sink.send(value).is_err() {
                        return;
                    }
                }
            }
            Ok(None) => return,
            Err(error) => {
                tracing::debug!(%error, "opencode event stream ended");
                return;
            }
        }
    }
}

/// Drains complete `\n`-terminated lines from `buffer`.
fn take_sse_lines(buffer: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(position) = buffer.iter().position(|byte| *byte == b'\n') {
        let bytes: Vec<u8> = buffer.drain(..=position).collect();
        let line = String::from_utf8_lossy(&bytes).trim_end().to_string();
        if !line.is_empty() {
            lines.push(line);
        }
    }
    lines
}

/// Returns the JSON payload of an SSE `data:` line. Comments, `event:`/`id:`
/// lines and the `[DONE]` sentinel are ignored.
pub fn sse_data_line(line: &str) -> Option<&str> {
    let line = line.trim_end_matches(['\r', '\n']);
    let payload = line.strip_prefix("data:")?.trim();
    if payload.is_empty() || payload == "[DONE]" {
        return None;
    }
    Some(payload)
}

// ---------------------------------------------------------------------------
// Event decoding
// ---------------------------------------------------------------------------

/// Event name, lowercased. Accepts both v1 (`type`) and the SSE envelope used
/// by the v2 API (`event`).
pub fn event_type(event: &Value) -> String {
    event
        .get("type")
        .and_then(Value::as_str)
        .or_else(|| event.get("event").and_then(Value::as_str))
        .unwrap_or_default()
        .to_ascii_lowercase()
}

pub fn event_session_id(event: &Value) -> Option<String> {
    find_string_by_keys(event, &["sessionID", "sessionId", "session_id"])
}

/// Extracts a pending permission ask from an event payload.
pub fn parse_review(event: &Value) -> Option<PermissionReview> {
    // Only objects that carry a session id are treated as real asks; this
    // rejects the SSE envelope itself (whose `id` is the event id).
    let data = event.get("data");
    let properties = event.get("properties");
    let candidates = [
        properties,
        data,
        data.and_then(|value| value.get("properties")),
        Some(event),
    ];

    candidates
        .into_iter()
        .flatten()
        .find_map(review_from_object)
}

fn review_from_object(value: &Value) -> Option<PermissionReview> {
    let object = value.as_object()?;
    let id = string_field(object, &["id", "requestID", "requestId", "permissionID", "permissionId"])?;
    let session_id = string_field(object, &["sessionID", "sessionId", "session_id"])?;
    if session_id.is_empty() {
        return None;
    }

    let action = string_field(object, &["action", "permission", "tool"])
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "permission".to_string());

    let resource = object
        .get("resource")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            object
                .get("resources")
                .and_then(Value::as_array)
                .and_then(|items| items.iter().find_map(Value::as_str))
                .map(str::to_string)
        })
        .or_else(|| {
            object
                .get("patterns")
                .and_then(Value::as_array)
                .and_then(|items| items.iter().find_map(Value::as_str))
                .map(str::to_string)
        })
        .unwrap_or_default();

    let title = string_field(object, &["title", "message"])
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            object
                .get("metadata")
                .and_then(|metadata| metadata.get("title"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| {
            if resource.is_empty() {
                action.clone()
            } else {
                format!("{action}: {resource}")
            }
        });

    Some(PermissionReview {
        id,
        session_id,
        action,
        resource,
        title,
        options: Vec::new(),
        transport: "opencode".to_string(),
    })
}

/// `true` when the event reports that a pending ask was answered/dismissed.
pub fn is_permission_resolution(event_type: &str) -> bool {
    ["replied", "rejected", "resolved", "cancel", "denied", "dismiss"]
        .iter()
        .any(|needle| event_type.contains(needle))
}

/// Classifies a turn-boundary event. Returns `None` for unrelated events.
pub fn turn_signal(event_type: &str, event: &Value) -> Option<TurnSignal> {
    if event_type == "session.idle" || (event_type.starts_with("session") && event_type.ends_with(".idle")) {
        return Some(TurnSignal::Succeeded);
    }
    if event_type == "session.execution.succeeded" {
        return Some(TurnSignal::Succeeded);
    }
    if event_type == "session.execution.failed" {
        let message = find_string_by_keys(event, &["message", "error"])
            .filter(|message| !message.trim().is_empty())
            .unwrap_or_else(|| "Agent 执行失败".to_string());
        return Some(TurnSignal::Failed(message));
    }
    if event_type == "session.status" {
        return match event_is_idle(event) {
            Some(true) => Some(TurnSignal::Succeeded),
            Some(false) => Some(TurnSignal::Busy),
            None => None,
        };
    }
    None
}

fn event_is_idle(event: &Value) -> Option<bool> {
    let container = event
        .get("data")
        .or_else(|| event.get("properties"))
        .unwrap_or(event);
    let status = container.get("status")?;
    match status {
        Value::String(value) => Some(value.eq_ignore_ascii_case("idle")),
        Value::Object(object) => {
            let value = object
                .get("type")
                .or_else(|| object.get("state"))
                .and_then(Value::as_str)?;
            Some(value.eq_ignore_ascii_case("idle"))
        }
        _ => None,
    }
}

fn string_field(
    object: &serde_json::Map<String, Value>,
    keys: &[&str],
) -> Option<String> {
    for key in keys {
        if let Some(Value::String(value)) = object.get(*key) {
            return Some(value.clone());
        }
    }
    None
}

fn find_string_by_keys(value: &Value, keys: &[&str]) -> Option<String> {
    match value {
        Value::Object(object) => {
            for key in keys {
                if let Some(Value::String(found)) = object.get(*key) {
                    if !found.is_empty() {
                        return Some(found.clone());
                    }
                }
            }
            for nested in object.values() {
                if let Some(found) = find_string_by_keys(nested, keys) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items
            .iter()
            .find_map(|item| find_string_by_keys(item, keys)),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sse_data_lines() {
        assert_eq!(sse_data_line("data: {\"type\":\"x\"}"), Some("{\"type\":\"x\"}"));
        assert_eq!(sse_data_line("data:{\"a\":1}\r"), Some("{\"a\":1}"));
        assert_eq!(sse_data_line(": heartbeat"), None);
        assert_eq!(sse_data_line("event: message"), None);
        assert_eq!(sse_data_line("data: [DONE]"), None);
        assert_eq!(sse_data_line("data:   "), None);
    }

    #[test]
    fn splits_multiple_sse_lines() {
        let mut buffer = b"data: {\"a\":1}\n\ndata: {\"b\":2}\n".to_vec();
        let lines = take_sse_lines(&mut buffer);
        assert_eq!(lines, vec!["data: {\"a\":1}", "data: {\"b\":2}"]);
        assert!(buffer.is_empty());

        let mut partial = b"data: {\"a\"".to_vec();
        assert!(take_sse_lines(&mut partial).is_empty());
        assert_eq!(partial, b"data: {\"a\"");
    }

    #[test]
    fn extracts_v1_permission_review() {
        let event = json!({
            "type": "permission.asked",
            "properties": {
                "id": "per_1",
                "sessionID": "ses_1",
                "permission": "edit",
                "patterns": ["src/main.rs"],
                "title": "允许编辑？"
            }
        });
        assert_eq!(
            parse_review(&event),
            Some(PermissionReview {
                id: "per_1".to_string(),
                session_id: "ses_1".to_string(),
                action: "edit".to_string(),
                resource: "src/main.rs".to_string(),
                title: "允许编辑？".to_string(),
                options: Vec::new(),
                transport: "opencode".to_string(),
            })
        );
        assert_eq!(event_session_id(&event).as_deref(), Some("ses_1"));
    }

    #[test]
    fn extracts_v2_permission_review() {
        let event = json!({
            "id": "evt_1",
            "type": "permission.asked",
            "data": {
                "id": "per_2",
                "sessionID": "ses_2",
                "action": "bash",
                "resources": ["cargo test"],
                "metadata": { "title": "运行测试" }
            }
        });
        let review = parse_review(&event).expect("review");
        assert_eq!(review.id, "per_2");
        assert_eq!(review.session_id, "ses_2");
        assert_eq!(review.action, "bash");
        assert_eq!(review.resource, "cargo test");
        assert_eq!(review.title, "运行测试");
    }

    #[test]
    fn ignores_envelopes_without_a_session() {
        assert_eq!(parse_review(&json!({ "id": "evt_1", "type": "permission.asked" })), None);
    }

    #[test]
    fn classifies_resolution_events() {
        assert!(is_permission_resolution("permission.replied"));
        assert!(is_permission_resolution("permission.rejected"));
        assert!(!is_permission_resolution("permission.asked"));
    }

    #[test]
    fn classifies_turn_signals() {
        assert_eq!(
            turn_signal("session.idle", &json!({})),
            Some(TurnSignal::Succeeded)
        );
        assert_eq!(
            turn_signal("session.execution.succeeded", &json!({})),
            Some(TurnSignal::Succeeded)
        );
        assert_eq!(
            turn_signal("session.execution.failed", &json!({ "data": { "message": "boom" } })),
            Some(TurnSignal::Failed("boom".to_string()))
        );
        assert_eq!(
            turn_signal("session.status", &json!({ "data": { "status": "idle" } })),
            Some(TurnSignal::Succeeded)
        );
        assert_eq!(
            turn_signal("session.status", &json!({ "data": { "status": { "type": "busy" } } })),
            Some(TurnSignal::Busy)
        );
        assert_eq!(turn_signal("server.connected", &json!({})), None);
    }

    #[test]
    fn event_type_accepts_both_envelopes() {
        assert_eq!(event_type(&json!({ "type": "Session.Idle" })), "session.idle");
        assert_eq!(event_type(&json!({ "event": "permission.asked" })), "permission.asked");
        assert_eq!(event_type(&json!({})), "");
    }

    #[test]
    fn free_port_is_loopback() {
        let port = free_port().expect("port");
        assert!(port > 0);
    }
}

