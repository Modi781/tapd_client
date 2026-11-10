//! `tapd-mcp` — MCP stdio server that proxies tool calls to the desktop app.
//!
//! The desktop app owns the TAPD session, caching and policy. This process only
//! speaks JSON-RPC over stdio and forwards each call to the app's loopback API,
//! launching the app first if necessary.

use std::time::Duration;

use serde_json::{json, Value};
use tapd_core::{paths::AppPaths, runtime::RuntimeInfo};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Stdout};

const PROTOCOL_VERSION: &str = "2024-11-05";
const APP_BUNDLE_ID: &str = "com.tapdclient.desktop";

#[tokio::main]
async fn main() {
    let _ = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .try_init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--version" || arg == "-V") {
        println!("tapd-mcp {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let paths = match AppPaths::resolve() {
        Ok(paths) => paths,
        Err(error) => {
            eprintln!("tapd-mcp: cannot resolve application paths: {error}");
            std::process::exit(1);
        }
    };

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(240))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            eprintln!("tapd-mcp: cannot build HTTP client: {error}");
            std::process::exit(1);
        }
    };

    let mut client_name = "unknown".to_string();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let message: Value = match serde_json::from_str(line) {
            Ok(message) => message,
            Err(error) => {
                send(
                    &mut stdout,
                    json!({
                        "jsonrpc": "2.0",
                        "id": Value::Null,
                        "error": {"code": -32700, "message": format!("parse error: {error}")}
                    }),
                )
                .await;
                continue;
            }
        };

        let id = message.get("id").cloned().filter(|id| !id.is_null());
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");

        match method {
            "initialize" => {
                if let Some(name) = message
                    .pointer("/params/clientInfo/name")
                    .and_then(Value::as_str)
                {
                    client_name = name.to_string();
                }
                tracing::info!(client = %client_name, "mcp initialize");
                respond(
                    &mut stdout,
                    id,
                    json!({
                        "protocolVersion": PROTOCOL_VERSION,
                        "capabilities": {"tools": {"listChanged": false}},
                        "serverInfo": {
                            "name": "tapd-mcp",
                            "version": env!("CARGO_PKG_VERSION")
                        }
                    }),
                )
                .await;
            }
            "notifications/initialized" => {}
            "ping" => respond(&mut stdout, id, json!({})).await,
            "tools/list" => {
                respond(&mut stdout, id, json!({ "tools": tool_definitions() })).await;
            }
            "tools/call" => {
                let name = message
                    .pointer("/params/name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let arguments = message
                    .pointer("/params/arguments")
                    .cloned()
                    .unwrap_or(Value::Null);

                match call_tool(&paths, &client, &client_name, &name, &arguments).await {
                    Ok(data) => {
                        respond(
                            &mut stdout,
                            id,
                            json!({
                                "content": [{"type": "text", "text": pretty(&data)}],
                                "isError": false
                            }),
                        )
                        .await;
                    }
                    Err(error) => {
                        tracing::warn!(tool = %name, %error, "tool call failed");
                        respond(
                            &mut stdout,
                            id,
                            json!({
                                "content": [{"type": "text", "text": error}],
                                "isError": true
                            }),
                        )
                        .await;
                    }
                }
            }
            other => {
                if id.is_some() {
                    send(
                        &mut stdout,
                        json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {"code": -32601, "message": format!("method not found: {other}")}
                        }),
                    )
                    .await;
                }
            }
        }
    }
}

async fn call_tool(
    paths: &AppPaths,
    client: &reqwest::Client,
    client_name: &str,
    tool: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let runtime = ensure_app(paths, client).await?;
    let body = json!({
        "tool": tool,
        "arguments": arguments,
        "client": client_name,
    });

    let mut response = post_tool(client, &runtime, &body).await?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        // The app restarted and rotated its token; retry once with a fresh read.
        let runtime = ensure_app(paths, client).await?;
        response = post_tool(client, &runtime, &body).await?;
    }

    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("invalid response from TAPD Client: {error}"))?;

    if payload.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        Ok(payload.get("data").cloned().unwrap_or(Value::Null))
    } else {
        Err(payload
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("TAPD Client returned an error")
            .to_string())
    }
}

async fn post_tool(
    client: &reqwest::Client,
    runtime: &RuntimeInfo,
    body: &Value,
) -> Result<reqwest::Response, String> {
    client
        .post(format!("http://127.0.0.1:{}/mcp/call", runtime.port))
        .bearer_auth(&runtime.token)
        .json(body)
        .send()
        .await
        .map_err(|error| format!("cannot reach TAPD Client: {error}"))
}

