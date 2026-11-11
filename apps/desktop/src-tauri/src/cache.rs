//! Offline cache for TAPD data (projects and bugs).
//!
//! The cache is a write-through snapshot store: every successful live request
//! stores the exact payload the frontend renders, and the UI asks for a
//! snapshot before hitting the network. This keeps the cache shape-free (no
//! schema churn when `BugListPage`/`BugDetail` evolve) while `bugs` rows are
//! still indexed for a later offline search.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use tapd_core::tapd::{BugListPage, BugQuery, BugSummary};

use crate::state::SharedState;

const KIND_WORKSPACES: &str = "workspace_context";
const KIND_BUG_LIST: &str = "bug_list";
const KIND_BUG_DETAIL: &str = "bug_detail";
const KIND_WORKSPACE_MEMBERS: &str = "workspace_members";

/// SQLite-backed cache. A failed open leaves the cache disabled instead of
/// aborting application startup; every method then behaves like a miss.
pub struct Cache {
    conn: Mutex<Option<Connection>>,
}

impl Cache {
    pub fn open(path: PathBuf) -> Self {
        let conn = match Self::open_connection(&path) {
            Ok(conn) => Some(conn),
            Err(error) => {
                tracing::warn!(%error, path = %path.display(), "failed to open offline cache");
                None
            }
        };
        Self {
            conn: Mutex::new(conn),
        }
    }

