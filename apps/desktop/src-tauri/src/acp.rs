//! Minimal Agent Client Protocol (ACP) client over stdio.
//!
//! ACP is a bidirectional JSON-RPC protocol: the client asks the agent to run a
//! prompt, the agent streams `session/update` notifications back, and any
//! blocking tool permission is raised as a client request
//! (`session/request_permission`) that we answer with one of the agent-provided
//! options. This is the canonical loop for runtimes that expose `acp`.
//!
//! The transport is NDJSON (one JSON object per line), matching
//! `@agentclientprotocol/sdk` and `opencode acp`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};

use crate::opencode;

const PROMPT_TIMEOUT: Duration = Duration::from_secs(6 * 60 * 60);

/// One option the agent offers in a permission request.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

/// A blocking permission ask from the agent.
#[derive(Clone, Debug)]
pub struct PermissionRequest {
    /// JSON-RPC id of the agent request, echoed back on reply.
    pub request_id: String,
    pub session_id: String,
    pub tool_call_id: String,
    pub title: String,
    pub kind: Option<String>,
    pub options: Vec<PermissionOption>,
}

#[derive(Debug)]
pub enum Event {
    /// `session/update` params.
    Update(Value),
    Permission(PermissionRequest),
    Exited(Option<i32>),
    ProtocolError(String),
    Stderr(String),
}

type Pending = Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>;
type PermissionWaiters = Mutex<HashMap<String, oneshot::Sender<Option<String>>>>;

pub struct Client {
    stdin: AsyncMutex<ChildStdin>,
    child: Mutex<Option<Child>>,
    pid: u32,
    next_id: AtomicU64,
    pending: Pending,
    permissions: PermissionWaiters,
    closed: AtomicBool,
}

