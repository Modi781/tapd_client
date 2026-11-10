//! MCP tool dispatch running inside the desktop app.
//!
//! The sidecar speaks MCP over stdio and forwards tool calls to `/mcp/call`.
//! Every call passes the user-configurable policy (read/write, project scope,
//! allowed statuses) and is written to the local audit log.

use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use tapd_core::{
    config::McpPolicy,
    tapd::{
        api::{bug_list_url, parse_bug_list, parse_workspaces, user_workspace_url, BugQuery},
        BugListPage, Workspace,
    },
};

use crate::{
    commands::session_request_json,
    mcp_audit::McpAuditEntry,
    session,
    state::SharedState,
};

const MAX_RESULTS: u32 = 50;
const DEFAULT_RESULTS: u32 = 20;

const COMMENT_URL: &str = "https://www.tapd.cn/api/entity/comments/add_comment";
const TRANSITION_INFO_URL: &str =
    "https://www.tapd.cn/api/aggregation/bug_aggregation/get_bug_transition_info";
const KANBAN_TRANSITION_URL: &str =
    "https://www.tapd.cn/api/aggregation/kanban_aggregation/transition";
const WORKFLOW_TRANSITION_URL: &str = "https://www.tapd.cn/api/entity/workflow/transition";
const STARTING_STATUSES: &[&str] = &["new", "open", "reopened"];
const PROCESSING_STATUSES: &[&str] = &["in_progress", "progressing"];

pub async fn handle(
    app: &AppHandle,
    state: &SharedState,
    tool: &str,
    arguments: &Value,
    client: &str,
) -> Result<Value, String> {
    let started = Instant::now();
    let policy = state.config_snapshot().mcp_policy;
    let summary = summarize_arguments(arguments);

    if let Some(message) = policy_violation(&policy, tool, arguments) {
        record_audit(
            state,
            &policy,
            tool,
            client,
            "denied",
            false,
            started,
            arguments,
            Some(message.clone()),
            summary,
        );
        tracing::info!(tool, client, ok = false, error = %message, "mcp tool denied by policy");
        return Err(message);
    }

    let result = dispatch(app, state, tool, arguments).await;
    let (decision, ok) = match &result {
        Ok(_) => ("allowed", true),
        Err(_) => ("error", false),
    };

    record_audit(
        state,
        &policy,
        tool,
        client,
        decision,
        ok,
        started,
        arguments,
        result.as_ref().err().cloned(),
        summary,
    );

    tracing::info!(
        tool,
        client,
        ok,
        duration_ms = started.elapsed().as_millis() as u64,
        error = result.as_ref().err().map(String::as_str).unwrap_or(""),
        "mcp tool call"
    );

    result
}

fn is_write_tool(tool: &str) -> bool {
    matches!(
        tool,
        "tapd_add_bug_comment" | "tapd_update_bug_status"
    )
}

/// Returns a user-facing reason when the policy forbids the call.
fn policy_violation(policy: &McpPolicy, tool: &str, arguments: &Value) -> Option<String> {
    if is_write_tool(tool) && !policy.writes_enabled {
        return Some("MCP 写操作已在「MCP 策略」中关闭".to_string());
    }

    if let Some(workspace_id) = string_arg(arguments, "workspace_id") {
        if !policy.allows_workspace(&workspace_id) {
            return Some(format!(
                "项目 {workspace_id} 不在 MCP 策略允许的项目范围内"
            ));
        }
    }

    None
}

/// Non-sensitive snapshot of the call shape for the audit table.
fn summarize_arguments(arguments: &Value) -> Value {
    let mut summary = Map::new();
    for key in [
        "workspace_id",
        "bug_id",
        "status",
        "next_status",
        "owner",
        "limit",
        "page",
        "only_unresolved",
    ] {
        if let Some(value) = arguments.get(key) {
            summary.insert(key.to_string(), value.clone());
        }
    }
    if let Some(comment) = arguments.get("comment").and_then(Value::as_str) {
        summary.insert(
            "commentChars".to_string(),
            Value::from(comment.chars().count() as u64),
        );
    }
    if let Some(fields) = arguments.get("fields").and_then(Value::as_array) {
        summary.insert("fields".to_string(), Value::from(fields.len() as u64));
    }
    Value::Object(summary)
}

