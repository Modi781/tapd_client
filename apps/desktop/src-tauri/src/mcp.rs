//! MCP tool dispatch running inside the desktop app.
//!
//! The sidecar speaks MCP over stdio and forwards tool calls to `/mcp/call`.
//! Every call passes the user-configurable policy (read/write, project scope,
//! allowed statuses) and is written to the local audit log.

use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tauri::AppHandle;
use tapd_core::{
    config::McpPolicy,
    tapd::{
        api::{bug_list_url, parse_bug_list, parse_workspaces, user_workspace_url, BugQuery},
        BugListPage, Workspace,
    },
};

use crate::{
    bug_write::{self, add_comment, load_transition_info, resolve_status_key},
    commands::session_request_json,
    mcp_audit::McpAuditEntry,
    state::SharedState,
};

const MAX_RESULTS: u32 = 50;
const DEFAULT_RESULTS: u32 = 20;

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

    let _ = state.update_config(|config| config.me = Some(nick.clone()));

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

    let info = load_transition_info(app, &workspace_id, &bug_id).await?;
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

    let outcome =
        bug_write::perform_transition(app, &workspace_id, &bug_id, &target, &fields).await?;

    Ok(json!({
        "ok": true,
        "bugId": bug_id,
        "from": outcome.original_status,
        "status": outcome.status,
        "label": outcome.label,
        "changed": !outcome.steps.is_empty(),
        "steps": outcome.steps,
        "commented": comment.is_some(),
    }))
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
