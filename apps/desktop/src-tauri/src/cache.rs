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
        if version >= 1 {
            return Ok(());
        }

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

            PRAGMA user_version = 1;
            "#,
        )
        .map_err(|error| error.to_string())
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
        if query.conf_id.as_deref().is_some_and(|value| !value.is_empty()) {
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
    if let Some(owner) = query.owner.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
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

pub async fn command(
    state: &SharedState,
    name: &str,
    payload: Value,
) -> Result<Value, String> {
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
                cache
                    .query_bugs(&query)
                    .and_then(|(page, fetched_at)| serde_json::to_value(page).ok().map(|v| (v, fetched_at)))
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
}
