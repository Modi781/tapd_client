//! M6 — new-bug detection, self-drawn notification window and the accept action.
//!
//! Everything here is owned by the M6 implementation and exposed through
//! `feature_command` names starting with `notification_`.
//!
//! Design notes:
//! - Polling never touches the UI directly; it records items in
//!   `<data_dir>/notifications.json` and emits `notification://show`.
//! - The first poll for a workspace is a baseline: bugs are recorded in `seen`
//!   but no notification is produced.
//! - Classification is a set of pure functions (`classify_bug`, `quiet_hours_active`,
//!   body builders) so the business rules are unit-testable without TAPD.

use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

use chrono::{Duration as ChronoDuration, Local, NaiveDateTime, NaiveTime};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tapd_core::{
    store::{read_json, write_json_atomic},
    tapd::api::{
        bug_detail_body, bug_detail_url, bug_list_url, parse_bug_detail, parse_bug_list,
        parse_workspaces, user_workspace_url, BugQuery,
    },
};

use crate::{commands::session_request_json, session, state::SharedState};

/// Tauri label of the self-drawn notification window (see `main.tsx`).
pub const WINDOW_LABEL: &str = "island";
const STORE_FILE: &str = "notifications.json";
const MAX_ITEMS: usize = 200;
const MAX_HISTORY: usize = 100;
const FRESH_WINDOW_MINUTES: i64 = 5;
const OVERLAP_MINUTES: i64 = 2;
const POLL_PAGE_SIZE: u32 = 200;
const MAX_DETAIL_LOOKUPS: usize = 5;

const INLINE_UPDATE_URL: &str = "https://www.tapd.cn/api/entity/bugs/inline_update";
const KANBAN_TRANSITION_URL: &str =
    "https://www.tapd.cn/api/aggregation/kanban_aggregation/transition";
const WORKFLOW_TRANSITION_URL: &str = "https://www.tapd.cn/api/entity/workflow/transition";

static SERVICE: OnceLock<Arc<NotificationService>> = OnceLock::new();

// ---------------------------------------------------------------------------
// Domain types (serialized camelCase for the React window)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationKind {
    New,
    Transferred,
    Reopened,
}