#[allow(clippy::too_many_arguments)]
fn record_audit(
    state: &SharedState,
    policy: &McpPolicy,
    tool: &str,
    client: &str,
    decision: &str,
    ok: bool,
    started: Instant,
    arguments: &Value,
    error: Option<String>,
    summary: Value,
) {
    if !policy.audit_enabled {
        return;
    }

    let entry = McpAuditEntry {
        id: uuid::Uuid::new_v4().simple().to_string(),
        ts: chrono::Local::now().to_rfc3339(),
        tool: tool.to_string(),
        client: client.to_string(),
        decision: decision.to_string(),
        ok,
        duration_ms: started.elapsed().as_millis() as u64,
        workspace_id: string_arg(arguments, "workspace_id"),
        bug_id: string_arg(arguments, "bug_id"),
        error,
        summary,
    };

    if let Err(error) = state.mcp_audit.record(entry) {
        tracing::warn!(%error, "failed to persist MCP audit entry");
    }
}

async fn dispatch(
    app: &AppHandle,
    state: &SharedState,
    tool: &str,
    arguments: &Value,
) -> Result<Value, String> {
    match tool {
        "tapd_whoami" => whoami(app, state).await,
        "tapd_list_projects" => list_projects(app, state).await,
        "tapd_list_bugs" => list_bugs(app, state, arguments).await,
        "tapd_list_my_bugs" => list_my_bugs(app, state, arguments).await,
        "tapd_get_bug" => get_bug(app, state, arguments).await,
        "tapd_export_bug_md" => export_bug_md(app, state, arguments).await,
        "tapd_get_bug_transitions" => get_bug_transitions(app, state, arguments).await,
        "tapd_add_bug_comment" => add_bug_comment(app, state, arguments).await,
        "tapd_update_bug_status" => update_bug_status(app, state, arguments).await,
        other => Err(format!("tool `{other}` is not available")),
    }
}

async fn whoami(app: &AppHandle, state: &SharedState) -> Result<Value, String> {
    let (user, workspaces) = load_context(app).await?;
    let policy = state.config_snapshot().mcp_policy;
    let allowed: Vec<Workspace> = workspaces
        .into_iter()
        .filter(|workspace| policy.allows_workspace(&workspace.id))
        .collect();
    let default_workspace = default_workspace_id(state, &allowed, &policy);

    Ok(json!({
        "nick": user.get("user_nick").and_then(Value::as_str).unwrap_or_default(),
        "userId": user.get("user_id").and_then(Value::as_str).unwrap_or_default(),
        "company": user.get("company").and_then(Value::as_str).unwrap_or_default(),
        "defaultWorkspaceId": default_workspace,
        "workspaces": allowed.len(),
    }))
}

async fn list_projects(app: &AppHandle, state: &SharedState) -> Result<Value, String> {
    let (_, workspaces) = load_context(app).await?;
    let policy = state.config_snapshot().mcp_policy;
    let allowed: Vec<Workspace> = workspaces
        .into_iter()
        .filter(|workspace| policy.allows_workspace(&workspace.id))
        .collect();
    serde_json::to_value(allowed).map_err(|error| error.to_string())
}

async fn list_bugs(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    let (_, workspaces) = load_context(app).await?;
    let workspace_id = resolve_workspace(state, &workspaces, arguments)?;
    let page = query_bugs(app, state, &workspace_id, arguments, false).await?;

    Ok(page_json(page))
}

async fn list_my_bugs(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    let (_, workspaces) = load_context(app).await?;
    let workspace_id = resolve_workspace(state, &workspaces, arguments)?;
    let page = query_bugs(app, state, &workspace_id, arguments, true).await?;

    Ok(page_json(page))
}

async fn get_bug(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    let bug_id = string_arg(arguments, "bug_id")
        .ok_or_else(|| "bug_id is required".to_string())?;
    let (_, workspaces) = load_context(app).await?;
    let workspace_id = resolve_workspace(state, &workspaces, arguments)?;

    let detail = crate::commands::fetch_bug_detail(app, &workspace_id, &bug_id).await?;
    serde_json::to_value(detail).map_err(|error| error.to_string())
}