impl Client {
    /// Spawns `<binary> acp` and starts the reader tasks.
    pub async fn start(
        binary: &str,
        cwd: &Path,
        raw_log: PathBuf,
    ) -> Result<(Arc<Self>, mpsc::UnboundedReceiver<Event>), String> {
        let mut command = Command::new(binary);
        command
            // A Finder-launched app only has `/usr/bin:/bin:/usr/sbin:/sbin`;
            // the runtime needs the user's shell PATH for its own tool calls.
            .env("PATH", crate::shell_path::user_path())
            .arg("acp")
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        #[cfg(unix)]
        {
            use std::io;
            // SAFETY: `setsid` is async-signal-safe and only touches the child
            // between fork and exec. It lets us kill the whole ACP tree.
            unsafe {
                command.pre_exec(|| {
                    if setsid() == -1 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }

        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 ACP 运行时（{binary} acp）：{error}"))?;
        let pid = child
            .id()
            .ok_or_else(|| "无法读取 ACP 进程 pid".to_string())?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "ACP 进程没有 stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "ACP 进程没有 stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "ACP 进程没有 stderr".to_string())?;

        let client = Arc::new(Self {
            stdin: AsyncMutex::new(stdin),
            child: Mutex::new(Some(child)),
            pid,
            next_id: AtomicU64::new(0),
            pending: Mutex::new(HashMap::new()),
            permissions: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
        });

        let (sender, receiver) = mpsc::unbounded_channel();
        tokio::spawn(read_stdout(stdout, client.clone(), sender.clone(), raw_log));
        tokio::spawn(read_stderr(stderr, sender.clone()));
        tokio::spawn(wait_child(client.clone(), sender));

        Ok((client, receiver))
    }

    #[allow(dead_code)]
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub async fn initialize(&self) -> Result<Value, String> {
        let result = self
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": { "readTextFile": false, "writeTextFile": false },
                        "terminal": false
                    },
                    "clientInfo": {
                        "name": "tapd-client",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
                Duration::from_secs(15),
            )
            .await?;
        let version = result
            .get("protocolVersion")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if version != 1 {
            return Err(format!("ACP 协议版本不受支持：{version}"));
        }
        Ok(result)
    }

    pub async fn new_session(&self, cwd: &str, mcp_servers: Value) -> Result<Value, String> {
        self.request(
            "session/new",
            json!({ "cwd": cwd, "mcpServers": mcp_servers }),
            Duration::from_secs(30),
        )
        .await
    }

    #[allow(dead_code)]
    pub async fn load_session(
        &self,
        session_id: &str,
        cwd: &str,
        mcp_servers: Value,
    ) -> Result<Value, String> {
        self.request(
            "session/load",
            json!({
                "sessionId": session_id,
                "cwd": cwd,
                "mcpServers": mcp_servers
            }),
            Duration::from_secs(30),
        )
        .await
    }

    pub async fn prompt(&self, session_id: &str, text: &str) -> Result<Value, String> {
        self.request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": text }]
            }),
            PROMPT_TIMEOUT,
        )
        .await
    }

    pub async fn cancel(&self, session_id: &str) -> Result<(), String> {
        self.notify("session/cancel", json!({ "sessionId": session_id }))
            .await
    }

    pub async fn close(&self, session_id: &str) -> Result<Value, String> {
        self.request(
            "session/close",
            json!({ "sessionId": session_id }),
            Duration::from_secs(10),
        )
        .await
    }

    #[allow(dead_code)]
    pub async fn authenticate(&self, method_id: &str) -> Result<Value, String> {
        self.request(
            "authenticate",
            json!({ "methodId": method_id }),
            Duration::from_secs(30),
        )
        .await
    }

    /// Answers a pending permission request with one of its `optionId`s.
    /// `None` cancels the request (the agent stops that tool call).
    pub fn respond_permission(
        &self,
        request_id: &str,
        option_id: Option<String>,
    ) -> Result<(), String> {
        let sender = self
            .permissions
            .lock()
            .expect("acp permissions lock")
            .remove(request_id)
            .ok_or_else(|| "该权限请求已失效".to_string())?;
        sender
            .send(option_id)
            .map_err(|_| "权限请求已结束".to_string())
    }

    /// Best-effort kill of the whole ACP process tree. Idempotent.
    pub fn kill(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        #[cfg(unix)]
        {
            opencode::kill_process_group(self.pid, opencode::SIGTERM);
            opencode::kill_process_group(self.pid, opencode::SIGKILL);
        }
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.start_kill();
            }
        }
        self.cancel_pending_permissions();
        if let Ok(mut pending) = self.pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err("ACP 进程已结束".to_string()));
            }
        }
    }

    fn cancel_pending_permissions(&self) {
        if let Ok(mut permissions) = self.permissions.lock() {
            for (_, sender) in permissions.drain() {
                let _ = sender.send(None);
            }
        }
    }

    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("ACP 进程已结束".to_string());
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let key = id.to_string();
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .expect("acp pending lock")
            .insert(key.clone(), sender);

        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });
        if let Err(error) = self.write_line(&message).await {
            self.pending.lock().expect("acp pending lock").remove(&key);
            return Err(error);
        }

        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(format!("{method} 响应通道已关闭")),
            Err(_) => {
                self.pending.lock().expect("acp pending lock").remove(&key);
                Err(format!("{method} 超时"))
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("ACP 进程已结束".to_string());
        }
        self.write_line(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }))
        .await
    }

    async fn write_line(&self, value: &Value) -> Result<(), String> {
        let mut data =
            serde_json::to_vec(value).map_err(|error| format!("序列化 ACP 消息失败：{error}"))?;
        data.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(&data)
            .await
            .map_err(|error| format!("写入 ACP 进程失败：{error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("刷新 ACP 进程失败：{error}"))
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.kill();
    }
}

async fn wait_child(client: Arc<Client>, sender: mpsc::UnboundedSender<Event>) {
    loop {
        let status = {
            let mut guard = client.child.lock().expect("acp child lock");
            match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => Some(Ok(status)),
                    Ok(None) => None,
                    Err(error) => Some(Err(error)),
                },
                None => return,
            }
        };

        match status {
            Some(Ok(status)) => {
                let _ = sender.send(Event::Exited(status.code()));
                return;
            }
            Some(Err(error)) => {
                let _ = sender.send(Event::ProtocolError(format!("等待 ACP 进程失败：{error}")));
                return;
            }
            None => tokio::time::sleep(Duration::from_millis(120)).await,
        }
    }
}

async fn read_stdout(
    stdout: ChildStdout,
    client: Arc<Client>,
    sender: mpsc::UnboundedSender<Event>,
    raw_log: PathBuf,
) {
    let mut raw = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&raw_log)
        .await
        .ok();
    let mut lines = BufReader::new(stdout).lines();

    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if line.trim().is_empty() {
                    continue;
                }
                if let Some(file) = raw.as_mut() {
                    let _ = file.write_all(line.as_bytes()).await;
                    let _ = file.write_all(b"\n").await;
                }
                match serde_json::from_str::<Value>(&line) {
                    Ok(value) => handle_message(&client, &sender, value).await,
                    Err(error) => {
                        let _ = sender.send(Event::ProtocolError(format!(
                            "ACP 返回了无效 JSON：{error}"
                        )));
                    }
                }
            }
            Ok(None) => return,
            Err(error) => {
                let _ = sender.send(Event::ProtocolError(format!("读取 ACP 失败：{error}")));
                return;
            }
        }
    }
}