async fn ensure_app(
    paths: &AppPaths,
    client: &reqwest::Client,
) -> Result<RuntimeInfo, String> {
    if let Some(runtime) = read_runtime(paths) {
        if healthy(client, &runtime).await {
            return Ok(runtime);
        }
    }

    launch_app();

    for _ in 0..24 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Some(runtime) = read_runtime(paths) {
            if healthy(client, &runtime).await {
                return Ok(runtime);
            }
        }
    }

    Err("TAPD Client 未运行。请先打开桌面客户端，或确认 MCP 配置指向正确的安装位置。".to_string())
}

fn read_runtime(paths: &AppPaths) -> Option<RuntimeInfo> {
    let runtime = RuntimeInfo::read(&paths.runtime_file).ok()?;
    runtime.pid_alive().then_some(runtime)
}

async fn healthy(client: &reqwest::Client, runtime: &RuntimeInfo) -> bool {
    client
        .get(format!("http://127.0.0.1:{}/healthz", runtime.port))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

fn launch_app() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("/usr/bin/open")
            .args(["-b", APP_BUNDLE_ID])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        let _ = std::process::Command::new("/usr/bin/open")
            .args(["-a", "TAPD Client"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", "tapd-client"])
            .status();
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = std::process::Command::new("tapd-client").status();
    }
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

async fn respond(stdout: &mut Stdout, id: Option<Value>, result: Value) {
    if id.is_none() {
        return;
    }
    send(
        stdout,
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        }),
    )
    .await;
}

async fn send(stdout: &mut Stdout, value: Value) {
    let mut line = serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string());
    line.push('\n');
    let _ = stdout.write_all(line.as_bytes()).await;
    let _ = stdout.flush().await;
}

fn tool_definitions() -> Value {
    json!([
        {
            "name": "tapd_whoami",
            "description": "返回当前登录的 TAPD 用户、默认项目和项目数量。",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
        },
        {
            "name": "tapd_list_projects",
            "description": "列出当前账号可访问的 TAPD 项目（id、名称、最近访问时间）。",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
        },
        {
            "name": "tapd_list_bugs",
            "description": "查询 TAPD 缺陷。默认只返回分配给自己的未解决缺陷；支持按项目、处理人、状态、优先级、严重程度、关键词与时间过滤。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workspace_id": {"type": "string", "description": "项目 ID；省略时使用客户端上次选择的项目"},
                    "owner": {"type": "string", "description": "处理人：me（默认）、all，或精确的 TAPD 昵称"},
                    "statuses": {"type": "array", "items": {"type": "string"}, "description": "状态 key，如 new、in_progress、resolved、reopened"},
                    "priorities": {"type": "array", "items": {"type": "string"}, "description": "优先级：urgent、high、medium、low、insignificant"},
                    "severities": {"type": "array", "items": {"type": "string"}, "description": "严重程度：fatal、serious、normal、prompt、advice"},
                    "keyword": {"type": "string", "description": "标题关键词"},
                    "only_unresolved": {"type": "boolean", "default": true, "description": "仅在未指定 statuses 时生效"},
                    "modified_after": {"type": "string", "description": "最后修改时间下界，格式 YYYY-MM-DD HH:MM:SS"},
                    "created_after": {"type": "string", "description": "创建时间下界，格式 YYYY-MM-DD HH:MM:SS"},
                    "page": {"type": "integer", "minimum": 1, "default": 1},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20}
                },
                "additionalProperties": false
            }
        },
        {
            "name": "tapd_list_my_bugs",
            "description": "查询分配给自己、未解决的缺陷（tapd_list_bugs 的便捷封装）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workspace_id": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20},
                    "page": {"type": "integer", "minimum": 1, "default": 1}
                },
                "additionalProperties": false
            }
        },
        {
            "name": "tapd_get_bug",
            "description": "获取缺陷完整详情：描述（含内联图片/视频链接）、评论、附件、元数据与自定义字段。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workspace_id": {"type": "string", "description": "项目 ID；省略时使用上次选择的项目"},
                    "bug_id": {"type": "string", "description": "缺陷长 ID（列表返回的 id）"}
                },
                "required": ["bug_id"],
                "additionalProperties": false
            }
        },
        {
            "name": "tapd_export_bug_md",
            "description": "把缺陷导出为可直接交给 AI 的 Markdown 包：bug.md + assets/ + bug.json。返回本地绝对路径。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workspace_id": {"type": "string", "description": "项目 ID；省略时使用上次选择的项目"},
                    "bug_id": {"type": "string", "description": "缺陷长 ID"},
                    "workspace_name": {"type": "string", "description": "项目名称，仅用于目录命名"}
                },
                "required": ["bug_id"],
                "additionalProperties": false
            }
        }
    ])
}