async fn export_bug_md(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    let bug_id = string_arg(arguments, "bug_id")
        .ok_or_else(|| "bug_id is required".to_string())?;
    let (_, workspaces) = load_context(app).await?;
    let workspace_id = resolve_workspace(state, &workspaces, arguments)?;
    let workspace_name = string_arg(arguments, "workspace_name").or_else(|| {
        workspaces
            .iter()
            .find(|workspace| workspace.id == workspace_id)
            .map(|workspace| workspace.name.clone())
    });

    let result = crate::export::run_export(
        app,
        &state.paths,
        &workspace_id,
        &bug_id,
        workspace_name,
    )
    .await?;

    serde_json::to_value(result).map_err(|error| error.to_string())
}

async fn query_bugs(
    app: &AppHandle,
    state: &SharedState,
    workspace_id: &str,
    arguments: &Value,
    force_me: bool,
) -> Result<BugListPage, String> {
    let mut query = BugQuery::new(workspace_id);

    let owner = if force_me {
        Some("me".to_string())
    } else {
        string_arg(arguments, "owner")
    };
    query.owner = match owner.as_deref() {
        Some("all") | Some("") | None => None,
        Some("me") => resolve_me(app, state).await?,
        Some(nick) => Some(nick.to_string()),
    };

    query.statuses = string_array(arguments, "statuses");
    query.priorities = string_array(arguments, "priorities");
    query.severities = string_array(arguments, "severities");
    query.keyword = string_arg(arguments, "keyword");
    query.modified_after = string_arg(arguments, "modified_after");
    query.created_after = string_arg(arguments, "created_after");

    let only_unresolved = arguments
        .get("only_unresolved")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if query.statuses.is_empty() && only_unresolved {
        query.statuses = vec![
            "new".to_string(),
            "in_progress".to_string(),
            "reopened".to_string(),
        ];
    }

    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .map(|value| value as u32)
        .unwrap_or(DEFAULT_RESULTS)
        .clamp(1, MAX_RESULTS);
    query.page = arguments
        .get("page")
        .and_then(Value::as_u64)
        .map(|value| value as u32)
        .unwrap_or(1)
        .max(1);
    // The TAPD endpoint coerces anything below 20 up to 20; trim locally.
    query.perpage = limit.clamp(20, MAX_RESULTS);

    let root = session_request_json(
        app,
        "POST",
        &bug_list_url(),
        Some(query.body()),
        Duration::from_secs(45),
    )
    .await?;

    let mut page = parse_bug_list(&root)?;
    page.bugs.truncate(limit as usize);
    Ok(page)
}

fn page_json(page: BugListPage) -> Value {
    json!({
        "total": page.total,
        "page": page.page,
        "perpage": page.perpage,
        "returned": page.bugs.len(),
        "statusMap": page.status_map,
        "bugs": page.bugs,
    })
}

async fn load_context(app: &AppHandle) -> Result<(Value, Vec<Workspace>), String> {
    let root = session_request_json(
        app,
        "GET",
        &user_workspace_url("0"),
        None,
        Duration::from_secs(30),
    )
    .await?;

    let user = root
        .pointer("/data/get_current_user_ret/data")
        .cloned()
        .ok_or_else(|| "unexpected identity response".to_string())?;
    let workspaces = parse_workspaces(&root)?;

    Ok((user, workspaces))
}

async fn resolve_me(
    app: &AppHandle,
    state: &SharedState,
) -> Result<Option<String>, String> {
    if let Some(me) = state.config_snapshot().me {
        return Ok(Some(me));
    }

    let (user, _) = load_context(app).await?;
    let nick = user
        .get("user_nick")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();

    if nick.is_empty() {
        return Ok(None);
    }

    let snapshot = {
        let mut config = state.config.lock().expect("config lock");
        config.me = Some(nick.clone());
        config.clone()
    };
    let _ = state.save_config(&snapshot);

    Ok(Some(nick))
}

fn resolve_workspace(
    state: &SharedState,
    workspaces: &[Workspace],
    arguments: &Value,
) -> Result<String, String> {
    let policy = state.config_snapshot().mcp_policy;

    if let Some(workspace_id) = string_arg(arguments, "workspace_id") {
        if !workspace_id.is_empty() {
            if !policy.allows_workspace(&workspace_id) {
                return Err(format!(
                    "项目 {workspace_id} 不在 MCP 策略允许的项目范围内"
                ));
            }
            return Ok(workspace_id);
        }
    }

    if let Some(workspace_id) = state.config_snapshot().last_workspace_id {
        if workspaces.iter().any(|workspace| workspace.id == workspace_id)
            && policy.allows_workspace(&workspace_id)
        {
            return Ok(workspace_id);
        }
    }

    workspaces
        .iter()
        .find(|workspace| policy.allows_workspace(&workspace.id))
        .map(|workspace| workspace.id.clone())
        .ok_or_else(|| "没有符合 MCP 策略的可用项目".to_string())
}