    fn open_connection(path: &Path) -> Result<Connection, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let conn = Connection::open(path).map_err(|error| error.to_string())?;
        conn.busy_timeout(std::time::Duration::from_millis(2_000))
            .map_err(|error| error.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| error.to_string())?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|error| error.to_string())?;
        Self::migrate(&conn)?;
        Ok(conn)
    }

    fn migrate(conn: &Connection) -> Result<(), String> {
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;

        if version < 1 {
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS snapshots (
                    kind TEXT NOT NULL,
                    key TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    fetched_at INTEGER NOT NULL,
                    PRIMARY KEY (kind, key)
                );

                CREATE TABLE IF NOT EXISTS bugs (
                    workspace_id TEXT NOT NULL,
                    bug_id TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT '',
                    modified TEXT NOT NULL DEFAULT '',
                    raw TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (workspace_id, bug_id)
                );

                CREATE INDEX IF NOT EXISTS idx_bugs_workspace_modified
                    ON bugs (workspace_id, modified DESC);
                "#,
            )
            .map_err(|error| error.to_string())?;
        }

        if version < 2 {
            // Relational mirror of agent tasks: bug <-> task <-> session/log.
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS agent_tasks (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    workspace_name TEXT NOT NULL DEFAULT '',
                    bug_id TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL,
                    session_id TEXT,
                    repo_path TEXT NOT NULL DEFAULT '',
                    log_path TEXT NOT NULL DEFAULT '',
                    md_path TEXT NOT NULL DEFAULT '',
                    source TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT '',
                    started_at TEXT,
                    finished_at TEXT,
                    exit_code INTEGER,
                    error TEXT,
                    updated_at INTEGER NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_agent_tasks_bug
                    ON agent_tasks (workspace_id, bug_id);
                CREATE INDEX IF NOT EXISTS idx_agent_tasks_session
                    ON agent_tasks (session_id);
                "#,
            )
            .map_err(|error| error.to_string())?;
            conn.pragma_update(None, "user_version", 2)
                .map_err(|error| error.to_string())?;
        }

        if version < 3 {
            // Notification settings and poll state. Settings live in a single
            // row; everything else is written incrementally so a 30s poll never
            // rewrites the whole state.
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS notification_settings (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    enabled INTEGER NOT NULL,
                    scope TEXT NOT NULL,
                    include_new INTEGER NOT NULL,
                    include_transferred INTEGER NOT NULL,
                    include_reopened INTEGER NOT NULL,
                    poll_interval_secs INTEGER NOT NULL,
                    quiet_enabled INTEGER NOT NULL,
                    quiet_start TEXT NOT NULL,
                    quiet_end TEXT NOT NULL,
                    max_visible INTEGER NOT NULL,
                    settings_version INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS notification_items (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    workspace_name TEXT NOT NULL DEFAULT '',
                    bug_id TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    kind TEXT NOT NULL,
                    owner TEXT NOT NULL DEFAULT '',
                    creator TEXT NOT NULL DEFAULT '',
                    severity TEXT NOT NULL DEFAULT '',
                    priority TEXT NOT NULL DEFAULT '',
                    created TEXT NOT NULL DEFAULT '',
                    detected_at TEXT NOT NULL DEFAULT '',
                    state TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_notification_items_detected
                    ON notification_items (detected_at);

                CREATE TABLE IF NOT EXISTS notification_seen (
                    bug_key TEXT PRIMARY KEY,
                    status TEXT NOT NULL DEFAULT '',
                    owner TEXT NOT NULL DEFAULT '',
                    created TEXT NOT NULL DEFAULT '',
                    assigned_time TEXT NOT NULL DEFAULT '',
                    kinds TEXT NOT NULL DEFAULT '',
                    last_seen TEXT NOT NULL DEFAULT ''
                );

                CREATE INDEX IF NOT EXISTS idx_notification_seen_last_seen
                    ON notification_seen (last_seen);

                CREATE TABLE IF NOT EXISTS notification_ignored (
                    bug_key TEXT PRIMARY KEY
                );

                CREATE TABLE IF NOT EXISTS notification_cursors (
                    workspace_id TEXT PRIMARY KEY,
                    cursor TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS notification_baseline (
                    workspace_id TEXT PRIMARY KEY,
                    done_at TEXT NOT NULL
                );
                "#,
            )
            .map_err(|error| error.to_string())?;
            conn.pragma_update(None, "user_version", 3)
                .map_err(|error| error.to_string())?;
        }

        if version < 4 {
            // MCP / AI capsule notifications can be switched off independently
            // from TAPD bug polling.
            conn.execute(
                "ALTER TABLE notification_settings
                    ADD COLUMN ai_enabled INTEGER NOT NULL DEFAULT 1",
                [],
            )
            .map_err(|error| error.to_string())?;
            conn.pragma_update(None, "user_version", 4)
                .map_err(|error| error.to_string())?;
        }

        Ok(())
    }

    /// Runs `f` against the shared connection. `None` means SQLite is disabled
    /// (the cache failed to open), so callers degrade to in-memory behaviour.
    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> T) -> Option<T> {
        let guard = self.conn.lock().expect("cache lock");
        guard.as_ref().map(f)
    }

    pub fn get(&self, kind: &str, key: &str) -> Option<(String, i64)> {
        let guard = self.conn.lock().expect("cache lock");
        let conn = guard.as_ref()?;
        conn.query_row(
            "SELECT payload, fetched_at FROM snapshots WHERE kind = ?1 AND key = ?2",
            params![kind, key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .ok()
        .flatten()
    }

    fn put(&self, kind: &str, key: &str, payload: &str) {
        let guard = self.conn.lock().expect("cache lock");
        let Some(conn) = guard.as_ref() else {
            return;
        };
        let fetched_at = unix_now();
        if let Err(error) = conn.execute(
            "INSERT INTO snapshots (kind, key, payload, fetched_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(kind, key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at",
            params![kind, key, payload, fetched_at],
        ) {
            tracing::warn!(%error, kind, key, "failed to write cache snapshot");
        }
    }

    pub fn get_snapshot<T: DeserializeOwned>(&self, kind: &str, key: &str) -> Option<(T, i64)> {
        let (payload, fetched_at) = self.get(kind, key)?;
        serde_json::from_str(&payload)
            .ok()
            .map(|value| (value, fetched_at))
    }

    pub fn put_snapshot<T: Serialize>(&self, kind: &str, key: &str, value: &T) {
        match serde_json::to_string(value) {
            Ok(payload) => self.put(kind, key, &payload),
            Err(error) => tracing::warn!(%error, kind, key, "failed to serialize cache snapshot"),
        }
    }

    /// Write-through helpers used by the live TAPD commands.
    pub fn put_workspace_context<T: Serialize>(&self, value: &T) {
        self.put_snapshot(KIND_WORKSPACES, "latest", value);
    }

    pub fn get_workspace_context<T: DeserializeOwned>(&self) -> Option<(T, i64)> {
        self.get_snapshot(KIND_WORKSPACES, "latest")
    }

    pub fn put_bug_list<T: Serialize>(&self, query: &BugQuery, value: &T) {
        self.put_snapshot(KIND_BUG_LIST, &bug_list_key(query), value);
    }

    pub fn get_bug_list<T: DeserializeOwned>(&self, query: &BugQuery) -> Option<(T, i64)> {
        self.get_snapshot(KIND_BUG_LIST, &bug_list_key(query))
    }

    pub fn put_bug_detail<T: Serialize>(&self, workspace_id: &str, bug_id: &str, value: &T) {
        self.put_snapshot(
            KIND_BUG_DETAIL,
            &bug_detail_key(workspace_id, bug_id),
            value,
        );
    }

    pub fn get_bug_detail<T: DeserializeOwned>(
        &self,
        workspace_id: &str,
        bug_id: &str,
    ) -> Option<(T, i64)> {
        self.get_snapshot(KIND_BUG_DETAIL, &bug_detail_key(workspace_id, bug_id))
    }

    pub fn put_workspace_members<T: Serialize>(&self, workspace_id: &str, value: &T) {
        self.put_snapshot(KIND_WORKSPACE_MEMBERS, workspace_id, value);
    }

    pub fn get_workspace_members<T: DeserializeOwned>(
        &self,
        workspace_id: &str,
    ) -> Option<(T, i64)> {
        self.get_snapshot(KIND_WORKSPACE_MEMBERS, workspace_id)
    }

    pub fn put_bug_records(&self, workspace_id: &str, bugs: &[BugSummary]) {
        let guard = self.conn.lock().expect("cache lock");
        let Some(conn) = guard.as_ref() else {
            return;
        };
        let updated_at = unix_now();
        for bug in bugs {
            let raw = match serde_json::to_string(bug) {
                Ok(raw) => raw,
                Err(_) => continue,
            };
            if let Err(error) = conn.execute(
                "INSERT INTO bugs (workspace_id, bug_id, title, status, modified, raw, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(workspace_id, bug_id) DO UPDATE SET
                    title = excluded.title,
                    status = excluded.status,
                    modified = excluded.modified,
                    raw = excluded.raw,
                    updated_at = excluded.updated_at",
                params![
                    workspace_id,
                    bug.id,
                    bug.title,
                    bug.status,
                    bug.modified,
                    raw,
                    updated_at
                ],
            ) {
                tracing::warn!(%error, bug_id = %bug.id, "failed to cache bug record");
            }
        }
    }

    /// Mirrors the agent task list into SQLite so bug/task/session/log
    /// relationships survive independently of `agent-tasks.json`.
    pub fn replace_agent_tasks(&self, tasks: &[crate::agent::AgentTask]) {
        let guard = self.conn.lock().expect("cache lock");
        let Some(conn) = guard.as_ref() else {
            return;
        };
        let updated_at = unix_now();
        for task in tasks {
            let status = match serde_json::to_value(&task.status) {
                Ok(Value::String(value)) => value,
                _ => continue,
            };
            if let Err(error) = conn.execute(
                "INSERT INTO agent_tasks (
                    id, workspace_id, workspace_name, bug_id, title, status,
                    session_id, repo_path, log_path, md_path, source, created_at,
                    started_at, finished_at, exit_code, error, updated_at
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17
                 )
                 ON CONFLICT(id) DO UPDATE SET
                    workspace_id = excluded.workspace_id,
                    workspace_name = excluded.workspace_name,
                    bug_id = excluded.bug_id,
                    title = excluded.title,
                    status = excluded.status,
                    session_id = excluded.session_id,
                    repo_path = excluded.repo_path,
                    log_path = excluded.log_path,
                    md_path = excluded.md_path,
                    source = excluded.source,
                    created_at = excluded.created_at,
                    started_at = excluded.started_at,
                    finished_at = excluded.finished_at,
                    exit_code = excluded.exit_code,
                    error = excluded.error,
                    updated_at = excluded.updated_at",
                params![
                    task.id,
                    task.workspace_id,
                    task.workspace_name,
                    task.bug_id,
                    task.title,
                    status,
                    task.session_id,
                    task.repo_path,
                    task.log_path,
                    task.md_path,
                    task.source,
                    task.created_at,
                    task.started_at,
                    task.finished_at,
                    task.exit_code,
                    task.error,
                    updated_at
                ],
            ) {
                tracing::warn!(%error, task_id = %task.id, "failed to mirror agent task");
            }
        }
    }

    pub fn clear(&self) -> Result<(), String> {
        let guard = self.conn.lock().expect("cache lock");
        let Some(conn) = guard.as_ref() else {
            return Ok(());
        };
        conn.execute_batch("DELETE FROM snapshots; DELETE FROM bugs;")
            .map_err(|error| error.to_string())
    }

    /// Offline fallback: filters the cached `bugs` rows locally when no exact
    /// snapshot exists for this query (e.g. the user changed a filter offline).
    pub fn query_bugs(&self, query: &BugQuery) -> Option<(BugListPage, i64)> {
        // Saved views (`confId`) are server-side definitions we cannot replay.
        if query
            .conf_id
            .as_deref()
            .is_some_and(|value| !value.is_empty())
        {
            return None;
        }

        let guard = self.conn.lock().expect("cache lock");
        let conn = guard.as_ref()?;
        let mut statement = conn
            .prepare("SELECT raw, updated_at FROM bugs WHERE workspace_id = ?1")
            .ok()?;
        let rows = statement
            .query_map(params![query.workspace_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .ok()?;

        let mut matched: Vec<BugSummary> = Vec::new();
        let mut newest = 0i64;
        for row in rows.flatten() {
            let (raw, updated_at) = row;
            newest = newest.max(updated_at);
            let Ok(bug) = serde_json::from_str::<BugSummary>(&raw) else {
                continue;
            };
            if matches_query(query, &bug) {
                matched.push(bug);
            }
        }
        if matched.is_empty() {
            return None;
        }

        sort_bugs(query, &mut matched);
        let total = matched.len() as u32;
        let perpage = query.perpage.max(1);
        let page = query.page.max(1);
        let start = ((page - 1) as usize).saturating_mul(perpage as usize);
        let bugs = matched
            .into_iter()
            .skip(start)
            .take(perpage as usize)
            .collect();

        Some((
            BugListPage {
                page,
                perpage,
                total,
                status_map: Default::default(),
                bugs,
            },
            newest,
        ))
    }
}

fn matches_query(query: &BugQuery, bug: &BugSummary) -> bool {
    if let Some(owner) = query
        .owner
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        if bug.owner != owner {
            return false;
        }
    }
    if !query.statuses.is_empty() && !query.statuses.contains(&bug.status) {
        return false;
    }
    if !query.priorities.is_empty() && !query.priorities.contains(&bug.priority) {
        return false;
    }
    if !query.severities.is_empty() && !query.severities.contains(&bug.severity) {
        return false;
    }
    if let Some(keyword) = query
        .keyword
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let needle = keyword.to_lowercase();
        if !bug.title.to_lowercase().contains(&needle) {
            return false;
        }
    }
    if let Some(after) = query.modified_after.as_deref().filter(|v| !v.is_empty()) {
        if bug.modified.as_str() < after {
            return false;
        }
    }
    if let Some(after) = query.created_after.as_deref().filter(|v| !v.is_empty()) {
        if bug.created.as_str() < after {
            return false;
        }
    }
    true
}