impl NotificationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Transferred => "transferred",
            Self::Reopened => "reopened",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "new" => Some(Self::New),
            "transferred" => Some(Self::Transferred),
            "reopened" => Some(Self::Reopened),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationState {
    Pending,
    Handled,
    Viewed,
    Ignored,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationScope {
    #[default]
    Mine,
    Project,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QuietHours {
    pub enabled: bool,
    pub start: String,
    pub end: String,
}

impl Default for QuietHours {
    fn default() -> Self {
        Self {
            enabled: false,
            start: "22:00".to_string(),
            end: "09:00".to_string(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationSettings {
    pub enabled: bool,
    pub scope: NotificationScope,
    pub include_new: bool,
    pub include_transferred: bool,
    pub include_reopened: bool,
    pub poll_interval_secs: u64,
    pub quiet_hours: QuietHours,
    pub max_visible: u32,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            scope: NotificationScope::Mine,
            include_new: true,
            include_transferred: false,
            include_reopened: true,
            poll_interval_secs: 60,
            quiet_hours: QuietHours::default(),
            max_visible: 3,
        }
    }
}

impl NotificationSettings {
    pub fn allows(&self, kind: NotificationKind) -> bool {
        match kind {
            NotificationKind::New => self.include_new,
            NotificationKind::Transferred => self.include_transferred,
            NotificationKind::Reopened => self.include_reopened,
        }
    }

    fn normalized(mut self) -> Self {
        self.poll_interval_secs = self.poll_interval_secs.clamp(20, 600);
        self.max_visible = self.max_visible.clamp(1, 5);
        if !is_hhmm(&self.quiet_hours.start) {
            self.quiet_hours.start = QuietHours::default().start;
        }
        if !is_hhmm(&self.quiet_hours.end) {
            self.quiet_hours.end = QuietHours::default().end;
        }
        self
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationItem {
    pub id: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub bug_id: String,
    pub title: String,
    pub kind: NotificationKind,
    pub owner: String,
    pub creator: String,
    pub severity: String,
    pub priority: String,
    pub created: String,
    pub detected_at: String,
    pub state: NotificationState,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SeenBug {
    pub status: String,
    pub owner: String,
    pub created: String,
    pub assigned_time: String,
    /// Notification kinds already emitted for this bug, used for de-duplication.
    pub kinds: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationStore {
    pub settings: NotificationSettings,
    pub items: Vec<NotificationItem>,
    pub seen: BTreeMap<String, SeenBug>,
    /// `workspaceId:bugId` keys the user ignored.
    pub ignored: Vec<String>,
    pub cursors: BTreeMap<String, String>,
    /// Workspace id -> baseline timestamp (`YYYY-MM-DD HH:MM:SS`).
    pub baseline_done: BTreeMap<String, String>,
}

impl Default for NotificationStore {
    fn default() -> Self {
        Self {
            settings: NotificationSettings::default(),
            items: Vec::new(),
            seen: BTreeMap::new(),
            ignored: Vec::new(),
            cursors: BTreeMap::new(),
            baseline_done: BTreeMap::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

pub fn bug_key(workspace_id: &str, bug_id: &str) -> String {
    format!("{}:{}", workspace_id.trim(), bug_id.trim())
}

/// De-duplication key for a single notification.
pub fn dedupe_key(workspace_id: &str, bug_id: &str, kind: NotificationKind) -> String {
    format!("{}:{}", bug_key(workspace_id, bug_id), kind.as_str())
}

pub fn scope_allows(scope: NotificationScope, owner: &str, me: &str) -> bool {
    match scope {
        NotificationScope::Project => true,
        NotificationScope::Mine => {
            let me = me.trim();
            !me.is_empty() && owner.trim() == me
        }
    }
}

pub fn parse_tapd_time(raw: &str) -> Option<NaiveDateTime> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M"))
        .ok()
}

pub fn format_tapd_time(time: NaiveDateTime) -> String {
    time.format("%Y-%m-%d %H:%M:%S").to_string()
}

fn is_recent(raw: &str, now: NaiveDateTime, minutes: i64) -> bool {
    let Some(time) = parse_tapd_time(raw) else {
        return false;
    };
    let delta = now - time;
    delta.num_minutes() <= minutes && delta.num_minutes() >= -1
}

fn assigned_recently(created: &str, assigned_time: &str, now: NaiveDateTime) -> bool {
    let Some(assigned) = parse_tapd_time(assigned_time) else {
        return false;
    };
    // "Assigned at creation time" means the bug was created for me, not transferred.
    if let Some(created) = parse_tapd_time(created) {
        if (assigned - created).num_seconds().abs() <= 60 {
            return false;
        }
    }
    let delta = now - assigned;
    delta.num_minutes() <= 10 && delta.num_minutes() >= -1
}

/// Status keys that mean "not started yet". Different TAPD projects use
/// different workflows: UU starts at `new`, 客服系统 starts at `open`.
pub const STARTING_STATUSES: &[&str] = &["new", "open", "reopened"];

/// Candidate "processing" targets, tried in order. `open` projects use
/// `progressing`; most projects use `in_progress`.
pub const TRANSITION_TARGETS: &[&str] = &["in_progress", "progressing"];

pub fn is_starting_status(status: &str) -> bool {
    let status = status.trim();
    STARTING_STATUSES
        .iter()
        .any(|candidate| *candidate == status)
}

/// Classifies a bug into a notification kind.
///
/// `open` is handled exactly like `new` (both are non-reopened starting
/// statuses), so it is still split into `new` vs `transferred` by creation and
/// assignment time.
///
/// `previous` is the last observed state for this bug (`None` = first sighting
/// after the baseline). `trust_recent_assignment` is true for `scope=mine`,
/// where a newly visible bug owned by me can be assumed to have just been
/// assigned even if `assigned_time` is unavailable. For `scope=project` the
/// caller looks up the detail first; without `assigned_time` we stay silent to
/// avoid notifying on every comment.
pub fn classify_bug(
    status: &str,
    owner: &str,
    created: &str,
    assigned_time: &str,
    previous: Option<&SeenBug>,
    me: &str,
    now: NaiveDateTime,
    trust_recent_assignment: bool,
) -> Option<NotificationKind> {
    let me = me.trim();
    if me.is_empty() {
        return None;
    }
    let status = status.trim();
    let owner = owner.trim();

    if let Some(previous) = previous {
        if status == "reopened" && previous.status.trim() != "reopened" {
            return Some(NotificationKind::Reopened);
        }
        if owner == me
            && previous.owner.trim() != me
            && !previous.kinds.iter().any(|kind| kind == "transferred")
        {
            return Some(NotificationKind::Transferred);
        }
        return None;
    }

    if status == "reopened" {
        return Some(NotificationKind::Reopened);
    }
    // `open` deliberately goes through the same new/transferred split as `new`.
    if is_recent(created, now, FRESH_WINDOW_MINUTES) {
        return Some(NotificationKind::New);
    }
    let recently_assigned = assigned_recently(created, assigned_time, now);
    let assumption = trust_recent_assignment
        && owner == me
        && assigned_time.trim().is_empty();
    if owner == me && (recently_assigned || assumption) {
        return Some(NotificationKind::Transferred);
    }

    None
}

fn parse_hhmm(raw: &str) -> Option<NaiveTime> {
    let (hour, minute) = raw.trim().split_once(':')?;
    let hour: u32 = hour.trim().parse().ok()?;
    let minute: u32 = minute.trim().parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    NaiveTime::from_hms_opt(hour, minute, 0)
}

pub fn is_hhmm(raw: &str) -> bool {
    parse_hhmm(raw).is_some()
}

pub fn quiet_hours_active(quiet: &QuietHours, now: NaiveTime) -> bool {
    if !quiet.enabled {
        return false;
    }
    let (Some(start), Some(end)) = (parse_hhmm(&quiet.start), parse_hhmm(&quiet.end)) else {
        return false;
    };
    if start == end {
        return false;
    }
    if start < end {
        now >= start && now < end
    } else {
        // Window crosses midnight, e.g. 22:00 -> 09:00.
        now >= start || now < end
    }
}

pub fn inline_owner_body(
    workspace_id: &str,
    bug_id: &str,
    me: &str,
    dsc_token: Option<&str>,
) -> Value {
    let mut body = json!({
        "data": {
            "field": "current_owner",
            "value": me,
            "id": bug_id,
            "field_name_is_alias": false
        },
        "workspace_id": workspace_id
    });
    attach_dsc(&mut body, dsc_token);
    body
}

pub fn kanban_transition_body(
    workspace_id: &str,
    bug_id: &str,
    current_status: &str,
    next_status: &str,
    dsc_token: Option<&str>,
) -> Value {
    let mut body = json!({
        "workspace_id": workspace_id,
        "entity_id": bug_id,
        "entity_type": "bug",
        "current_status": current_status,
        "next_status": next_status,
        "from": "",
        "fields": [],
        "is_manual": 1,
        "auto_complete": 0,
        "close_task": 0,
        "current_alias_status": "",
        "next_alias_status": "",
        "Timesheet": null,
        "check_required_fields": 1,
        "edit_rule_fields": []
    });
    attach_dsc(&mut body, dsc_token);
    body
}

pub fn workflow_transition_body(
    workspace_id: &str,
    bug_id: &str,
    current_status: &str,
    next_status: &str,
    dsc_token: Option<&str>,
) -> Value {
    let mut body = json!({
        "workspace_id": workspace_id,
        "entity_id": bug_id,
        "entity_type": "bug",
        "current_status": current_status,
        "next_status": next_status,
        "from": "",
        "fields": [],
        "is_manual": 1,
        "auto_complete": 0,
        "close_task": 0,
        "current_alias_status": "",
        "next_alias_status": "",
        "Timesheet": null
    });
    attach_dsc(&mut body, dsc_token);
    body
}

fn attach_dsc(body: &mut Value, dsc_token: Option<&str>) {
    if let Some(token) = dsc_token.map(str::trim).filter(|token| !token.is_empty()) {
        body["dsc_token"] = json!(token);
    }
}

/// Which TAPD endpoint a transition attempt goes through.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransitionApi {
    Kanban,
    Workflow,
}

impl TransitionApi {
    pub fn label(self) -> &'static str {
        match self {
            Self::Kanban => "kanban_aggregation/transition",
            Self::Workflow => "entity/workflow/transition",
        }
    }

    pub fn url(self) -> &'static str {
        match self {
            Self::Kanban => KANBAN_TRANSITION_URL,
            Self::Workflow => WORKFLOW_TRANSITION_URL,
        }
    }
}

#[derive(Clone, Debug)]
pub struct TransitionAttempt {
    pub api: TransitionApi,
    pub target: &'static str,
    pub body: Value,
}

/// Ordered attempts for moving a starting bug into processing:
/// kanban(in_progress, progressing) then workflow(in_progress, progressing).
///
/// Non-starting statuses (already processing / resolved / …) produce no
/// attempts: the accept action only reassigns those.
pub fn transition_attempts(
    workspace_id: &str,
    bug_id: &str,
    current_status: &str,
    dsc_token: Option<&str>,
) -> Vec<TransitionAttempt> {
    if !is_starting_status(current_status) {
        return Vec::new();
    }

    let mut attempts = Vec::with_capacity(TRANSITION_TARGETS.len() * 2);
    for target in TRANSITION_TARGETS {
        attempts.push(TransitionAttempt {
            api: TransitionApi::Kanban,
            target,
            body: kanban_transition_body(
                workspace_id,
                bug_id,
                current_status,
                target,
                dsc_token,
            ),
        });
    }
    for target in TRANSITION_TARGETS {
        attempts.push(TransitionAttempt {
            api: TransitionApi::Workflow,
            target,
            body: workflow_transition_body(
                workspace_id,
                bug_id,
                current_status,
                target,
                dsc_token,
            ),
        });
    }

    attempts
}

/// Returns the target of the first attempt whose outcome was `true`.
///
/// The accept flow records one outcome per attempted call (stopping at the
/// first success), which makes the endpoint/target fallback order explicit and
/// unit-testable without network access.
pub fn resolve_attempt_target(
    attempts: &[TransitionAttempt],
    outcomes: &[bool],
) -> Option<&'static str> {
    attempts
        .iter()
        .zip(outcomes.iter())
        .find(|(_, accepted)| **accepted)
        .map(|(attempt, _)| attempt.target)
}

/// TAPD answers write APIs with HTTP 200 even when `meta.code != 0`.
pub fn response_ok(root: &Value) -> bool {
    match root.pointer("/meta/code") {
        Some(Value::Number(code)) => code.as_i64() == Some(0),
        Some(Value::String(code)) => code.trim().is_empty() || code.trim() == "0",
        Some(Value::Null) | None => !root
            .get("error")
            .is_some_and(|error| !error.is_null() && error != &Value::Bool(false)),
        Some(_) => false,
    }
}

/// Extracts the workspace id from `https://www.tapd.cn/tapd_fe/<id>/...`.
pub fn workspace_from_session_url(raw: &str) -> Option<String> {
    let (_, rest) = raw.split_once("tapd_fe/")?;
    let segment = rest.split(['/', '?', '#']).next()?.trim();
    if !segment.is_empty() && segment.chars().all(|character| character.is_ascii_digit()) {
        Some(segment.to_string())
    } else {
        None
    }
}

fn api_message(root: &Value) -> String {
    root.pointer("/meta/message")
        .and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .unwrap_or("TAPD 返回失败")
        .to_string()
}

fn ensure_api_ok(root: &Value, action: &str) -> Result<(), String> {
    if response_ok(root) {
        return Ok(());
    }
    Err(format!("{action}失败：{}", api_message(root)))
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

struct NotificationService {
    app: AppHandle,
    state: SharedState,
    path: PathBuf,
    store: Mutex<NotificationStore>,
    workspace_names: Mutex<BTreeMap<String, String>>,
    /// First workspace returned by TAPD, used before the UI persists a choice.
    default_workspace: Mutex<Option<String>>,
    last_poll_at: Mutex<Option<String>>,
    last_error: Mutex<Option<String>>,
    running: AtomicBool,
    polling: AtomicBool,
    wake: tokio::sync::Notify,
}

impl NotificationService {
    fn settings(&self) -> NotificationSettings {
        self.store
            .lock()
            .expect("notification store lock")
            .settings
            .clone()
    }

    fn persist(&self) {
        let snapshot = self
            .store
            .lock()
            .expect("notification store lock")
            .clone();
        if let Err(error) = write_json_atomic(&self.path, &snapshot) {
            tracing::warn!(%error, "failed to persist notifications");
        }
    }

    fn workspace_name(&self, workspace_id: &str) -> String {
        self.workspace_names
            .lock()
            .expect("workspace names lock")
            .get(workspace_id)
            .cloned()
            .unwrap_or_else(|| workspace_id.to_string())
    }

    fn find_item(&self, id: &str) -> Result<NotificationItem, String> {
        self.store
            .lock()
            .expect("notification store lock")
            .items
            .iter()
            .rev()
            .find(|item| item.id == id)
            .cloned()
            .ok_or_else(|| "通知不存在或已被清理".to_string())
    }

    fn set_state(
        &self,
        id: &str,
        state: NotificationState,
    ) -> Result<NotificationItem, String> {
        let item = {
            let mut store = self.store.lock().expect("notification store lock");
            let item = store
                .items
                .iter_mut()
                .rev()
                .find(|item| item.id == id)
                .ok_or_else(|| "通知不存在或已被清理".to_string())?;
            item.state = state;
            item.clone()
        };
        self.persist();
        Ok(item)
    }

    fn push_item(&self, item: NotificationItem) {
        {
            let mut store = self.store.lock().expect("notification store lock");
            store.items.push(item);
            if store.items.len() > MAX_ITEMS {
                let excess = store.items.len() - MAX_ITEMS;
                store.items.drain(0..excess);
            }
        }
        self.persist();
    }

    fn pending_payload(&self) -> (Vec<NotificationItem>, bool) {
        let store = self.store.lock().expect("notification store lock");
        let max = store.settings.max_visible.max(1) as usize;
        let items: Vec<NotificationItem> = store
            .items
            .iter()
            .rev()
            .filter(|item| item.state == NotificationState::Pending)
            .take(max)
            .cloned()
            .collect();
        let quiet = quiet_hours_active(&store.settings.quiet_hours, Local::now().time());
        (items, quiet)
    }

    /// Emits the current pending list and lays the island out accordingly.
    ///
    /// The capsule is always visible (it doubles as the status indicator), so
    /// an empty list collapses the island instead of hiding it.
    fn refresh_window(&self) {
        let (items, quiet) = self.pending_payload();
        let _ = self.app.emit(
            "notification://show",
            json!({ "items": items, "quiet": quiet }),
        );

        apply_island(&self.app, !items.is_empty() && !quiet, items.len(), true);
    }

    async fn ensure_identity(&self, workspace_id: &str) -> Result<Option<String>, String> {
        let cached = self
            .state
            .config_snapshot()
            .me
            .map(|me| me.trim().to_string())
            .filter(|me| !me.is_empty());
        let names_known = self
            .workspace_names
            .lock()
            .expect("workspace names lock")
            .contains_key(workspace_id);

        if cached.is_some() && names_known {
            return Ok(cached);
        }

        let root = session_request_json(
            &self.app,
            "GET",
            &user_workspace_url(workspace_id),
            None,
            Duration::from_secs(30),
        )
        .await?;

        if let Ok(workspaces) = parse_workspaces(&root) {
            if let Some(first) = workspaces.first() {
                *self
                    .default_workspace
                    .lock()
                    .expect("default workspace lock") = Some(first.id.clone());
            }
            let mut names = self.workspace_names.lock().expect("workspace names lock");
            for workspace in workspaces {
                names.insert(workspace.id, workspace.name);
            }
        }

        let nick = root
            .pointer("/data/get_current_user_ret/data/user_nick")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();

        if !nick.is_empty() && cached.as_deref() != Some(nick.as_str()) {
            let snapshot = {
                let mut config = self.state.config.lock().expect("config lock");
                config.me = Some(nick.clone());
                config.clone()
            };
            if let Err(error) = self.state.save_config(&snapshot) {
                tracing::warn!(%error, "failed to persist current user");
            }
        }

        Ok(if nick.is_empty() { cached } else { Some(nick) })
    }

    async fn poll_once(self: &Arc<Self>) {
        if self.polling.swap(true, Ordering::SeqCst) {
            return;
        }

        let result = self.poll_inner().await;
        self.polling.store(false, Ordering::SeqCst);

        match result {
            Ok(()) => {
                *self.last_error.lock().expect("last error lock") = None;
                *self.last_poll_at.lock().expect("last poll lock") =
                    Some(Local::now().to_rfc3339());
            }
            Err(error) => {
                // Pollution of the error slot is intentional: the settings page
                // shows it, but we never raise dialogs from the poll loop.
                *self.last_error.lock().expect("last error lock") = Some(error.clone());
                tracing::debug!(%error, "notification poll failed");
            }
        }

        self.refresh_window();
    }

    async fn poll_inner(&self) -> Result<(), String> {
        let settings = self.settings();
        if !settings.enabled {
            return Ok(());
        }

        let config = self.state.config_snapshot();
        if !config.logged_in {
            return Ok(());
        }

        let mut workspace_id = config
            .last_workspace_id
            .clone()
            .unwrap_or_default()
            .trim()
            .to_string();
        if workspace_id.is_empty() {
            // The session watcher knows the last TAPD workspace page even
            // before the UI persists `lastWorkspaceId`.
            workspace_id = config
                .last_session_url
                .as_deref()
                .and_then(workspace_from_session_url)
                .unwrap_or_default();
        }
        if workspace_id.is_empty() {
            self.ensure_identity("0").await?;
            workspace_id = self
                .default_workspace
                .lock()
                .expect("default workspace lock")
                .clone()
                .unwrap_or_default();
        }
        if workspace_id.is_empty() {
            return Ok(());
        }

        let Some(me) = self.ensure_identity(&workspace_id).await? else {
            return Ok(());
        };
        if me.trim().is_empty() {
            return Ok(());
        }

        let now = Local::now().naive_local();
        let (baseline, cursor) = {
            let store = self.store.lock().expect("notification store lock");
            (
                !store.baseline_done.contains_key(&workspace_id),
                store.cursors.get(&workspace_id).cloned(),
            )
        };

        let modified_after = if baseline {
            None
        } else {
            let base = cursor
                .as_deref()
                .and_then(parse_tapd_time)
                .unwrap_or_else(|| now - ChronoDuration::minutes(10));
            Some(format_tapd_time(
                base - ChronoDuration::minutes(OVERLAP_MINUTES),
            ))
        };

        let mut query = BugQuery::new(&workspace_id);
        query.page = 1;
        query.perpage = POLL_PAGE_SIZE;
        query.modified_after = modified_after;
        if settings.scope == NotificationScope::Mine {
            query.owner = Some(me.clone());
        }

        let root = session_request_json(
            &self.app,
            "POST",
            &bug_list_url(),
            Some(query.body()),
            Duration::from_secs(60),
        )
        .await?;
        let page = parse_bug_list(&root)?;

        // For project scope a first-seen bug owned by me may just be an old bug
        // touched by a comment. Ask the detail once for `assigned_time`.
        let mut assigned_overrides: BTreeMap<String, String> = BTreeMap::new();
        if !baseline && settings.scope == NotificationScope::Project {
            let seen = self
                .store
                .lock()
                .expect("notification store lock")
                .seen
                .clone();
            let mut budget = MAX_DETAIL_LOOKUPS;
            for bug in &page.bugs {
                if budget == 0 {
                    break;
                }
                if bug.workspace_id.trim().is_empty() {
                    continue;
                }
                let key = bug_key(&bug.workspace_id, &bug.id);
                if seen.contains_key(&key)
                    || bug.status.trim() == "reopened"
                    || bug.owner.trim() != me
                    || !bug.assigned_time.trim().is_empty()
                    || is_recent(&bug.created, now, FRESH_WINDOW_MINUTES)
                {
                    continue;
                }
                budget -= 1;
                if let Ok(detail) = fetch_bug(&self.app, &bug.workspace_id, &bug.id).await {
                    if !detail.summary.assigned_time.trim().is_empty() {
                        assigned_overrides.insert(key, detail.summary.assigned_time);
                    }
                }
            }
        }

        let names = self
            .workspace_names
            .lock()
            .expect("workspace names lock")
            .clone();

        {
            let mut store = self.store.lock().expect("notification store lock");
            for bug in &page.bugs {
                if bug.workspace_id.trim().is_empty() || bug.id.trim().is_empty() {
                    continue;
                }
                let key = bug_key(&bug.workspace_id, &bug.id);
                let previous = store.seen.get(&key).cloned();
                let assigned_time = assigned_overrides
                    .get(&key)
                    .cloned()
                    .unwrap_or_else(|| bug.assigned_time.clone());
                let mut kinds = previous
                    .as_ref()
                    .map(|previous| previous.kinds.clone())
                    .unwrap_or_default();

                if baseline {
                    store.seen.insert(
                        key,
                        SeenBug {
                            status: bug.status.clone(),
                            owner: bug.owner.clone(),
                            created: bug.created.clone(),
                            assigned_time,
                            kinds,
                        },
                    );
                    continue;
                }

                let ignored = store.ignored.iter().any(|ignored| ignored == &key);
                let in_scope = scope_allows(settings.scope, &bug.owner, &me);
                let kind = if in_scope {
                    classify_bug(
                        &bug.status,
                        &bug.owner,
                        &bug.created,
                        &assigned_time,
                        previous.as_ref(),
                        &me,
                        now,
                        settings.scope == NotificationScope::Mine,
                    )
                } else {
                    None
                };

                if matches!(kind, Some(NotificationKind::Reopened)) {
                    // Reopening lifts an ignore.
                    store.ignored.retain(|ignored| ignored != &key);
                }

                let notify = match kind {
                    Some(kind) if settings.allows(kind) => {
                        let is_ignored_and_blocked =
                            ignored && kind != NotificationKind::Reopened;
                        let already_sent = already_notified(
                            &kinds,
                            &bug.workspace_id,
                            &bug.id,
                            kind,
                        );
                        if !is_ignored_and_blocked && !already_sent {
                            Some(kind)
                        } else {
                            None
                        }
                    }
                    _ => None,
                };

                if let Some(kind) = notify {
                    kinds.push(kind.as_str().to_string());
                    store.items.push(NotificationItem {
                        id: uuid::Uuid::new_v4().to_string(),
                        workspace_id: bug.workspace_id.clone(),
                        workspace_name: names
                            .get(&bug.workspace_id)
                            .cloned()
                            .unwrap_or_else(|| bug.workspace_id.clone()),
                        bug_id: bug.id.clone(),
                        title: bug.title.clone(),
                        kind,
                        owner: bug.owner.clone(),
                        creator: bug.creator.clone(),
                        severity: bug.severity_label.clone(),
                        priority: bug.priority_label.clone(),
                        created: bug.created.clone(),
                        detected_at: Local::now().to_rfc3339(),
                        state: NotificationState::Pending,
                    });
                }

                store.seen.insert(
                    key,
                    SeenBug {
                        status: bug.status.clone(),
                        owner: bug.owner.clone(),
                        created: bug.created.clone(),
                        assigned_time,
                        kinds,
                    },
                );
            }

            if baseline {
                store
                    .baseline_done
                    .insert(workspace_id.clone(), format_tapd_time(now));
            }
            store
                .cursors
                .insert(workspace_id.clone(), format_tapd_time(now));
            if store.items.len() > MAX_ITEMS {
                let excess = store.items.len() - MAX_ITEMS;
                store.items.drain(0..excess);
            }
        }

        self.persist();
        Ok(())
    }
}

/// Whether this `(workspace, bug, kind)` de-dup key was already emitted.
fn already_notified(
    kinds: &[String],
    workspace_id: &str,
    bug_id: &str,
    kind: NotificationKind,
) -> bool {
    let target = dedupe_key(workspace_id, bug_id, kind);
    kinds
        .iter()
        .filter_map(|sent| NotificationKind::parse(sent))
        .any(|sent| dedupe_key(workspace_id, bug_id, sent) == target)
}

fn service() -> Result<Arc<NotificationService>, String> {
    SERVICE
        .get()
        .cloned()
        .ok_or_else(|| "通知服务尚未初始化".to_string())
}

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

const PILL_WIDTH: f64 = 210.0;
const PILL_HEIGHT: f64 = 34.0;
const CARD_WIDTH: f64 = 384.0;
const CARD_BASE_HEIGHT: f64 = 150.0;
const CARD_ROW_HEIGHT: f64 = 112.0;
const ISLAND_TOP_MARGIN: f64 = 6.0;

/// Bumped on every layout change so a superseded animation stops early.
static LAYOUT_SEQ: AtomicU64 = AtomicU64::new(0);

fn ensure_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        return Ok(window);
    }

    let window = WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("TAPD Client")
    .inner_size(PILL_WIDTH, PILL_HEIGHT)
    .resizable(false)
    // Transparent, chrome-less window: the capsule/card is drawn by CSS.
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .visible(false)
    .build()
    .map_err(|error| error.to_string())?;

    let window_for_event = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window_for_event.hide();
        }
    });

    Ok(window)
}

fn monitor_for(app: &AppHandle) -> Option<tauri::Monitor> {
    app.get_webview_window("main")
        .and_then(|window| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
}

fn island_size(expanded: bool, count: usize) -> (f64, f64) {
    if !expanded {
        return (PILL_WIDTH, PILL_HEIGHT);
    }
    let rows = count.clamp(1, 5) as f64;
    (CARD_WIDTH, CARD_BASE_HEIGHT + (rows - 1.0) * CARD_ROW_HEIGHT)
}

/// Top-centre rectangle (physical pixels) for a logical island size.
fn island_rect(app: &AppHandle, width: f64, height: f64) -> Option<(i32, i32, u32, u32)> {
    let monitor = monitor_for(app)?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let w = (width * scale).round().max(1.0) as u32;
    let h = (height * scale).round().max(1.0) as u32;
    let x = area.position.x + (area.size.width as i32 - w as i32).max(0) / 2;
    let y = area.position.y + (ISLAND_TOP_MARGIN * scale).round() as i32;
    Some((x, y, w, h))
}

fn lerp(from: f64, to: f64, t: f64) -> f64 {
    from + (to - from) * t
}

/// Places the island at the top centre of the screen. `animated` interpolates
/// the resize so the card grows out of the capsule (Dynamic Island style).
fn apply_island(app: &AppHandle, expanded: bool, count: usize, animated: bool) {
    let (width, height) = island_size(expanded, count);
    let Some((x, y, w, h)) = island_rect(app, width, height) else {
        return;
    };
    let Ok(window) = ensure_window(app) else {
        return;
    };

    let _ = window.set_always_on_top(true);
    let _ = window.show();

    if !animated {
        let _ = window.set_size(PhysicalSize::new(w, h));
        let _ = window.set_position(PhysicalPosition::new(x, y));
    } else {
        let sequence = LAYOUT_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
        let window_for_animation = window.clone();
        tauri::async_runtime::spawn(async move {
            let Ok(start_size) = window_for_animation.outer_size() else {
                return;
            };
            let Ok(start_pos) = window_for_animation.outer_position() else {
                return;
            };

            const STEPS: u32 = 11;
            for step in 1..=STEPS {
                if LAYOUT_SEQ.load(Ordering::SeqCst) != sequence {
                    // A newer layout superseded this animation.
                    return;
                }
                let t = step as f64 / STEPS as f64;
                let eased = 1.0 - (1.0 - t).powi(3);
                let next_w = lerp(start_size.width as f64, w as f64, eased).round() as u32;
                let next_h = lerp(start_size.height as f64, h as f64, eased).round() as u32;
                let next_x = lerp(start_pos.x as f64, x as f64, eased).round() as i32;
                let next_y = lerp(start_pos.y as f64, y as f64, eased).round() as i32;
                let _ = window_for_animation.set_size(PhysicalSize::new(next_w, next_h));
                let _ = window_for_animation.set_position(PhysicalPosition::new(next_x, next_y));
                tokio::time::sleep(Duration::from_millis(14)).await;
            }
        });
    }

    let _ = app.emit(
        "island://layout",
        json!({
            "expanded": expanded,
            "width": width,
            "height": height,
            "count": count,
        }),
    );
}

/// Brings the main window to the front (capsule click without pending items).
fn focus_main_window(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

// ---------------------------------------------------------------------------
// Init / polling loop
// ---------------------------------------------------------------------------

pub fn init(app: &AppHandle, state: SharedState) {
    let path = state.paths.data_dir.join(STORE_FILE);
    let store: NotificationStore = read_json(&path).unwrap_or_default();
    let store = NotificationStore {
        settings: store.settings.normalized(),
        ..store
    };

    let service = Arc::new(NotificationService {
        app: app.clone(),
        state,
        path,
        store: Mutex::new(store),
        workspace_names: Mutex::new(BTreeMap::new()),
        default_workspace: Mutex::new(None),
        last_poll_at: Mutex::new(None),
        last_error: Mutex::new(None),
        running: AtomicBool::new(true),
        polling: AtomicBool::new(false),
        wake: tokio::sync::Notify::new(),
    });

    if SERVICE.set(service.clone()).is_err() {
        return;
    }

    // Let the notification webview pick up a previous pending list on launch.
    service.refresh_window();

    tauri::async_runtime::spawn(async move {
        // Give the hidden session webview time to finish its startup
        // navigation, otherwise the first poll can race the bridge.
        tokio::time::sleep(Duration::from_secs(4)).await;

        loop {
            let settings = service.settings();
            if settings.enabled {
                service.poll_once().await;
            }

            let interval = service.settings().poll_interval_secs.clamp(20, 600);
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(interval)) => {}
                _ = service.wake.notified() => {}
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Tauri feature commands
// ---------------------------------------------------------------------------

pub async fn command(
    app: &AppHandle,
    state: &SharedState,
    name: &str,
    payload: Value,
) -> Result<Value, String> {
    match name {
        "notification_settings_get" => {
            let service = service()?;
            Ok(json!({ "settings": service.settings() }))
        }
        "notification_settings_set" => {
            let service = service()?;
            let settings = apply_settings_patch(&service, &payload)?;
            service.persist();
            service.wake.notify_waiters();
            service.refresh_window();
            Ok(json!({ "settings": settings }))
        }
        "notification_state_get" => {
            let service = service()?;
            state_snapshot(&service)
        }
        "notification_history" => {
            let service = service()?;
            let store = service.store.lock().expect("notification store lock");
            let items: Vec<NotificationItem> = store
                .items
                .iter()
                .rev()
                .take(MAX_HISTORY)
                .cloned()
                .collect();
            Ok(json!({ "items": items }))
        }
        "notification_handle" => {
            let service = service()?;
            let id = payload_str(&payload, "notificationId")?;
            handle_notification(app, state, &service, &id).await
        }
        "notification_view" => {
            let service = service()?;
            let id = payload_str(&payload, "notificationId")?;
            view_notification(app, &service, &id)
        }
        "notification_ignore" => {
            let service = service()?;
            let id = payload_str(&payload, "notificationId")?;
            ignore_notification(&service, &id)
        }
        "notification_accept_preview" => {
            let service = service()?;
            let id = payload_str(&payload, "notificationId")?;
            preview_accept(app, state, &service, &id).await
        }
        "notification_island_expand" => {
            let service = service()?;
            let expanded = payload
                .get("expanded")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let (items, _quiet) = service.pending_payload();
            let expanded = expanded && !items.is_empty();
            apply_island(app, expanded, items.len(), true);
            Ok(json!({ "ok": true, "expanded": expanded, "count": items.len() }))
        }
        "notification_open_main" => {
            focus_main_window(app);
            Ok(json!({ "ok": true }))
        }
        "notification_simulate" => {
            let service = service()?;
            simulate_notification(state, &service, &payload)
        }
        other => Err(format!("unknown notification command: {other}")),
    }
}

fn state_snapshot(service: &NotificationService) -> Result<Value, String> {
    let store = service.store.lock().expect("notification store lock");
    let items: Vec<NotificationItem> = store
        .items
        .iter()
        .rev()
        .take(MAX_HISTORY)
        .cloned()
        .collect();

    Ok(json!({
        "items": items,
        "settings": store.settings,
        "running": service.running.load(Ordering::SeqCst) && store.settings.enabled,
        "lastPollAt": service.last_poll_at.lock().expect("last poll lock").clone(),
        "lastError": service.last_error.lock().expect("last error lock").clone(),
    }))
}

fn view_notification(
    app: &AppHandle,
    service: &NotificationService,
    id: &str,
) -> Result<Value, String> {
    let item = service.find_item(id)?;
    service.set_state(id, NotificationState::Viewed)?;

    focus_main_window(app);

    // Simulated cards have no real bug to open; just bring the main window up.
    let simulated =
        item.workspace_id == "simulated" || item.bug_id.starts_with("simulated-");
    if !simulated {
        let _ = app.emit(
            "notification://open-bug",
            json!({ "workspaceId": item.workspace_id, "bugId": item.bug_id }),
        );
    }

    service.refresh_window();
    Ok(json!({ "ok": true, "item": item }))
}

fn ignore_notification(service: &NotificationService, id: &str) -> Result<Value, String> {
    let item = service.find_item(id)?;
    {
        let mut store = service.store.lock().expect("notification store lock");
        let key = bug_key(&item.workspace_id, &item.bug_id);
        if !store.ignored.iter().any(|ignored| ignored == &key) {
            store.ignored.push(key);
        }
    }
    let item = service.set_state(id, NotificationState::Ignored)?;
    service.refresh_window();
    Ok(json!({ "ok": true, "item": item }))
}

fn simulate_notification(
    state: &SharedState,
    service: &NotificationService,
    payload: &Value,
) -> Result<Value, String> {
    let config = state.config_snapshot();
    let workspace_id = config
        .last_workspace_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| "simulated".to_string());
    let workspace_name = if workspace_id == "simulated" {
        "模拟项目".to_string()
    } else {
        service.workspace_name(&workspace_id)
    };
    let kind = payload
        .get("kind")
        .and_then(Value::as_str)
        .and_then(NotificationKind::parse)
        .unwrap_or(NotificationKind::New);
    let bug_id = payload
        .get("bugId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("simulated-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]));
    let title = payload
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .unwrap_or("【模拟】新缺陷通知")
        .to_string();

    let item = NotificationItem {
        id: uuid::Uuid::new_v4().to_string(),
        workspace_id,
        workspace_name,
        bug_id,
        title,
        kind,
        owner: config.me.unwrap_or_else(|| "我".to_string()),
        creator: "模拟用户".to_string(),
        severity: "严重".to_string(),
        priority: "高".to_string(),
        created: format_tapd_time(Local::now().naive_local()),
        detected_at: Local::now().to_rfc3339(),
        state: NotificationState::Pending,
    };

    service.push_item(item.clone());
    service.refresh_window();
    Ok(json!({ "ok": true, "item": item }))
}

// ---------------------------------------------------------------------------
// Accept ("处理") flow
// ---------------------------------------------------------------------------

struct AcceptPlan {
    me: String,
    owner: String,
    status: String,
    assigned: bool,
    /// Current status is a starting status (`new` / `open` / `reopened`), so we
    /// should try to move it into processing after (or alongside) reassigning.
    starting: bool,
    dsc_present: bool,
    inline_body: Value,
    transition_attempts: Vec<TransitionAttempt>,
}

async fn build_accept_plan(
    app: &AppHandle,
    state: &SharedState,
    item: &NotificationItem,
) -> Result<AcceptPlan, String> {
    let me = resolve_me(app, state, &item.workspace_id).await?;
    if me.trim().is_empty() {
        return Err("无法确定当前 TAPD 用户，请先在设置页刷新账户信息".to_string());
    }

    let root = session_request_json(
        app,
        "POST",
        &bug_detail_url(),
        Some(bug_detail_body(&item.workspace_id, &item.bug_id)),
        Duration::from_secs(45),
    )
    .await?;
    let detail = parse_bug_detail(&root)?;
    let owner = detail.summary.owner.trim().to_string();
    let status = detail.summary.status.trim().to_string();

    let dsc_token = app
        .get_webview_window(session::SESSION_LABEL)
        .and_then(|window| session::cookie_value(&window, "dsc-token"));
    let dsc_present = dsc_token
        .as_deref()
        .map(|token| !token.trim().is_empty())
        .unwrap_or(false);
    let dsc = dsc_token.as_deref();

    let assigned = owner != me.trim();
    let starting = is_starting_status(&status);

    Ok(AcceptPlan {
        inline_body: inline_owner_body(&item.workspace_id, &item.bug_id, &me, dsc),
        transition_attempts: transition_attempts(
            &item.workspace_id,
            &item.bug_id,
            &status,
            dsc,
        ),
        me,
        owner,
        status,
        assigned,
        starting,
        dsc_present,
    })
}

async fn resolve_me(
    app: &AppHandle,
    state: &SharedState,
    workspace_id: &str,
) -> Result<String, String> {
    if let Some(me) = state
        .config_snapshot()
        .me
        .map(|me| me.trim().to_string())
        .filter(|me| !me.is_empty())
    {
        return Ok(me);
    }

    let root = session_request_json(
        app,
        "GET",
        &user_workspace_url(workspace_id),
        None,
        Duration::from_secs(30),
    )
    .await?;
    let nick = root
        .pointer("/data/get_current_user_ret/data/user_nick")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if nick.is_empty() {
        return Ok(nick);
    }

    let snapshot = {
        let mut config = state.config.lock().expect("config lock");
        config.me = Some(nick.clone());
        config.clone()
    };
    state.save_config(&snapshot).map_err(|error| error.to_string())?;
    Ok(nick)
}

async fn fetch_bug(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
) -> Result<tapd_core::tapd::model::BugDetail, String> {
    let root = session_request_json(
        app,
        "POST",
        &bug_detail_url(),
        Some(bug_detail_body(workspace_id, bug_id)),
        Duration::from_secs(45),
    )
    .await?;
    parse_bug_detail(&root)
}

async fn handle_notification(
    app: &AppHandle,
    state: &SharedState,
    service: &NotificationService,
    id: &str,
) -> Result<Value, String> {
    let item = service.find_item(id)?;
    if item.state == NotificationState::Handled {
        return Err("该通知已处理".to_string());
    }
    if item.workspace_id == "simulated" || item.bug_id.starts_with("simulated-") {
        return Err("模拟通知不能执行处理，请用真实缺陷验证".to_string());
    }

    let plan = build_accept_plan(app, state, &item).await?;

    if plan.assigned {
        let response = session_request_json(
            app,
            "POST",
            INLINE_UPDATE_URL,
            Some(plan.inline_body.clone()),
            Duration::from_secs(45),
        )
        .await
        .map_err(|error| format!("改派处理人失败：{error}"))?;
        ensure_api_ok(&response, "改派处理人")?;
    }

    // Starting statuses (`new` / `open` / `reopened`) move into processing.
    // Different projects name the processing status differently, so try the
    // kanban endpoint with each candidate, then the workflow endpoint with the
    // same candidates. Stop at the first accepted write.
    let mut transition_target: Option<String> = None;
    if plan.starting {
        let mut outcomes: Vec<bool> = Vec::with_capacity(plan.transition_attempts.len());
        let mut last_error: Option<String> = None;

        for attempt in &plan.transition_attempts {
            let result = session_request_json(
                app,
                "POST",
                attempt.api.url(),
                Some(attempt.body.clone()),
                Duration::from_secs(45),
            )
            .await;

            let accepted = match result {
                Ok(response) => {
                    let ok = response_ok(&response);
                    if ok {
                        tracing::info!(
                            bug_id = %item.bug_id,
                            api = attempt.api.label(),
                            target = attempt.target,
                            "bug transitioned out of starting status"
                        );
                    } else {
                        last_error = Some(format!(
                            "{} 流转到 {} 被拒绝：{}",
                            attempt.api.label(),
                            attempt.target,
                            api_message(&response)
                        ));
                    }
                    ok
                }
                Err(error) => {
                    last_error = Some(format!(
                        "{} 流转到 {} 失败：{}",
                        attempt.api.label(),
                        attempt.target,
                        error
                    ));
                    false
                }
            };

            outcomes.push(accepted);
            if accepted {
                break;
            }
        }

        match resolve_attempt_target(&plan.transition_attempts, &outcomes) {
            Some(target) => transition_target = Some(target.to_string()),
            None => {
                return Err(last_error.unwrap_or_else(|| {
                    "状态流转失败：所有候选目标均未成功".to_string()
                }));
            }
        }
    }
    let transitioned = transition_target.is_some();

    service.set_state(id, NotificationState::Handled)?;

    let _ = app.emit(
        "agent://enqueue",
        json!({
            "workspaceId": item.workspace_id,
            "bugId": item.bug_id,
            "title": item.title,
            "workspaceName": item.workspace_name,
            "source": "notification"
        }),
    );
    let _ = app.emit("data://refresh", ());
    service.refresh_window();

    let status = transition_target
        .clone()
        .unwrap_or_else(|| plan.status.clone());

    Ok(json!({
        "ok": true,
        "owner": plan.me,
        "status": status,
        "assigned": plan.assigned,
        "transitioned": transitioned
    }))
}

async fn preview_accept(
    app: &AppHandle,
    state: &SharedState,
    service: &NotificationService,
    id: &str,
) -> Result<Value, String> {
    let item = service.find_item(id)?;
    if item.workspace_id == "simulated" || item.bug_id.starts_with("simulated-") {
        return Err("模拟通知没有可预览的请求体".to_string());
    }

    let plan = build_accept_plan(app, state, &item).await?;
    let first_target = TRANSITION_TARGETS.first().copied().unwrap_or("in_progress");
    let next_status = if plan.starting {
        first_target
    } else {
        plan.status.as_str()
    };
    // Rebuild the attempts without the token so the renderer never sees it.
    let preview_attempts =
        transition_attempts(&item.workspace_id, &item.bug_id, &plan.status, None);
    let preview_attempts: Vec<Value> = preview_attempts
        .iter()
        .map(|attempt| {
            json!({
                "api": attempt.api.label(),
                "target": attempt.target,
                "body": attempt.body
            })
        })
        .collect();

    Ok(json!({
        "item": item,
        "me": plan.me,
        "currentOwner": plan.owner,
        "currentStatus": plan.status,
        "assigned": plan.assigned,
        "transitioned": plan.starting,
        "startingStatus": plan.starting,
        "nextStatus": next_status,
        "transitionTargets": TRANSITION_TARGETS,
        "transitionAttempts": preview_attempts,
        "dscTokenPresent": plan.dsc_present,
        "bodies": {
            "inlineUpdate": inline_owner_body(&item.workspace_id, &item.bug_id, &plan.me, None),
            "kanbanTransition": kanban_transition_body(
                &item.workspace_id,
                &item.bug_id,
                &plan.status,
                first_target,
                None
            ),
            "workflowTransition": workflow_transition_body(
                &item.workspace_id,
                &item.bug_id,
                &plan.status,
                first_target,
                None
            )
        }
    }))
}

// ---------------------------------------------------------------------------
// Settings patch handling
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct QuietHoursPatch {
    enabled: Option<bool>,
    start: Option<String>,
    end: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SettingsPatch {
    enabled: Option<bool>,
    scope: Option<NotificationScope>,
    include_new: Option<bool>,
    include_transferred: Option<bool>,
    include_reopened: Option<bool>,
    poll_interval_secs: Option<u64>,
    quiet_hours: Option<QuietHoursPatch>,
    max_visible: Option<u32>,
}

fn apply_settings_patch(
    service: &NotificationService,
    payload: &Value,
) -> Result<NotificationSettings, String> {
    let patch_value = payload.get("settings").cloned().unwrap_or_else(|| payload.clone());
    let patch: SettingsPatch = serde_json::from_value(patch_value)
        .map_err(|error| format!("通知设置格式不正确：{error}"))?;

    let mut settings = service.settings();
    if let Some(enabled) = patch.enabled {
        settings.enabled = enabled;
    }
    if let Some(scope) = patch.scope {
        settings.scope = scope;
    }
    if let Some(value) = patch.include_new {
        settings.include_new = value;
    }
    if let Some(value) = patch.include_transferred {
        settings.include_transferred = value;
    }
    if let Some(value) = patch.include_reopened {
        settings.include_reopened = value;
    }
    if let Some(value) = patch.poll_interval_secs {
        settings.poll_interval_secs = value;
    }
    if let Some(value) = patch.max_visible {
        settings.max_visible = value;
    }
    if let Some(quiet) = patch.quiet_hours {
        if let Some(enabled) = quiet.enabled {
            settings.quiet_hours.enabled = enabled;
        }
        if let Some(start) = quiet.start {
            if !is_hhmm(&start) {
                return Err("免打扰开始时间格式应为 HH:MM".to_string());
            }
            settings.quiet_hours.start = start;
        }
        if let Some(end) = quiet.end {
            if !is_hhmm(&end) {
                return Err("免打扰结束时间格式应为 HH:MM".to_string());
            }
            settings.quiet_hours.end = end;
        }
    }

    let settings = settings.normalized();
    {
        let mut store = service.store.lock().expect("notification store lock");
        store.settings = settings.clone();
    }
    Ok(settings)
}

fn payload_str(payload: &Value, key: &str) -> Result<String, String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("缺少参数 {key}"))
}

// ---------------------------------------------------------------------------
// Tests — pure business rules only (no TAPD calls).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn at(hour: u32, minute: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 11, 10)
            .expect("date")
            .and_hms_opt(hour, minute, 0)
            .expect("time")
    }

    fn seen(status: &str, owner: &str, kinds: &[&str]) -> SeenBug {
        SeenBug {
            status: status.to_string(),
            owner: owner.to_string(),
            created: "2026-11-09 09:00:00".to_string(),
            assigned_time: String::new(),
            kinds: kinds.iter().map(|kind| kind.to_string()).collect(),
        }
    }

    #[test]
    fn fresh_created_bug_is_new() {
        let kind = classify_bug(
            "new",
            "何帅",
            "2026-11-10 11:58:00",
            "",
            None,
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(kind, Some(NotificationKind::New));
    }

    #[test]
    fn old_bug_first_seen_for_me_is_transferred() {
        let kind = classify_bug(
            "in_progress",
            "何帅",
            "2026-11-01 09:00:00",
            "",
            None,
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(kind, Some(NotificationKind::Transferred));
    }

    #[test]
    fn recent_assignment_wins_over_creation_time() {
        let kind = classify_bug(
            "in_progress",
            "何帅",
            "2026-11-01 09:00:00",
            "2026-11-10 11:57:00",
            None,
            "何帅",
            at(12, 0),
            false,
        );
        assert_eq!(kind, Some(NotificationKind::Transferred));
    }

    #[test]
    fn project_scope_needs_evidence_for_transfer() {
        let kind = classify_bug(
            "in_progress",
            "何帅",
            "2026-11-01 09:00:00",
            "",
            None,
            "何帅",
            at(12, 0),
            false,
        );
        assert_eq!(kind, None);
    }

    #[test]
    fn owner_change_on_known_bug_is_transferred() {
        let previous = seen("in_progress", "郭俊宏", &["new"]);
        let kind = classify_bug(
            "in_progress",
            "何帅",
            "2026-11-09 09:00:00",
            "",
            Some(&previous),
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(kind, Some(NotificationKind::Transferred));
    }

    #[test]
    fn comment_only_change_is_not_a_notification() {
        let previous = seen("in_progress", "何帅", &["new"]);
        let kind = classify_bug(
            "in_progress",
            "何帅",
            "2026-11-09 09:00:00",
            "",
            Some(&previous),
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(kind, None);
    }

    #[test]
    fn reopened_status_wins_over_everything() {
        let previous = seen("resolved", "何帅", &["new"]);
        let kind = classify_bug(
            "reopened",
            "何帅",
            "2026-11-01 09:00:00",
            "",
            Some(&previous),
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(kind, Some(NotificationKind::Reopened));
    }

    #[test]
    fn first_sighting_of_reopened_bug_is_reopened() {
        let kind = classify_bug(
            "reopened",
            "郭俊宏",
            "2026-11-01 09:00:00",
            "",
            None,
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(kind, Some(NotificationKind::Reopened));
    }

    #[test]
    fn starting_statuses_cover_open_and_new() {
        for status in ["new", "open", "reopened"] {
            assert!(is_starting_status(status), "{status} should be starting");
        }
        for status in [
            "in_progress",
            "progressing",
            "resolved",
            "verified",
            "closed",
            "rejected",
        ] {
            assert!(!is_starting_status(status), "{status} should not be starting");
        }
    }

    #[test]
    fn open_is_classified_like_new() {
        // A fresh `open` bug is a new notification.
        let fresh = classify_bug(
            "open",
            "何帅",
            "2026-11-10 11:58:00",
            "",
            None,
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(fresh, Some(NotificationKind::New));

        // An old `open` bug that just appeared for me is a transfer.
        let transferred = classify_bug(
            "open",
            "何帅",
            "2026-11-01 09:00:00",
            "",
            None,
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(transferred, Some(NotificationKind::Transferred));

        // Someone else's old `open` bug is not mine to notify in mine scope.
        let not_mine = classify_bug(
            "open",
            "郭俊宏",
            "2026-11-01 09:00:00",
            "",
            None,
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(not_mine, None);
    }

    #[test]
    fn open_transition_prefers_progressing_after_in_progress() {
        let attempts = transition_attempts("45336192", "1010606", "open", None);
        assert_eq!(attempts.len(), 4);

        assert_eq!(attempts[0].api, TransitionApi::Kanban);
        assert_eq!(attempts[0].target, "in_progress");
        assert_eq!(attempts[0].body["current_status"], "open");
        assert_eq!(attempts[0].body["next_status"], "in_progress");

        assert_eq!(attempts[1].api, TransitionApi::Kanban);
        assert_eq!(attempts[1].target, "progressing");
        assert_eq!(attempts[1].body["next_status"], "progressing");

        assert_eq!(attempts[2].api, TransitionApi::Workflow);
        assert_eq!(attempts[2].target, "in_progress");
        assert_eq!(attempts[3].api, TransitionApi::Workflow);
        assert_eq!(attempts[3].target, "progressing");

        // 客服系统 rejects `in_progress` and accepts `progressing`.
        assert_eq!(
            resolve_attempt_target(&attempts, &[false, true]),
            Some("progressing")
        );
    }

    #[test]
    fn new_transition_starts_with_in_progress() {
        let attempts = transition_attempts("45336192", "1010606", "new", None);
        assert_eq!(attempts[0].api, TransitionApi::Kanban);
        assert_eq!(attempts[0].target, "in_progress");
        assert_eq!(attempts[0].body["current_status"], "new");
        assert_eq!(
            resolve_attempt_target(&attempts, &[true]),
            Some("in_progress")
        );
    }

    #[test]
    fn transition_falls_back_to_workflow_for_both_targets() {
        let attempts = transition_attempts("45336192", "1010606", "open", None);
        assert_eq!(
            resolve_attempt_target(&attempts, &[false, false, true]),
            Some("in_progress")
        );
        assert_eq!(
            resolve_attempt_target(&attempts, &[false, false, false, true]),
            Some("progressing")
        );
        assert_eq!(
            resolve_attempt_target(&attempts, &[false, false, false, false]),
            None
        );
        assert_eq!(resolve_attempt_target(&attempts, &[]), None);
    }

    #[test]
    fn non_starting_status_skips_transition() {
        for status in [
            "in_progress",
            "progressing",
            "resolved",
            "verified",
            "closed",
            "rejected",
        ] {
            assert!(
                transition_attempts("45336192", "1010606", status, None).is_empty(),
                "{status} should only be reassigned"
            );
        }
    }

    #[test]
    fn missing_me_disables_classification() {
        let kind = classify_bug(
            "new",
            "",
            "2026-11-10 11:59:00",
            "",
            None,
            "  ",
            at(12, 0),
            true,
        );
        assert_eq!(kind, None);
    }

    #[test]
    fn scope_filter_matches_owner() {
        assert!(scope_allows(NotificationScope::Mine, "何帅", "何帅"));
        assert!(!scope_allows(NotificationScope::Mine, "郭俊宏", "何帅"));
        assert!(scope_allows(NotificationScope::Project, "郭俊宏", "何帅"));
    }

    #[test]
    fn dedupe_key_includes_kind() {
        assert_eq!(
            dedupe_key("45336192", "1010606", NotificationKind::New),
            "45336192:1010606:new"
        );
        assert_ne!(
            dedupe_key("45336192", "1010606", NotificationKind::New),
            dedupe_key("45336192", "1010606", NotificationKind::Reopened)
        );
        assert_eq!(bug_key(" 45336192 ", " 1 "), "45336192:1");
    }

    #[test]
    fn quiet_hours_cross_midnight() {
        let quiet = QuietHours {
            enabled: true,
            start: "22:00".to_string(),
            end: "09:00".to_string(),
        };
        assert!(quiet_hours_active(&quiet, NaiveTime::from_hms_opt(23, 0, 0).unwrap()));
        assert!(quiet_hours_active(&quiet, NaiveTime::from_hms_opt(8, 59, 0).unwrap()));
        assert!(!quiet_hours_active(&quiet, NaiveTime::from_hms_opt(9, 0, 0).unwrap()));
        assert!(!quiet_hours_active(&quiet, NaiveTime::from_hms_opt(12, 0, 0).unwrap()));
    }

    #[test]
    fn quiet_hours_within_day_and_disabled() {
        let quiet = QuietHours {
            enabled: true,
            start: "12:00".to_string(),
            end: "13:30".to_string(),
        };
        assert!(quiet_hours_active(&quiet, NaiveTime::from_hms_opt(13, 0, 0).unwrap()));
        assert!(!quiet_hours_active(&quiet, NaiveTime::from_hms_opt(13, 30, 0).unwrap()));

        let disabled = QuietHours {
            enabled: false,
            ..quiet
        };
        assert!(!quiet_hours_active(&disabled, NaiveTime::from_hms_opt(13, 0, 0).unwrap()));
    }

    #[test]
    fn inline_update_body_shape() {
        let body = inline_owner_body("45336192", "1010606", "何帅", Some("token"));
        assert_eq!(body["data"]["field"], "current_owner");
        assert_eq!(body["data"]["value"], "何帅");
        assert_eq!(body["data"]["id"], "1010606");
        assert_eq!(body["data"]["field_name_is_alias"], false);
        assert_eq!(body["workspace_id"], "45336192");
        assert_eq!(body["dsc_token"], "token");

        let without = inline_owner_body("45336192", "1010606", "何帅", Some("  "));
        assert!(without.get("dsc_token").is_none());
    }

    #[test]
    fn kanban_transition_body_shape() {
        let body = kanban_transition_body("45336192", "1010606", "new", "in_progress", None);
        assert_eq!(body["entity_type"], "bug");
        assert_eq!(body["current_status"], "new");
        assert_eq!(body["next_status"], "in_progress");
        assert_eq!(body["check_required_fields"], 1);
        assert_eq!(body["edit_rule_fields"], json!([]));
        assert_eq!(body["Timesheet"], Value::Null);
        assert!(body.get("dsc_token").is_none());
    }

    #[test]
    fn workflow_transition_omits_required_field_flags() {
        let body = workflow_transition_body("45336192", "1010606", "reopened", "in_progress", Some("t"));
        assert!(body.get("check_required_fields").is_none());
        assert!(body.get("edit_rule_fields").is_none());
        assert_eq!(body["dsc_token"], "t");
    }

    #[test]
    fn response_ok_understands_meta_codes() {
        assert!(response_ok(&json!({ "meta": { "code": 0 } })));
        assert!(response_ok(&json!({ "meta": { "code": "0" } })));
        assert!(response_ok(&json!({ "data": {} })));
        assert!(!response_ok(&json!({ "meta": { "code": 1, "message": "no" } })));
        assert!(!response_ok(&json!({ "meta": { "code": "1" } })));
    }

    #[test]
    fn settings_are_clamped() {
        let settings = NotificationSettings {
            poll_interval_secs: 5,
            max_visible: 42,
            ..NotificationSettings::default()
        }
        .normalized();
        assert_eq!(settings.poll_interval_secs, 20);
        assert_eq!(settings.max_visible, 5);

        let settings = NotificationSettings {
            poll_interval_secs: 5000,
            max_visible: 0,
            ..NotificationSettings::default()
        }
        .normalized();
        assert_eq!(settings.poll_interval_secs, 600);
        assert_eq!(settings.max_visible, 1);
    }

    #[test]
    fn extracts_workspace_from_session_url() {
        assert_eq!(
            workspace_from_session_url("https://www.tapd.cn/tapd_fe/45336192/bug/list"),
            Some("45336192".to_string())
        );
        assert_eq!(
            workspace_from_session_url("https://www.tapd.cn/tapd_fe/123/my/work?x=1"),
            Some("123".to_string())
        );
        assert_eq!(workspace_from_session_url("https://www.tapd.cn/login"), None);
        assert_eq!(workspace_from_session_url("https://www.tapd.cn/tapd_fe/my/work"), None);
    }

    #[test]
    fn timestamps_round_trip() {
        let time = at(12, 34);
        assert_eq!(format_tapd_time(time), "2026-11-10 12:34:00");
        assert_eq!(parse_tapd_time("2026-11-10 12:34:00"), Some(time));
        assert_eq!(parse_tapd_time(""), None);
    }
}