// ---------------------------------------------------------------------------
// Write-back tools (comments / status)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct TransitionInfo {
    current_status: String,
    status_alias: BTreeMap<String, String>,
    transitions: Vec<(String, String)>,
}

async fn get_bug_transitions(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    let bug_id = string_arg(arguments, "bug_id")
        .ok_or_else(|| "bug_id is required".to_string())?;
    let (_, workspaces) = load_context(app).await?;
    let workspace_id = resolve_workspace(state, &workspaces, arguments)?;

    let info = load_transition_info(app, &workspace_id, &bug_id).await?;
    let transitions: Vec<Value> = info
        .transitions
        .iter()
        .map(|(key, label)| json!({ "key": key, "label": label }))
        .collect();

    Ok(json!({
        "bugId": bug_id,
        "currentStatus": info.current_status,
        "currentLabel": info.status_alias.get(&info.current_status),
        "statusOptions": info.status_alias,
        "transitions": transitions,
    }))
}

async fn add_bug_comment(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    let bug_id = string_arg(arguments, "bug_id")
        .ok_or_else(|| "bug_id is required".to_string())?;
    let comment = string_arg(arguments, "comment")
        .or_else(|| string_arg(arguments, "body"))
        .ok_or_else(|| "comment is required".to_string())?;
    let (_, workspaces) = load_context(app).await?;
    let workspace_id = resolve_workspace(state, &workspaces, arguments)?;

    let data = add_comment(app, &workspace_id, &bug_id, &comment).await?;
    Ok(json!({
        "ok": true,
        "bugId": bug_id,
        "comment": data,
    }))
}

async fn update_bug_status(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    let bug_id = string_arg(arguments, "bug_id")
        .ok_or_else(|| "bug_id is required".to_string())?;
    let target_input = string_arg(arguments, "status")
        .or_else(|| string_arg(arguments, "next_status"))
        .ok_or_else(|| "status is required".to_string())?;
    let (_, workspaces) = load_context(app).await?;
    let workspace_id = resolve_workspace(state, &workspaces, arguments)?;
    // The working accept workflow sends an empty array; keep the same shape
    // unless the caller supplies explicit transition fields.
    let fields = arguments
        .get("fields")
        .cloned()
        .unwrap_or_else(|| json!([]));

    // Comment first so a rejected transition still leaves the reason on record.
    let comment = string_arg(arguments, "comment");
    if let Some(comment) = comment.as_deref() {
        add_comment(app, &workspace_id, &bug_id, comment).await?;
    }

    let mut info = load_transition_info(app, &workspace_id, &bug_id).await?;
    let target = resolve_status_key(&target_input, &info)?;
    let policy = state.config_snapshot().mcp_policy;
    if !policy.allowed_statuses.is_empty()
        && !policy.allows_status(&target)
        && !policy.allows_status(&target_input)
    {
        return Err(format!(
            "状态「{}」不在 MCP 策略的状态白名单中",
            target_input
        ));
    }
    let original_status = info.current_status.clone();
    let mut current_status = info.current_status.clone();
    let mut steps: Vec<Value> = Vec::new();

    if target != current_status {
        let mut allowed = info.transitions.clone();

        // Workflows usually require accepting a new bug before resolving it.
        if !allowed.iter().any(|(key, _)| *key == target)
            && STARTING_STATUSES.contains(&current_status.as_str())
        {
            if let Some((processing, label)) = allowed
                .iter()
                .find(|(key, _)| PROCESSING_STATUSES.contains(&key.as_str()))
                .cloned()
            {
                transition_once(
                    app,
                    &workspace_id,
                    &bug_id,
                    &current_status,
                    &processing,
                    &fields,
                )
                .await?;
                steps.push(json!({
                    "from": current_status,
                    "to": processing,
                    "label": label,
                }));
                info = load_transition_info(app, &workspace_id, &bug_id).await?;
                current_status = info.current_status.clone();
                allowed = info.transitions.clone();
            }
        }

        if target != current_status {
            if !allowed.iter().any(|(key, _)| *key == target) {
                let allowed_labels: Vec<String> = allowed
                    .iter()
                    .map(|(key, label)| format!("{label} ({key})"))
                    .collect();
                return Err(format!(
                    "不能从「{}」流转到「{}」；当前允许的下一步：{}",
                    info.status_alias
                        .get(&current_status)
                        .cloned()
                        .unwrap_or_else(|| current_status.clone()),
                    info.status_alias
                        .get(&target)
                        .cloned()
                        .unwrap_or_else(|| target.clone()),
                    if allowed_labels.is_empty() {
                        "无".to_string()
                    } else {
                        allowed_labels.join("、")
                    }
                ));
            }

            transition_once(
                app,
                &workspace_id,
                &bug_id,
                &current_status,
                &target,
                &fields,
            )
            .await?;
            steps.push(json!({
                "from": current_status,
                "to": target,
                "label": info.status_alias.get(&target),
            }));
            current_status = target;
        }
    }

    Ok(json!({
        "ok": true,
        "bugId": bug_id,
        "from": original_status,
        "status": current_status,
        "label": info_label(&current_status, &info),
        "changed": !steps.is_empty(),
        "steps": steps,
        "commented": comment.is_some(),
    }))
}