fn sort_bugs(query: &BugQuery, bugs: &mut [BugSummary]) {
    let descending = !query.order.eq_ignore_ascii_case("asc");
    match query.sort_name.as_str() {
        "modified" => bugs.sort_by(|a, b| b.modified.cmp(&a.modified)),
        _ => bugs.sort_by(|a, b| b.created.cmp(&a.created)),
    }
    if !descending {
        bugs.reverse();
    }
}

pub fn bug_list_key(query: &BugQuery) -> String {
    serde_json::to_string(query).unwrap_or_default()
}

pub fn bug_detail_key(workspace_id: &str, bug_id: &str) -> String {
    format!("{workspace_id}:{bug_id}")
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedPayload {
    data: Option<Value>,
    fetched_at: Option<i64>,
}

fn cached(value: Option<(Value, i64)>) -> CachedPayload {
    match value {
        Some((data, fetched_at)) => CachedPayload {
            data: Some(data),
            fetched_at: Some(fetched_at),
        },
        None => CachedPayload {
            data: None,
            fetched_at: None,
        },
    }
}

pub async fn command(state: &SharedState, name: &str, payload: Value) -> Result<Value, String> {
    let cache = &state.cache;
    match name {
        "cache_workspace_context" => {
            let value = cache.get_workspace_context::<Value>();
            Ok(serde_json::to_value(cached(value)).unwrap_or_else(|_| Value::Null))
        }
        "cache_bug_list" => {
            let query = parse_bug_query(&payload)?;
            // Exact query snapshot first; otherwise filter the cached bug rows
            // locally so offline filter changes still show data.
            let value = cache.get_bug_list::<Value>(&query).or_else(|| {
                cache.query_bugs(&query).and_then(|(page, fetched_at)| {
                    serde_json::to_value(page).ok().map(|v| (v, fetched_at))
                })
            });
            Ok(serde_json::to_value(cached(value)).unwrap_or_else(|_| Value::Null))
        }
        "cache_bug_detail" => {
            let workspace_id = payload
                .get("workspaceId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            let bug_id = payload
                .get("bugId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if workspace_id.is_empty() || bug_id.is_empty() {
                return Err("缺少 workspaceId 或 bugId".to_string());
            }
            let value = cache.get_bug_detail::<Value>(&workspace_id, &bug_id);
            Ok(serde_json::to_value(cached(value)).unwrap_or_else(|_| Value::Null))
        }
        "cache_workspace_members" => {
            let workspace_id = payload
                .get("workspaceId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if workspace_id.is_empty() {
                return Err("缺少 workspaceId".to_string());
            }
            let value = cache.get_workspace_members::<Value>(&workspace_id);
            Ok(serde_json::to_value(cached(value)).unwrap_or_else(|_| Value::Null))
        }
        "cache_clear" => {
            cache.clear()?;
            Ok(serde_json::json!({ "ok": true }))
        }
        other => Err(format!("unknown cache command: {other}")),
    }
}

fn parse_bug_query(payload: &Value) -> Result<BugQuery, String> {
    let query = payload
        .get("query")
        .cloned()
        .ok_or_else(|| "缺少 query".to_string())?;
    serde_json::from_value(query).map_err(|error| format!("无效的查询参数：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_cache() -> Cache {
        let path = std::env::temp_dir().join(format!(
            "tapd-cache-test-{}.sqlite3",
            uuid::Uuid::new_v4().simple()
        ));
        Cache::open(path)
    }

    #[test]
    fn snapshots_roundtrip() {
        let cache = temp_cache();
        cache.put_workspace_context(&serde_json::json!({ "ok": true }));
        let (value, fetched_at): (Value, i64) = cache
            .get_workspace_context()
            .expect("snapshot should exist");
        assert_eq!(value["ok"], true);
        assert!(fetched_at > 0);
    }

    #[test]
    fn bug_list_key_is_stable() {
        let query = BugQuery::default();
        assert_eq!(bug_list_key(&query), bug_list_key(&query));
    }

    #[test]
    fn offline_query_filters_and_paginates() {
        let cache = temp_cache();
        let mut mine = BugSummary {
            id: "1".to_string(),
            title: "login crash".to_string(),
            owner: "me".to_string(),
            status: "new".to_string(),
            created: "2026-01-02 00:00:00".to_string(),
            modified: "2026-01-02 00:00:00".to_string(),
            ..BugSummary::default()
        };
        let other = BugSummary {
            id: "2".to_string(),
            title: "logout crash".to_string(),
            owner: "someone".to_string(),
            status: "new".to_string(),
            created: "2026-01-03 00:00:00".to_string(),
            modified: "2026-01-03 00:00:00".to_string(),
            ..BugSummary::default()
        };
        mine.workspace_id = "ws".to_string();
        cache.put_bug_records("ws", &[mine, other]);

        let query = BugQuery {
            workspace_id: "ws".to_string(),
            owner: Some("me".to_string()),
            perpage: 10,
            page: 1,
            sort_name: "created".to_string(),
            order: "desc".to_string(),
            ..BugQuery::default()
        };
        let (page, fetched_at) = cache.query_bugs(&query).expect("offline rows");
        assert_eq!(page.total, 1);
        assert_eq!(page.bugs[0].id, "1");
        assert!(fetched_at > 0);

        let keyword = BugQuery {
            keyword: Some("CRASH".to_string()),
            owner: None,
            perpage: 1,
            page: 2,
            ..query.clone()
        };
        let (page, _) = cache.query_bugs(&keyword).expect("keyword rows");
        assert_eq!(page.total, 2);
        assert_eq!(page.bugs.len(), 1);
        assert_eq!(page.bugs[0].id, "1");
    }

    #[test]
    fn mirrors_agent_task_relations() {
        let cache = temp_cache();
        let task = crate::agent::AgentTask {
            id: "task-1".to_string(),
            workspace_id: "ws".to_string(),
            workspace_name: "WS".to_string(),
            bug_id: "bug-1".to_string(),
            title: "bug title".to_string(),
            severity: "严重".to_string(),
            priority: "高".to_string(),
            md_path: "/tmp/bug.md".to_string(),
            repo_path: "/tmp/repo".to_string(),
            status: crate::agent::TaskStatus::Succeeded,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            started_at: None,
            finished_at: None,
            exit_code: Some(0),
            log_path: "/tmp/task.log".to_string(),
            error: None,
            prompt: "prompt".to_string(),
            source: "manual".to_string(),
            runtime_id: "opencode".to_string(),
            transport: "acp".to_string(),
            session_id: Some("ses_1".to_string()),
            review: None,
            approval: None,
            commit_only: false,
            extra_prompt: String::new(),
            attachments: Vec::new(),
            baseline_dirty: Vec::new(),
            baseline_head: None,
        };
        cache.replace_agent_tasks(&[task]);

        let guard = cache.conn.lock().expect("cache lock");
        let conn = guard.as_ref().expect("cache connection");
        let (status, session): (String, String) = conn
            .query_row(
                "SELECT status, session_id FROM agent_tasks WHERE id = 'task-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("mirrored row");
        assert_eq!(status, "succeeded");
        assert_eq!(session, "ses_1");
    }

    #[test]
    fn upgrades_v1_cache_and_keeps_snapshots() {
        let path = std::env::temp_dir().join(format!(
            "tapd-cache-v1-{}.sqlite3",
            uuid::Uuid::new_v4().simple()
        ));
        {
            let conn = Connection::open(&path).expect("v1 db");
            conn.execute_batch(
                "CREATE TABLE snapshots (kind TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (kind, key));
                 CREATE TABLE bugs (workspace_id TEXT NOT NULL, bug_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', modified TEXT NOT NULL DEFAULT '', raw TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, bug_id));
                 PRAGMA user_version = 1;",
            )
            .expect("v1 schema");
        }

        let cache = Cache::open(path);
        let guard = cache.conn.lock().expect("cache lock");
        let conn = guard.as_ref().expect("cache connection");
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        let table: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'agent_tasks'",
                [],
                |row| row.get(0),
            )
            .expect("agent_tasks table");
        let notification_table: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                  WHERE type = 'table' AND name = 'notification_settings'",
                [],
                |row| row.get(0),
            )
            .expect("notification_settings table");
        assert_eq!(version, 4);
        assert_eq!(table, 1);
        assert_eq!(notification_table, 1);
    }
}