async fn read_stderr(stderr: ChildStderr, sender: mpsc::UnboundedSender<Event>) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if !line.trim().is_empty() {
            let _ = sender.send(Event::Stderr(line));
        }
    }
}

async fn handle_message(client: &Arc<Client>, sender: &mpsc::UnboundedSender<Event>, value: Value) {
    if let Some(method) = value.get("method").and_then(Value::as_str) {
        let params = value.get("params").cloned().unwrap_or(Value::Null);
        if let Some(id) = value.get("id").cloned() {
            // Agent -> client request.
            match method {
                "session/request_permission" => {
                    handle_permission(client, sender, id, params);
                }
                other => {
                    let response = json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {
                            "code": -32601,
                            "message": format!("客户端不支持 {other}")
                        }
                    });
                    let _ = client.write_line(&response).await;
                }
            }
        } else if method == "session/update" {
            let _ = sender.send(Event::Update(params));
        }
        return;
    }

    if let Some(id) = value.get("id") {
        let key = id_key(id);
        let result = if let Some(error) = value.get("error") {
            Err(format_acp_error(error))
        } else {
            Ok(value.get("result").cloned().unwrap_or(Value::Null))
        };
        if let Some(sender) = client
            .pending
            .lock()
            .expect("acp pending lock")
            .remove(&key)
        {
            let _ = sender.send(result);
        }
    }
}

fn handle_permission(
    client: &Arc<Client>,
    sender: &mpsc::UnboundedSender<Event>,
    json_id: Value,
    params: Value,
) {
    let request_id = id_key(&json_id);
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let tool = params.get("toolCall").cloned().unwrap_or(Value::Null);
    let tool_call_id = tool
        .get("toolCallId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let title = tool
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .unwrap_or("Agent 请求权限")
        .to_string();
    let kind = tool.get("kind").and_then(Value::as_str).map(str::to_string);
    let options = parse_options(&params);

    let (respond_sender, respond_receiver) = oneshot::channel();
    client
        .permissions
        .lock()
        .expect("acp permissions lock")
        .insert(request_id.clone(), respond_sender);

    let _ = sender.send(Event::Permission(PermissionRequest {
        request_id,
        session_id,
        tool_call_id,
        title,
        kind,
        options,
    }));

    let client = client.clone();
    tokio::spawn(async move {
        let option_id = respond_receiver.await.ok().flatten();
        let outcome = match option_id {
            Some(option_id) => json!({ "outcome": "selected", "optionId": option_id }),
            None => json!({ "outcome": "cancelled" }),
        };
        let response = json!({
            "jsonrpc": "2.0",
            "id": json_id,
            "result": { "outcome": outcome }
        });
        let _ = client.write_line(&response).await;
    });
}

fn parse_options(params: &Value) -> Vec<PermissionOption> {
    params
        .get("options")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let option_id = item.get("optionId")?.as_str()?.to_string();
                    let name = item
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or(&option_id)
                        .to_string();
                    let kind = item
                        .get("kind")
                        .and_then(Value::as_str)
                        .unwrap_or("allow_once")
                        .to_string();
                    Some(PermissionOption {
                        option_id,
                        name,
                        kind,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn format_acp_error(error: &Value) -> String {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("ACP 请求失败");
    match error.get("code").and_then(Value::as_i64) {
        Some(code) => format!("{message}（{code}）"),
        None => message.to_string(),
    }
}

fn id_key(id: &Value) -> String {
    match id {
        Value::String(value) => value.clone(),
        other => other.to_string(),
    }
}

#[cfg(unix)]
extern "C" {
    fn setsid() -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_permission_options_and_ids() {
        let params = json!({
            "options": [
                { "optionId": "once", "name": "Allow once", "kind": "allow_once" },
                { "optionId": "always", "name": "Always", "kind": "allow_always" }
            ]
        });
        let options = parse_options(&params);
        assert_eq!(options.len(), 2);
        assert_eq!(options[0].option_id, "once");
        assert_eq!(options[1].kind, "allow_always");
        assert_eq!(id_key(&json!(3)), "3");
        assert_eq!(id_key(&json!("abc")), "abc");
    }

    #[test]
    fn formats_acp_errors() {
        assert_eq!(
            format_acp_error(&json!({ "code": -32000, "message": "boom" })),
            "boom（-32000）"
        );
    }
}