fn info_label(status: &str, info: &TransitionInfo) -> String {
    info.status_alias
        .get(status)
        .cloned()
        .unwrap_or_else(|| status.to_string())
}

async fn load_transition_info(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
) -> Result<TransitionInfo, String> {
    let url = format!(
        "{TRANSITION_INFO_URL}?workspace_id={workspace_id}&bug_id={bug_id}&program_id=&has_rule_fields=undefined&check_rule_fields=undefined"
    );
    let root = session_request_json(app, "GET", &url, None, Duration::from_secs(45)).await?;
    ensure_api_ok(&root, "读取状态流转信息")?;

    let data = root
        .pointer("/data/get_workflow_by_bug/data")
        .ok_or_else(|| "unexpected transition info response".to_string())?;
    let current_status = data
        .get("current_status")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let status_alias: BTreeMap<String, String> = data
        .get("status_alias")
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|label| (key.clone(), label.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();

    let mut transitions: Vec<(String, String)> = Vec::new();
    if let Some(items) = data.get("my_all_transitions").and_then(Value::as_array) {
        for item in items {
            let previous = item
                .get("StepPrevious")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !previous.is_empty() && previous != current_status {
                continue;
            }
            let next = item
                .get("StepNext")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if next.is_empty() || next == current_status {
                continue;
            }
            let label = item
                .get("to_name")
                .and_then(Value::as_str)
                .filter(|label| !label.trim().is_empty())
                .map(str::to_string)
                .or_else(|| status_alias.get(next).cloned())
                .unwrap_or_else(|| next.to_string());
            if !transitions.iter().any(|(key, _)| key == next) {
                transitions.push((next.to_string(), label));
            }
        }
    }

    Ok(TransitionInfo {
        current_status,
        status_alias,
        transitions,
    })
}

fn resolve_status_key(input: &str, info: &TransitionInfo) -> Result<String, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("status is empty".to_string());
    }
    if info.status_alias.contains_key(input) {
        return Ok(input.to_string());
    }
    if let Some((key, _)) = info
        .status_alias
        .iter()
        .find(|(_, label)| label.trim() == input)
    {
        return Ok(key.clone());
    }

    let normalized: String = input
        .chars()
        .filter(|character| !character.is_whitespace() && *character != '/' && *character != '\\')
        .collect();
    let key = match normalized.as_str() {
        "新" | "新建" => "new",
        "待处理" => "open",
        "接受" | "接受处理" => "in_progress",
        "处理中" => "progressing",
        "已解决" | "已修复" => "resolved",
        "已验证" => "verified",
        "已关闭" => "closed",
        "已拒绝" => "rejected",
        "重新打开" => "reopened",
        _ => {
            let known: Vec<String> = info
                .status_alias
                .iter()
                .map(|(key, label)| format!("{label} ({key})"))
                .collect();
            return Err(format!(
                "未知状态「{input}」；可用状态：{}",
                if known.is_empty() {
                    "无".to_string()
                } else {
                    known.join("、")
                }
            ));
        }
    };

    Ok(key.to_string())
}

