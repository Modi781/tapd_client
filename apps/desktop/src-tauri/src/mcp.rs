//! MCP tool dispatch running inside the desktop app.
//!
//! The sidecar speaks MCP over stdio and forwards tool calls to `/mcp/call`.
//! Policy for v1 is read-only: only the tools in `READ_ONLY_TOOLS` exist.

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::AppHandle;
use tapd_core::tapd::{
    api::{
        bug_detail_body, bug_detail_url, bug_list_url, parse_bug_detail, parse_bug_list,
        parse_workspaces, user_workspace_url, BugQuery,
    },
    BugListPage, Workspace,
};

use crate::{commands::session_request_json, state::SharedState};

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
    let result = dispatch(app, state, tool, arguments).await;

    tracing::info!(
        tool,
        client,
        ok = result.is_ok(),
        duration_ms = started.elapsed().as_millis() as u64,
        error = result.as_ref().err().map(String::as_str).unwrap_or(""),
        "mcp tool call"
    );

    result
}

async fn dispatch(
    app: &AppHandle,
    state: &SharedState,
    tool: &str,
    arguments: &Value,
) -> Result<Value, String> {
    match tool {
        "tapd_whoami" => whoami(app, state).await,
        "tapd_list_projects" => list_projects(app).await,
        "tapd_list_bugs" => list_bugs(app, state, arguments).await,
        "tapd_list_my_bugs" => list_my_bugs(app, state, arguments).await,
        "tapd_get_bug" => get_bug(app, state, arguments).await,
        "tapd_export_bug_md" => export_bug_md(app, state, arguments).await,
        other => Err(format!(
            "tool `{other}` is not available; this client is read-only"
        )),
    }
}

async fn whoami(app: &AppHandle, state: &SharedState) -> Result<Value, String> {
    let (user, workspaces) = load_context(app).await?;
    let default_workspace = default_workspace_id(state, &workspaces);

    Ok(json!({
        "nick": user.get("user_nick").and_then(Value::as_str).unwrap_or_default(),
        "userId": user.get("user_id").and_then(Value::as_str).unwrap_or_default(),
        "company": user.get("company").and_then(Value::as_str).unwrap_or_default(),
        "defaultWorkspaceId": default_workspace,
        "workspaces": workspaces.len(),
    }))
}

async fn list_projects(app: &AppHandle) -> Result<Value, String> {
    let (_, workspaces) = load_context(app).await?;
    serde_json::to_value(workspaces).map_err(|error| error.to_string())
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

    let root = session_request_json(
        app,
        "POST",
        &bug_detail_url(),
        Some(bug_detail_body(&workspace_id, &bug_id)),
        Duration::from_secs(45),
    )
    .await?;

    let detail = parse_bug_detail(&root)?;
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
    if let Some(workspace_id) = string_arg(arguments, "workspace_id") {
        if !workspace_id.is_empty() {
            return Ok(workspace_id);
        }
    }

    if let Some(workspace_id) = state.config_snapshot().last_workspace_id {
        if workspaces.iter().any(|workspace| workspace.id == workspace_id) {
            return Ok(workspace_id);
        }
    }

    workspaces
        .first()
        .map(|workspace| workspace.id.clone())
        .ok_or_else(|| "no accessible TAPD workspace".to_string())
}

fn default_workspace_id(state: &SharedState, workspaces: &[Workspace]) -> Option<String> {
    state
        .config_snapshot()
        .last_workspace_id
        .filter(|id| workspaces.iter().any(|workspace| &workspace.id == id))
        .or_else(|| workspaces.first().map(|workspace| workspace.id.clone()))
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