async fn add_comment(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
    comment: &str,
) -> Result<Value, String> {
    let mut body = json!({
        "entity_id": bug_id,
        "workspace_id": workspace_id,
        "entity_type": "bug",
        "description": comment_html(comment),
        "markdown_description": "",
        "description_type": 1,
        "reply_id": "",
        "root_id": "",
        "program_id": "",
        "workflow_step": "",
        "comment_location": "",
        "npc_repo_path": "",
        "attachment_ids": [],
    });
    if let Some(token) = dsc_token(app) {
        body["dsc_token"] = json!(token);
    }

    let root = session_request_json(
        app,
        "POST",
        COMMENT_URL,
        Some(body),
        Duration::from_secs(45),
    )
    .await?;
    ensure_api_ok(&root, "添加评论")?;

    tracing::info!(bug_id, workspace_id, "mcp added bug comment");
    Ok(root.get("data").cloned().unwrap_or(Value::Null))
}

async fn transition_once(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
    current_status: &str,
    next_status: &str,
    fields: &Value,
) -> Result<(), String> {
    let mut kanban = json!({
        "workspace_id": workspace_id,
        "entity_id": bug_id,
        "entity_type": "bug",
        "current_status": current_status,
        "next_status": next_status,
        "from": "",
        "fields": fields,
        "is_manual": 1,
        "auto_complete": 0,
        "close_task": 0,
        "current_alias_status": "",
        "next_alias_status": "",
        "Timesheet": Value::Null,
        "check_required_fields": 1,
        "edit_rule_fields": [],
    });
    if let Some(token) = dsc_token(app) {
        kanban["dsc_token"] = json!(token);
    }

    let kanban_result = session_request_json(
        app,
        "POST",
        KANBAN_TRANSITION_URL,
        Some(kanban),
        Duration::from_secs(45),
    )
    .await;
    if let Ok(root) = &kanban_result {
        if api_ok(root) {
            tracing::info!(bug_id, current_status, next_status, "mcp transitioned bug (kanban)");
            return Ok(());
        }
    }

    let mut workflow = json!({
        "workspace_id": workspace_id,
        "program_id": "",
        "entity_id": bug_id,
        "entity_type": "bug",
        "current_status": current_status,
        "next_status": next_status,
        "from": "",
        "fields": fields,
        "is_manual": 1,
        "auto_complete": 0,
        "close_task": 0,
        "current_alias_status": "",
        "next_alias_status": "",
        "Timesheet": Value::Null,
    });
    if let Some(token) = dsc_token(app) {
        workflow["dsc_token"] = json!(token);
    }

    let root = session_request_json(
        app,
        "POST",
        WORKFLOW_TRANSITION_URL,
        Some(workflow),
        Duration::from_secs(45),
    )
    .await
    .map_err(|error| {
        let kanban_message = kanban_result
            .err()
            .map(|error| error.to_string())
            .unwrap_or_else(|| "kanban 接口被拒绝".to_string());
        format!("状态流转失败：{error}（kanban：{kanban_message}）")
    })?;
    ensure_api_ok(&root, "状态流转")?;

    tracing::info!(bug_id, current_status, next_status, "mcp transitioned bug (workflow)");
    Ok(())
}

fn comment_html(text: &str) -> String {
    let escaped = text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    escaped
        .split('\n')
        .map(|line| {
            if line.trim().is_empty() {
                "<p><br /></p>".to_string()
            } else {
                format!("<p>{line}</p>")
            }
        })
        .collect()
}

fn dsc_token(app: &AppHandle) -> Option<String> {
    app.get_webview_window(session::SESSION_LABEL)
        .and_then(|window| session::cookie_value(&window, "dsc-token"))
}

fn api_ok(root: &Value) -> bool {
    match root.pointer("/meta/code") {
        Some(Value::Number(number)) => number.as_i64() == Some(0),
        Some(Value::String(code)) => code == "0",
        None => true,
        _ => false,
    }
}

fn api_message(root: &Value) -> String {
    root.pointer("/meta/message")
        .and_then(Value::as_str)
        .unwrap_or("unknown TAPD error")
        .to_string()
}

fn ensure_api_ok(root: &Value, action: &str) -> Result<(), String> {
    if api_ok(root) {
        Ok(())
    } else {
        Err(format!("{action}失败：{}", api_message(root)))
    }
}

fn default_workspace_id(
    state: &SharedState,
    workspaces: &[Workspace],
    policy: &McpPolicy,
) -> Option<String> {
    state
        .config_snapshot()
        .last_workspace_id
        .filter(|id| {
            workspaces.iter().any(|workspace| &workspace.id == id)
                && policy.allows_workspace(id)
        })
        .or_else(|| {
            workspaces
                .iter()
                .find(|workspace| policy.allows_workspace(&workspace.id))
                .map(|workspace| workspace.id.clone())
        })
}

fn string_arg(arguments: &Value, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn string_array(arguments: &Value, key: &str) -> Vec<String> {
    arguments
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alias() -> BTreeMap<String, String> {
        [
            ("new", "新"),
            ("in_progress", "接受/处理"),
            ("resolved", "已解决"),
            ("verified", "已验证"),
            ("reopened", "重新打开"),
            ("rejected", "已拒绝"),
            ("closed", "已关闭"),
        ]
        .into_iter()
        .map(|(key, label)| (key.to_string(), label.to_string()))
        .collect()
    }

    fn info() -> TransitionInfo {
        TransitionInfo {
            current_status: "in_progress".to_string(),
            status_alias: alias(),
            transitions: vec![
                ("in_progress".to_string(), "接受/处理".to_string()),
                ("resolved".to_string(), "已解决".to_string()),
                ("rejected".to_string(), "已拒绝".to_string()),
            ],
        }
    }

    #[test]
    fn resolves_status_key_and_label() {
        assert_eq!(resolve_status_key("resolved", &info()).unwrap(), "resolved");
        assert_eq!(resolve_status_key("已解决", &info()).unwrap(), "resolved");
        assert_eq!(resolve_status_key("接受处理", &info()).unwrap(), "in_progress");
        assert_eq!(resolve_status_key("已拒绝", &info()).unwrap(), "rejected");
    }

    #[test]
    fn rejects_unknown_status() {
        let error = resolve_status_key("不存在的状态", &info()).unwrap_err();
        assert!(error.contains("可用状态"));
    }

    #[test]
    fn comment_html_escapes_marks_and_keeps_paragraphs() {
        let html = comment_html("根因：<script>\n已修复 & 验证\n\n影响范围：聊天列表");
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("&amp;"));
        assert_eq!(html.matches("<p>").count(), 4);
        assert!(html.contains("<p><br /></p>"));
        assert!(!html.contains("<script>"));
    }

    #[test]
    fn api_ok_accepts_zero_number_and_string() {
        assert!(api_ok(&json!({"meta": {"code": 0}})));
        assert!(api_ok(&json!({"meta": {"code": "0"}})));
        assert!(!api_ok(&json!({"meta": {"code": 10015, "message": "no"}})));
    }
}

#[cfg(test)]
mod policy_tests {
    use super::{policy_violation, summarize_arguments};
    use serde_json::json;
    use tapd_core::config::McpPolicy;

    #[test]
    fn writes_can_be_disabled() {
        let args = json!({ "bug_id": "1", "comment": "hello" });
        let mut policy = McpPolicy::default();
        assert!(policy_violation(&policy, "tapd_add_bug_comment", &args).is_none());

        policy.writes_enabled = false;
        assert!(policy_violation(&policy, "tapd_add_bug_comment", &args).is_some());
        // Read tools stay available.
        assert!(policy_violation(&policy, "tapd_get_bug", &args).is_none());
    }

    #[test]
    fn project_allowlist_is_enforced() {
        let policy = McpPolicy {
            allowed_workspace_ids: vec!["45336192".to_string()],
            ..McpPolicy::default()
        };
        assert!(policy_violation(
            &policy,
            "tapd_get_bug",
            &json!({ "workspace_id": "45336192" })
        )
        .is_none());
        assert!(policy_violation(
            &policy,
            "tapd_get_bug",
            &json!({ "workspace_id": "999" })
        )
        .is_some());
    }

    #[test]
    fn audit_summary_never_contains_comment_text() {
        let summary = summarize_arguments(&json!({
            "bug_id": "1",
            "comment": "secret body",
            "status": "resolved"
        }));
        assert_eq!(summary["bug_id"], "1");
        assert_eq!(summary["status"], "resolved");
        assert_eq!(summary["commentChars"], 11);
        assert!(summary.get("comment").is_none());
    }
}
