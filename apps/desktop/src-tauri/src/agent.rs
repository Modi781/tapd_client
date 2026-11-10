//! M7 — opencode agent queue, PTY session and console window.
//!
//! Owned by the M7 implementation. Exposed through `feature_command` names
//! starting with `agent_`.
//!
//! Design notes:
//! - The queue is strictly serial: one tokio worker picks `queued` tasks and
//!   runs them one at a time. Commands never start tasks directly. Every task
//!   body runs inside its own `tokio::spawn` so a panic cannot kill the worker.
//! - Each task gets a private `opencode serve` on a free loopback port. The
//!   TUI runs in a PTY connected to that server (`--server`), which lets the
//!   worker observe turn completion/permission asks and advance the queue
//!   without waiting for the TUI to exit.
//! - PTY work happens on dedicated std threads (reader, batcher, wait) so the
//!   async worker only awaits a oneshot result (or an event-driven completion
//!   notification).
//! - All task state changes are persisted atomically and broadcast through
//!   `agent://state` plus the lightweight `agent://summary`. Terminal output is
//!   batched and sent via `agent://output`.
//! - If the server surface is unavailable the worker falls back to the old
//!   TUI-only path (the TUI exit code decides), logging the reason instead of
//!   hanging the queue.

use std::{
    collections::{BTreeMap, HashMap},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::RecvTimeoutError,
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tapd_core::store::{read_json, write_json_atomic};
use tokio::sync::mpsc as tokio_mpsc;

use crate::{
    opencode::{self, PermissionReview, ServerProcess},
    state::SharedState,
};

pub const MAIN_LABEL: &str = "main";

const CONFIG_FILE: &str = "agent.json";
const TASKS_FILE: &str = "agent-tasks.json";
const LOG_DIR: &str = "agent-logs";
const EVENTS_DIR: &str = "agent-events";

const DEFAULT_BINARY: &str = "opencode";
const MAX_LOG_TAIL_BYTES: usize = 400 * 1024;
/// Ignore completion events that arrive immediately after prompt injection
/// (the TUI may still be replaying history).
const COMPLETION_GRACE: Duration = Duration::from_secs(2);
/// Upper bound for waiting on the TUI to exit after a completion/cancel signal.
const PTY_TEARDOWN_TIMEOUT: Duration = Duration::from_secs(3);

pub const DEFAULT_PROMPT_TEMPLATE: &str = "请修复 TAPD 缺陷：{{title}}\n\n缺陷详情文件：{{md_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n项目规则：\n{{project_rule}}\n\n要求：\n1. 先完整阅读 bug.md 和 assets/ 下的截图、视频。\n2. 定位根因，做最小必要修改。\n3.修复时请遵循团队代码规范，确保代码可读、可维护。\n4. 修复完成后，提交代码并在 TAPD 中更新缺陷状态并简要评论原由以及解决方案和修复影响范围。";

/// Previous defaults; untouched installs are migrated to the current default
/// (which also carries the `{{project_rule}}` slot).
const LEGACY_PROMPT_TEMPLATES: &[&str] = &[
    "请修复 TAPD 缺陷：{{title}}\n\n缺陷详情文件：{{md_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n要求：\n1. 先完整阅读 bug.md 和 assets/ 下的截图、视频。\n2. 定位根因，做最小必要修改。\n3.修复时请遵循团队代码规范，确保代码可读、可维护。\n4. 修复完成后，提交代码并在 TAPD 中更新缺陷状态并简要评论原由以及解决方案和修复影响范围。",
    "请修复 TAPD 缺陷：{{title}}\n\n缺陷详情文件：{{md_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n要求：\n1. 先完整阅读 bug.md 和 assets/ 下的截图、视频。\n2. 定位根因，做最小必要修改。\n3. 修改后运行相关测试或构建。\n4. 不要自行 git commit / push，完成后说明改了哪些文件。",
];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Per-project agent settings, edited from the project card.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectAgentConfig {
    /// Absolute local repository path used as the agent's working directory.
    pub repo_path: String,
    /// Project-specific rules appended to (or injected into) the prompt.
    pub rule: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentConfig {
    pub binary_path: String,
    /// Legacy map kept only for migration; use `projects` instead.
    pub repo_mappings: BTreeMap<String, String>,
    /// TAPD workspace id -> repository path + project rules.
    pub projects: BTreeMap<String, ProjectAgentConfig>,
    pub prompt_template: String,
    /// How long the TUI must stay quiet (after producing output) before we
    /// consider it ready and inject the task.
    pub ready_quiet_ms: u64,
    /// Upper bound for readiness detection; on expiry we inject anyway.
    pub ready_timeout_ms: u64,
    pub auto_open_console: bool,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            binary_path: DEFAULT_BINARY.to_string(),
            repo_mappings: BTreeMap::new(),
            projects: BTreeMap::new(),
            prompt_template: DEFAULT_PROMPT_TEMPLATE.to_string(),
            ready_quiet_ms: 900,
            ready_timeout_ms: 15_000,
            auto_open_console: true,
        }
    }
}

impl AgentConfig {
    fn sanitized(mut self) -> Self {
        let binary = self.binary_path.trim();
        self.binary_path = if binary.is_empty() {
            DEFAULT_BINARY.to_string()
        } else {
            binary.to_string()
        };

        if self.prompt_template.trim().is_empty()
            || LEGACY_PROMPT_TEMPLATES
                .iter()
                .any(|legacy| self.prompt_template.trim() == *legacy)
        {
            self.prompt_template = DEFAULT_PROMPT_TEMPLATE.to_string();
        }

        self.ready_quiet_ms = self.ready_quiet_ms.clamp(100, 10_000);
        self.ready_timeout_ms = self.ready_timeout_ms.clamp(1_000, 120_000);

        // Migrate the old id -> path map into per-project settings once.
        for (workspace_id, path) in std::mem::take(&mut self.repo_mappings) {
            let path = path.trim().to_string();
            if path.is_empty() {
                continue;
            }
            self.projects
                .entry(workspace_id)
                .or_insert_with(ProjectAgentConfig::default)
                .repo_path = path;
        }

        self.projects = self
            .projects
            .into_iter()
            .map(|(workspace_id, project)| {
                let repo_path = project.repo_path.trim().to_string();
                let rule = project.rule.trim().to_string();
                (workspace_id, ProjectAgentConfig { repo_path, rule })
            })
            .filter(|(_, project)| !project.repo_path.is_empty() || !project.rule.is_empty())
            .collect();

        self
    }

    /// Repository path for a workspace (legacy map only exists pre-migration).
    fn repo_path_for(&self, workspace_id: &str) -> String {
        self.projects
            .get(workspace_id)
            .map(|project| project.repo_path.clone())
            .filter(|path| !path.is_empty())
            .or_else(|| self.repo_mappings.get(workspace_id).cloned())
            .unwrap_or_default()
    }

    /// Project rules for a workspace.
    fn rule_for(&self, workspace_id: &str) -> String {
        self.projects
            .get(workspace_id)
            .map(|project| project.rule.clone())
            .unwrap_or_default()
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AgentConfigPatch {
    binary_path: Option<String>,
    repo_mappings: Option<BTreeMap<String, String>>,
    projects: Option<BTreeMap<String, ProjectAgentConfig>>,
    prompt_template: Option<String>,
    ready_quiet_ms: Option<u64>,
    ready_timeout_ms: Option<u64>,
    auto_open_console: Option<bool>,
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Queued,
    Preparing,
    Running,
    WaitingReview,
    Succeeded,
    Failed,
    Canceled,
}

impl TaskStatus {
    /// A task occupying the single worker slot. `WaitingReview` still owns the
    /// slot: the agent is blocked on a human decision, not finished.
    fn is_active(self) -> bool {
        matches!(self, Self::Preparing | Self::Running | Self::WaitingReview)
    }

    fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Canceled)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTask {
    pub id: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub bug_id: String,
    pub title: String,
    pub severity: String,
    pub priority: String,
    pub md_path: String,
    pub repo_path: String,
    pub status: TaskStatus,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub log_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub prompt: String,
    pub source: String,
    /// opencode session id, learned from the server event stream. Persisted so
    /// history rows can reopen the conversation in a real terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Pending opencode permission ask; present while `status` is
    /// `waiting_review`. Absent in older persisted files (hence `default`).
    #[serde(default)]
    pub review: Option<PermissionReview>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct TaskFile {
    tasks: Vec<AgentTask>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnqueueRequest {
    pub workspace_id: String,
    pub bug_id: String,
    #[serde(default)]
    pub workspace_name: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub severity: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTasksState {
    tasks: Vec<AgentTask>,
    active_task_id: Option<String>,
    /// Kept for compatibility: number of `queued` tasks.
    queue_length: usize,
    queued_count: usize,
    /// `preparing | running | waiting_review`.
    active_count: usize,
    waiting_review_count: usize,
}

/// Lightweight state for the island capsule / tray badge.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    running: bool,
    waiting_review: bool,
    active_task_id: Option<String>,
    title: Option<String>,
    workspace_name: Option<String>,
    bug_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TaskCounts {
    queued: usize,
    active: usize,
    waiting_review: usize,
}

/// Permission decision sent back to opencode.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PermissionReply {
    Once,
    Always,
    Reject,
}

impl PermissionReply {
    fn as_str(self) -> &'static str {
        match self {
            Self::Once => "once",
            Self::Always => "always",
            Self::Reject => "reject",
        }
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct TaskIdRequest {
    task_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskInputRequest {
    task_id: String,
    data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskResizeRequest {
    task_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionReplyRequest {
    task_id: String,
    response: PermissionReply,
    #[serde(default = "default_true")]
    remember: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct DetectRequest {
    path: Option<String>,
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptVars {
    pub title: String,
    pub md_path: String,
    pub repo_path: String,
    pub workspace_name: String,
    pub bug_id: String,
    pub severity: String,
    pub priority: String,
    /// Project-specific rules (from the project card in settings).
    pub project_rule: String,
}

impl PromptVars {
    fn from_task(task: &AgentTask) -> Self {
        Self {
            title: task.title.clone(),
            md_path: task.md_path.clone(),
            repo_path: task.repo_path.clone(),
            workspace_name: task.workspace_name.clone(),
            bug_id: task.bug_id.clone(),
            severity: task.severity.clone(),
            priority: task.priority.clone(),
            project_rule: String::new(),
        }
    }
}

/// Replaces `{{variable}}` placeholders; unknown placeholders are left intact.
///
/// The project rule is exposed as `{{project_rule}}` so a global template can
/// decide where it lands; when the template has no such placeholder the rule is
/// appended as its own section instead of being silently dropped.
pub fn render_prompt(template: &str, vars: &PromptVars) -> String {
    let pairs = [
        ("title", vars.title.as_str()),
        ("md_path", vars.md_path.as_str()),
        ("repo_path", vars.repo_path.as_str()),
        ("workspace_name", vars.workspace_name.as_str()),
        ("bug_id", vars.bug_id.as_str()),
        ("severity", vars.severity.as_str()),
        ("priority", vars.priority.as_str()),
        ("project_rule", vars.project_rule.as_str()),
    ];

    let has_rule_slot = template.contains("{{project_rule}}");
    let mut rendered = template.to_string();
    for (key, value) in pairs {
        rendered = rendered.replace(&format!("{{{{{key}}}}}"), value);
    }

    let rule = vars.project_rule.trim();
    if !has_rule_slot && !rule.is_empty() {
        rendered.push_str("\n\n项目规则：\n");
        rendered.push_str(rule);
    }
    rendered
}

fn next_queued_index(tasks: &[AgentTask]) -> Option<usize> {
    tasks
        .iter()
        .position(|task| task.status == TaskStatus::Queued)
}

fn task_counts(tasks: &[AgentTask]) -> TaskCounts {
    let mut counts = TaskCounts {
        queued: 0,
        active: 0,
        waiting_review: 0,
    };
    for task in tasks {
        if task.status == TaskStatus::Queued {
            counts.queued += 1;
        }
        if task.status.is_active() {
            counts.active += 1;
        }
        if task.status == TaskStatus::WaitingReview {
            counts.waiting_review += 1;
        }
    }
    counts
}

/// Picks the task the console should display: active first, then the next
/// queued task, then the most recently created finished task.
fn active_task_id(tasks: &[AgentTask]) -> Option<String> {
    tasks
        .iter()
        .find(|task| task.status.is_active())
        .or_else(|| tasks.iter().find(|task| task.status == TaskStatus::Queued))
        .or_else(|| tasks.iter().rev().find(|task| task.status.is_terminal()))
        .map(|task| task.id.clone())
}

fn agent_summary(tasks: &[AgentTask]) -> AgentSummary {
    let active_id = active_task_id(tasks);
    let active = active_id
        .as_ref()
        .and_then(|id| tasks.iter().find(|task| &task.id == id));

    AgentSummary {
        running: tasks.iter().any(|task| task.status.is_active()),
        waiting_review: tasks
            .iter()
            .any(|task| task.status == TaskStatus::WaitingReview),
        active_task_id: active_id,
        title: active.map(|task| task.title.clone()),
        workspace_name: active.map(|task| task.workspace_name.clone()),
        bug_id: active.map(|task| task.bug_id.clone()),
    }
}

/// Repository path for a task: the value resolved when the task was enqueued
/// wins, then the current per-project config. The old `repo_mappings` map is
/// always empty after `sanitized()`, which used to fail every task.
fn resolve_repo_path(task: &AgentTask, config: &AgentConfig) -> Result<String, String> {
    let from_task = task.repo_path.trim();
    if !from_task.is_empty() {
        return Ok(from_task.to_string());
    }

    let from_config = config.repo_path_for(&task.workspace_id);
    let from_config = from_config.trim();
    if !from_config.is_empty() {
        return Ok(from_config.to_string());
    }

    Err("未配置项目仓库路径，请在 设置 → Agent 修复 中配置".to_string())
}

fn finish_status(canceled: bool, exit_code: Option<i32>) -> TaskStatus {
    if canceled {
        TaskStatus::Canceled
    } else if exit_code == Some(0) {
        TaskStatus::Succeeded
    } else {
        TaskStatus::Failed
    }
}

/// Applies a PTY/event outcome to a task. Returns whether anything changed.
///
/// A task that already reached a terminal state is never downgraded: a late
/// `finish_task` must not turn an event-driven `succeeded` into `failed`.
fn apply_finish(task: &mut AgentTask, outcome: &PtyOutcome, now: &str) -> bool {
    if task.status.is_terminal() {
        return false;
    }

    if task.status == TaskStatus::Canceled || outcome.canceled {
        task.status = TaskStatus::Canceled;
        task.finished_at = Some(now.to_string());
        if task.error.is_none() {
            task.error = Some("已取消".to_string());
        }
        task.review = None;
        return true;
    }

    task.finished_at = Some(now.to_string());
    task.exit_code = outcome.exit_code;
    task.review = None;

    let status = if outcome.completed {
        TaskStatus::Succeeded
    } else {
        finish_status(false, outcome.exit_code)
    };
    if status == TaskStatus::Succeeded {
        task.status = TaskStatus::Succeeded;
        task.error = None;
    } else {
        task.status = TaskStatus::Failed;
        let message = outcome.error.clone().unwrap_or_else(|| match outcome.exit_code {
            Some(code) => format!("Agent 进程退出码 {code}"),
            None => "Agent 进程异常结束".to_string(),
        });
        task.error = Some(message);
    }
    true
}

/// Marks tasks that were mid-flight when the client exited as failed, so the
/// queue can make progress after a restart. Returns how many were recovered.
fn recover_incomplete(tasks: &mut [AgentTask], now: &str) -> usize {
    let mut recovered = 0usize;
    for task in tasks.iter_mut() {
        if task.status.is_active() {
            task.status = TaskStatus::Failed;
            task.error = Some("客户端重启".to_string());
            task.finished_at = Some(now.to_string());
            task.exit_code = None;
            recovered += 1;
        }
    }
    recovered
}

// ---------------------------------------------------------------------------
// PTY plumbing
// ---------------------------------------------------------------------------

struct PtyHandles {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    reader: Box<dyn Read + Send>,
    child: Box<dyn Child + Send + Sync>,
}

fn open_pty(
    binary: &str,
    args: &[String],
    envs: &[(String, String)],
    cwd: &Path,
    cols: u16,
    rows: u16,
) -> Result<PtyHandles, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;

    let mut command = CommandBuilder::new(binary);
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    for arg in args {
        command.arg(arg);
    }
    for (key, value) in envs {
        command.env(key, value);
    }

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    drop(pair.slave);
    let master = pair.master;
    let reader = master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = master.take_writer().map_err(|error| error.to_string())?;

    Ok(PtyHandles {
        master,
        writer,
        reader,
        child,
    })
}

struct AgentRuntime {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// The TUI is started with `setsid`, so its pid is also the process-group
    /// id used to kill the whole TUI tree.
    pid: Option<u32>,
    canceled: Arc<AtomicBool>,
}

impl AgentRuntime {
    /// Signals the TUI process group and the direct child.
    fn kill(&mut self) {
        if let Some(pid) = self.pid {
            opencode::kill_process_group(pid, opencode::SIGTERM);
        }
        // portable-pty sends SIGHUP to the direct child on Unix.
        let _ = self.killer.kill();
        if let Some(pid) = self.pid {
            // The TUI is in its own session, so this also reaps grandchildren
            // (MCP servers, tool subprocesses) that ignore SIGHUP/SIGTERM.
            opencode::kill_process_group(pid, opencode::SIGKILL);
        }
    }
}

#[derive(Debug, Default)]
struct PtyOutcome {
    exit_code: Option<i32>,
    canceled: bool,
    /// Turn completion was observed through the server event stream; the TUI
    /// was torn down by the worker instead of exiting on its own.
    completed: bool,
    warning: Option<String>,
    error: Option<String>,
}

/// Tracks whether the initial prompt has been injected and when. Completion
/// events are ignored until the grace period has elapsed.
#[derive(Debug, Default)]
struct PromptGuard {
    injected: AtomicBool,
    injected_at: Mutex<Option<Instant>>,
}

impl PromptGuard {
    fn mark_injected(&self) {
        *self.injected_at.lock().expect("prompt guard lock") = Some(Instant::now());
        self.injected.store(true, Ordering::SeqCst);
    }

    fn injected(&self) -> bool {
        self.injected.load(Ordering::SeqCst)
    }

    fn completion_allowed(&self) -> bool {
        if !self.injected() {
            return false;
        }
        self.injected_at
            .lock()
            .expect("prompt guard lock")
            .map(|at| at.elapsed() >= COMPLETION_GRACE)
            .unwrap_or(false)
    }
}

fn flush_output(app: &AppHandle, task_id: &str, log: &mut Option<std::fs::File>, pending: &mut Vec<u8>) {
    if pending.is_empty() {
        return;
    }
    if let Some(file) = log.as_mut() {
        let _ = file.write_all(pending);
        let _ = file.flush();
    }

    let text = String::from_utf8_lossy(pending).to_string();
    pending.clear();
    if text.is_empty() {
        return;
    }
    let _ = app.emit("agent://output", json!({ "taskId": task_id, "data": text }));
}

// ---------------------------------------------------------------------------
// Runtime core
// ---------------------------------------------------------------------------

/// Per-task server state. The process is kept even when the SSE subscription
/// failed so cancel can still abort the turn over HTTP.
struct ActiveServer {
    process: Arc<ServerProcess>,
    pump: Option<tauri::async_runtime::JoinHandle<()>>,
    consumer: Option<tauri::async_runtime::JoinHandle<()>>,
    session_id: Option<String>,
}

pub struct AgentCore {
    app: AppHandle,
    state: SharedState,
    config: Mutex<AgentConfig>,
    tasks: Mutex<Vec<AgentTask>>,
    runtimes: Mutex<HashMap<String, Arc<Mutex<AgentRuntime>>>>,
    servers: Mutex<HashMap<String, ActiveServer>>,
    /// Per-task cancel flag; created when the worker takes a queued task so a
    /// cancel can interrupt server startup before the PTY exists.
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    wake: tokio::sync::Notify,
}

impl AgentCore {
    fn new(app: AppHandle, state: SharedState) -> Self {
        Self {
            app,
            state,
            config: Mutex::new(AgentConfig::default()),
            tasks: Mutex::new(Vec::new()),
            runtimes: Mutex::new(HashMap::new()),
            servers: Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
            wake: tokio::sync::Notify::new(),
        }
    }

    fn config_path(&self) -> PathBuf {
        self.state.paths.data_dir.join(CONFIG_FILE)
    }

    fn tasks_path(&self) -> PathBuf {
        self.state.paths.data_dir.join(TASKS_FILE)
    }

    fn logs_dir(&self) -> PathBuf {
        self.state.paths.data_dir.join(LOG_DIR)
    }

    fn events_dir(&self) -> PathBuf {
        self.state.paths.data_dir.join(EVENTS_DIR)
    }

    fn load(&self) {
        let loaded = read_json::<AgentConfig>(&self.config_path())
            .unwrap_or_default()
            .sanitized();
        if let Err(error) = write_json_atomic(&self.config_path(), &loaded) {
            tracing::warn!(%error, "failed to persist agent config");
        }
        *self.config.lock().expect("agent config lock") = loaded;

        let mut tasks = read_json::<TaskFile>(&self.tasks_path())
            .map(|file| file.tasks)
            .unwrap_or_default();
        let recovered = recover_incomplete(&mut tasks, &now());
        if recovered > 0 {
            tracing::warn!(recovered, "marked interrupted agent tasks as failed");
        }
        *self.tasks.lock().expect("agent tasks lock") = tasks;

        let _ = std::fs::create_dir_all(self.logs_dir());
        let _ = std::fs::create_dir_all(self.events_dir());
        self.persist_tasks();
    }

    fn config_snapshot(&self) -> AgentConfig {
        self.config.lock().expect("agent config lock").clone()
    }

    fn persist_tasks(&self) {
        let file = TaskFile {
            tasks: self.tasks.lock().expect("agent tasks lock").clone(),
        };
        if let Err(error) = write_json_atomic(&self.tasks_path(), &file) {
            tracing::warn!(%error, "failed to persist agent tasks");
        }
        // Relational mirror (task <-> bug/session/log) for history queries.
        self.state.cache.replace_agent_tasks(&file.tasks);
    }

    fn tasks_state(&self) -> AgentTasksState {
        let tasks = self.tasks.lock().expect("agent tasks lock").clone();
        let counts = task_counts(&tasks);
        AgentTasksState {
            active_task_id: active_task_id(&tasks),
            queue_length: counts.queued,
            queued_count: counts.queued,
            active_count: counts.active,
            waiting_review_count: counts.waiting_review,
            tasks,
        }
    }

    fn summary(&self) -> AgentSummary {
        agent_summary(&self.tasks.lock().expect("agent tasks lock"))
    }

    fn emit_state(&self) {
        let state = self.tasks_state();
        let summary = agent_summary(&state.tasks);
        let _ = self.app.emit("agent://state", state);
        let _ = self.app.emit("agent://summary", summary);
    }

    /// Runs `mutate` under the tasks lock and only persists/broadcasts when it
    /// reports a change.
    fn mutate_tasks<F>(&self, mutate: F) -> bool
    where
        F: FnOnce(&mut Vec<AgentTask>) -> bool,
    {
        let changed = {
            let mut tasks = self.tasks.lock().expect("agent tasks lock");
            mutate(&mut tasks)
        };
        if changed {
            self.persist_tasks();
            self.emit_state();
        }
        changed
    }

    fn update_task<F>(&self, task_id: &str, mutate: F) -> Option<AgentTask>
    where
        F: FnOnce(&mut AgentTask),
    {
        let snapshot = {
            let mut tasks = self.tasks.lock().expect("agent tasks lock");
            let task = tasks.iter_mut().find(|task| task.id == task_id)?;
            mutate(task);
            task.clone()
        };
        self.persist_tasks();
        self.emit_state();
        Some(snapshot)
    }

    fn task_snapshot(&self, task_id: &str) -> Option<AgentTask> {
        self.tasks
            .lock()
            .expect("agent tasks lock")
            .iter()
            .find(|task| task.id == task_id)
            .cloned()
    }

    fn current_status(&self, task_id: &str) -> Option<TaskStatus> {
        self.task_snapshot(task_id).map(|task| task.status)
    }

    fn fail_task(&self, task_id: &str, message: String) {
        let changed = self.update_task(task_id, |task| {
            // Never downgrade a task that already reached a terminal state
            // (e.g. event-driven `succeeded` followed by a late teardown).
            if task.status.is_terminal() {
                return;
            }
            task.status = TaskStatus::Failed;
            task.error = Some(message);
            task.finished_at = Some(now());
            task.review = None;
        });
        if changed.is_none() {
            tracing::warn!(task_id, "agent task disappeared while failing");
        }
    }

    fn update_config(&self, patch: AgentConfigPatch) -> AgentConfig {
        let next = {
            let mut config = self.config.lock().expect("agent config lock");
            if let Some(path) = patch.binary_path {
                config.binary_path = path;
            }
            if let Some(mappings) = patch.repo_mappings {
                config.repo_mappings = mappings;
            }
            if let Some(projects) = patch.projects {
                config.projects = projects;
            }
            if let Some(template) = patch.prompt_template {
                config.prompt_template = template;
            }
            if let Some(value) = patch.ready_quiet_ms {
                config.ready_quiet_ms = value;
            }
            if let Some(value) = patch.ready_timeout_ms {
                config.ready_timeout_ms = value;
            }
            if let Some(value) = patch.auto_open_console {
                config.auto_open_console = value;
            }
            config.clone().sanitized()
        };

        *self.config.lock().expect("agent config lock") = next.clone();
        if let Err(error) = write_json_atomic(&self.config_path(), &next) {
            tracing::warn!(%error, "failed to persist agent config");
        }
        next
    }

    fn enqueue(&self, request: &EnqueueRequest, source: &str) -> Result<AgentTask, String> {
        let workspace_id = request.workspace_id.trim();
        let bug_id = request.bug_id.trim();
        if workspace_id.is_empty() || bug_id.is_empty() {
            return Err("缺少 workspaceId 或 bugId".to_string());
        }

        let id = uuid::Uuid::new_v4().simple().to_string();
        let log_path = self.logs_dir().join(format!("{id}.log"));
        let _ = std::fs::create_dir_all(self.logs_dir());

        let config = self.config_snapshot();
        let workspace_name = request
            .workspace_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| workspace_id.to_string());
        let title = request
            .title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("缺陷 {bug_id}"));
        let severity = request.severity.clone().unwrap_or_default();
        let priority = request.priority.clone().unwrap_or_default();
        let repo_path = config.repo_path_for(workspace_id);

        let task = AgentTask {
            id,
            workspace_id: workspace_id.to_string(),
            workspace_name,
            bug_id: bug_id.to_string(),
            title,
            severity: severity.trim().to_string(),
            priority: priority.trim().to_string(),
            md_path: String::new(),
            repo_path,
            status: TaskStatus::Queued,
            created_at: now(),
            started_at: None,
            finished_at: None,
            exit_code: None,
            log_path: log_path.to_string_lossy().to_string(),
            error: None,
            prompt: String::new(),
            source: source.to_string(),
            session_id: None,
            review: None,
        };

        self.tasks
            .lock()
            .expect("agent tasks lock")
            .push(task.clone());
        self.persist_tasks();
        self.emit_state();
        self.wake.notify_one();

        tracing::info!(task_id = %task.id, bug_id = %task.bug_id, source, "agent task queued");
        Ok(task)
    }

    /// Cancels a task: aborts the active turn over HTTP (best effort), kills
    /// the TUI process group and, later, the per-task server.
    async fn cancel(&self, task_id: &str) -> Result<AgentTask, String> {
        let (snapshot, server, session_id) = {
            let mut tasks = self.tasks.lock().expect("agent tasks lock");
            let task = tasks
                .iter_mut()
                .find(|task| task.id == task_id)
                .ok_or_else(|| "任务不存在".to_string())?;

            if task.status.is_terminal() {
                return Err("任务已经结束，无需取消".to_string());
            }
            let review_session = task.review.as_ref().map(|review| review.session_id.clone());
            task.status = TaskStatus::Canceled;
            task.finished_at = Some(now());
            task.review = None;
            if task.error.is_none() {
                task.error = Some("已取消".to_string());
            }
            let snapshot = task.clone();

            let (server, session_id) = self
                .servers
                .lock()
                .expect("agent servers lock")
                .get(task_id)
                .map(|state| {
                    (
                        Some(state.process.clone()),
                        state.session_id.clone().or(review_session),
                    )
                })
                .unwrap_or((None, None));

            (snapshot, server, session_id)
        };

        if let Some(flag) = self
            .cancels
            .lock()
            .expect("agent cancels lock")
            .get(task_id)
            .cloned()
        {
            flag.store(true, Ordering::SeqCst);
        }

        if let (Some(server), Some(session_id)) = (server, session_id) {
            match tokio::time::timeout(
                Duration::from_secs(3),
                server.abort_session(&session_id),
            )
            .await
            {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    tracing::warn!(task_id, %error, "failed to abort opencode session");
                }
                Err(_) => tracing::warn!(task_id, "opencode abort timed out"),
            }
        }

        self.stop_runtime(task_id);
        self.persist_tasks();
        self.emit_state();
        Ok(snapshot)
    }

    /// Kills the TUI process group and closes its PTY handles. Idempotent.
    fn stop_runtime(&self, task_id: &str) {
        let runtime = self
            .runtimes
            .lock()
            .expect("agent runtimes lock")
            .remove(task_id);
        if let Some(runtime) = runtime {
            let mut runtime = runtime.lock().expect("agent runtime lock");
            runtime.canceled.store(true, Ordering::SeqCst);
            runtime.kill();
        }
    }

    /// Full teardown for a task: cancel flag, TUI process group, server process
    /// group and the background SSE tasks. Safe to call repeatedly.
    fn teardown_task(&self, task_id: &str) {
        if let Some(flag) = self
            .cancels
            .lock()
            .expect("agent cancels lock")
            .remove(task_id)
        {
            flag.store(true, Ordering::SeqCst);
        }

        self.stop_runtime(task_id);

        let server = self
            .servers
            .lock()
            .expect("agent servers lock")
            .remove(task_id);
        if let Some(state) = server {
            if let Some(pump) = state.pump {
                pump.abort();
            }
            if let Some(consumer) = state.consumer {
                consumer.abort();
            }
            state.process.stop();
        }
    }

    fn server_for(&self, task_id: &str) -> Option<Arc<ServerProcess>> {
        self.servers
            .lock()
            .expect("agent servers lock")
            .get(task_id)
            .map(|state| state.process.clone())
    }

    /// Persists a session id discovered from server events.
    fn remember_session(&self, task_id: &str, session_id: &str) {
        if session_id.is_empty() {
            return;
        }
        if let Some(state) = self
            .servers
            .lock()
            .expect("agent servers lock")
            .get_mut(task_id)
        {
            state.session_id = Some(session_id.to_string());
        }

        // Persist the relation on the task so history can reopen the session.
        self.mutate_tasks(|tasks| {
            let Some(task) = tasks.iter_mut().find(|task| task.id == task_id) else {
                return false;
            };
            if task.session_id.as_deref() == Some(session_id) {
                return false;
            }
            task.session_id = Some(session_id.to_string());
            true
        });
    }

    /// Marks a task succeeded from a turn-boundary event. Returns whether the
    /// status changed; terminal tasks are never touched.
    fn mark_succeeded(&self, task_id: &str) -> bool {
        self.mutate_tasks(|tasks| {
            let Some(task) = tasks.iter_mut().find(|task| task.id == task_id) else {
                return false;
            };
            if task.status.is_terminal() {
                return false;
            }
            // A permission prompt keeps the turn alive; an idle event that
            // races with it must not silently complete the task.
            if task.status == TaskStatus::WaitingReview {
                return false;
            }
            task.status = TaskStatus::Succeeded;
            task.finished_at = Some(now());
            task.exit_code = Some(0);
            task.error = None;
            task.review = None;
            true
        })
    }

    /// Fails a task from a turn-boundary event (guarded like `fail_task`).
    fn fail_from_event(&self, task_id: &str, message: String) -> bool {
        self.mutate_tasks(|tasks| {
            let Some(task) = tasks.iter_mut().find(|task| task.id == task_id) else {
                return false;
            };
            if task.status.is_terminal() {
                return false;
            }
            task.status = TaskStatus::Failed;
            task.finished_at = Some(now());
            task.error = Some(message);
            task.review = None;
            true
        })
    }

    fn set_review(&self, task_id: &str, review: PermissionReview) {
        self.mutate_tasks(|tasks| {
            let Some(task) = tasks.iter_mut().find(|task| task.id == task_id) else {
                return false;
            };
            if task.status.is_terminal() {
                return false;
            }
            let unchanged = task.review.as_ref() == Some(&review)
                && task.status == TaskStatus::WaitingReview;
            if unchanged {
                return false;
            }
            task.review = Some(review);
            task.status = TaskStatus::WaitingReview;
            true
        });
    }

    fn clear_review(&self, task_id: &str, permission_id: Option<&str>) {
        self.mutate_tasks(|tasks| {
            let Some(task) = tasks.iter_mut().find(|task| task.id == task_id) else {
                return false;
            };
            let Some(current) = task.review.as_ref() else {
                return false;
            };
            if let Some(permission_id) = permission_id {
                if current.id != permission_id {
                    return false;
                }
            }
            task.review = None;
            if task.status == TaskStatus::WaitingReview {
                task.status = TaskStatus::Running;
            }
            true
        });
    }

    /// Replies to the pending permission ask and resumes the task.
    async fn reply_permission(
        &self,
        task_id: &str,
        response: PermissionReply,
        remember: bool,
    ) -> Result<AgentTask, String> {
        let task = self
            .task_snapshot(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        if task.status.is_terminal() {
            return Err("任务已经结束".to_string());
        }
        let review = task
            .review
            .clone()
            .ok_or_else(|| "没有待处理的权限请求".to_string())?;
        let server = self
            .server_for(task_id)
            .ok_or_else(|| "Agent 服务未运行，无法回复权限请求".to_string())?;

        tokio::time::timeout(
            Duration::from_secs(10),
            server.reply_permission(
                &review.session_id,
                &review.id,
                response.as_str(),
                remember,
            ),
        )
        .await
        .map_err(|_| "回复权限请求超时".to_string())?
        .map_err(|error| format!("回复权限请求失败：{error}"))?;

        let updated = self.mutate_tasks(|tasks| {
            let Some(task) = tasks.iter_mut().find(|task| task.id == task_id) else {
                return false;
            };
            task.review = None;
            if !task.status.is_terminal() {
                task.status = TaskStatus::Running;
            }
            true
        });
        if !updated {
            return Err("任务不存在".to_string());
        }

        self.task_snapshot(task_id)
            .ok_or_else(|| "任务不存在".to_string())
    }

    /// Handles one decoded opencode event for a task.
    fn handle_server_event(
        &self,
        task_id: &str,
        event: &Value,
        guard: &PromptGuard,
        done: &tokio::sync::Notify,
    ) {
        let event_type = opencode::event_type(event);
        if event_type.is_empty() {
            return;
        }

        if let Some(session_id) = opencode::event_session_id(event) {
            self.remember_session(task_id, &session_id);
        }

        if event_type.contains("permission") {
            // A permission ask can only belong to our turn once the prompt was
            // injected. This also filters asks replayed by the server on
            // connect (from a previous session in the same project).
            if !guard.injected() {
                return;
            }
            if opencode::is_permission_resolution(&event_type) {
                let permission_id = opencode::parse_review(event).map(|review| review.id);
                self.clear_review(task_id, permission_id.as_deref());
            } else if let Some(review) = opencode::parse_review(event) {
                self.set_review(task_id, review);
            }
            return;
        }

        match opencode::turn_signal(&event_type, event) {
            Some(opencode::TurnSignal::Succeeded) => {
                if !guard.completion_allowed() {
                    tracing::debug!(
                        task_id,
                        event_type = %event_type,
                        "ignoring completion before the prompt grace period"
                    );
                    return;
                }
                if self.mark_succeeded(task_id) {
                    // Tear down the TUI so the worker immediately takes the
                    // next queued task.
                    self.stop_runtime(task_id);
                    done.notify_one();
                }
            }
            Some(opencode::TurnSignal::Failed(message)) => {
                if !guard.completion_allowed() {
                    return;
                }
                if self.fail_from_event(task_id, message) {
                    self.stop_runtime(task_id);
                    done.notify_one();
                }
            }
            Some(opencode::TurnSignal::Busy) | None => {}
        }
    }

    fn spawn_event_consumer(
        self: &Arc<Self>,
        task_id: &str,
        mut receiver: tokio_mpsc::UnboundedReceiver<Value>,
        guard: Arc<PromptGuard>,
        done: Arc<tokio::sync::Notify>,
    ) -> tauri::async_runtime::JoinHandle<()> {
        let core = self.clone();
        let task_id = task_id.to_string();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = receiver.recv().await {
                core.handle_server_event(&task_id, &event, &guard, &done);
            }
        })
    }

    fn retry(&self, task_id: &str) -> Result<AgentTask, String> {
        let original = self
            .task_snapshot(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        if !original.status.is_terminal() {
            return Err("任务仍在队列或运行中，不能重试".to_string());
        }

        let id = uuid::Uuid::new_v4().simple().to_string();
        let _ = std::fs::create_dir_all(self.logs_dir());
        let mut task = original;
        task.id = id.clone();
        task.status = TaskStatus::Queued;
        task.created_at = now();
        task.started_at = None;
        task.finished_at = None;
        task.exit_code = None;
        task.error = None;
        task.review = None;
        task.session_id = None;
        task.log_path = self.logs_dir().join(format!("{id}.log")).to_string_lossy().to_string();

        self.tasks
            .lock()
            .expect("agent tasks lock")
            .push(task.clone());
        self.persist_tasks();
        self.emit_state();
        self.wake.notify_one();
        Ok(task)
    }

    fn read_log(&self, task_id: &str) -> Result<String, String> {
        let task = self
            .task_snapshot(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        let bytes = std::fs::read(&task.log_path).map_err(|error| error.to_string())?;
        let slice = if bytes.len() > MAX_LOG_TAIL_BYTES {
            &bytes[bytes.len() - MAX_LOG_TAIL_BYTES..]
        } else {
            &bytes[..]
        };
        Ok(String::from_utf8_lossy(slice).to_string())
    }

    /// Opens the task's opencode session in Terminal.app, in its repository.
    fn open_session(&self, task_id: &str) -> Result<(), String> {
        let task = self
            .task_snapshot(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        let session_id = task
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "该任务还没有 opencode 会话 ID，无法恢复".to_string())?;
        if !Path::new(&task.repo_path).is_dir() {
            return Err(format!("仓库路径不存在：{}", task.repo_path));
        }
        let binary = self.config_snapshot().binary_path;
        open_terminal_session(&binary, &task.repo_path, session_id)
    }

    fn write_input(&self, task_id: &str, data: &str) -> Result<(), String> {
        let runtime = self
            .runtimes
            .lock()
            .expect("agent runtimes lock")
            .get(task_id)
            .cloned()
            .ok_or_else(|| "任务未在运行".to_string())?;
        let mut runtime = runtime.lock().expect("agent runtime lock");
        runtime
            .writer
            .write_all(data.as_bytes())
            .and_then(|_| runtime.writer.flush())
            .map_err(|error| error.to_string())
    }

    fn resize(&self, task_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let runtime = self
            .runtimes
            .lock()
            .expect("agent runtimes lock")
            .get(task_id)
            .cloned()
            .ok_or_else(|| "任务未在运行".to_string())?;
        let runtime = runtime.lock().expect("agent runtime lock");
        runtime
            .master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())
    }

    // -- queue worker --------------------------------------------------------

    fn spawn_worker(self: &Arc<Self>) {
        let core = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let Some(task) = core.take_next_queued() else {
                    core.wake.notified().await;
                    continue;
                };
                let task_id = task.id.clone();

                // Each task body runs in its own tokio task: a panic inside
                // `run_task` must not kill the single worker loop.
                let runner = core.clone();
                let handle = tauri::async_runtime::spawn(async move {
                    runner.run_task(task).await;
                });

                if let Err(error) = handle.await {
                    tracing::error!(task_id, %error, "agent task runner failed");
                    core.fail_task(&task_id, format!("Agent 任务执行异常：{error}"));
                }

                core.teardown_task(&task_id);
                // Belt and braces: no task may stay active after its runner
                // returned, otherwise the queue would never advance.
                core.recover_active_tasks("任务意外中断");
            }
        });

        // Resume work left over from a previous session.
        if next_queued_index(&self.tasks.lock().expect("agent tasks lock")).is_some() {
            self.wake.notify_one();
        }
    }

    /// Fails any task still marked active. Called after each worker iteration.
    fn recover_active_tasks(&self, reason: &str) {
        self.mutate_tasks(|tasks| {
            let mut changed = false;
            for task in tasks.iter_mut() {
                if task.status.is_active() {
                    task.status = TaskStatus::Failed;
                    task.error = Some(reason.to_string());
                    task.finished_at = Some(now());
                    task.review = None;
                    changed = true;
                }
            }
            changed
        });
    }

    fn take_next_queued(&self) -> Option<AgentTask> {
        let task = {
            let mut tasks = self.tasks.lock().expect("agent tasks lock");
            let index = next_queued_index(&tasks)?;
            let task = tasks.get_mut(index)?;
            if task.status != TaskStatus::Queued {
                return None;
            }
            task.status = TaskStatus::Preparing;
            task.started_at = Some(now());
            task.clone()
        };
        self.cancels
            .lock()
            .expect("agent cancels lock")
            .insert(task.id.clone(), Arc::new(AtomicBool::new(false)));
        self.persist_tasks();
        self.emit_state();
        Some(task)
    }

    async fn run_task(self: &Arc<Self>, mut task: AgentTask) {
        let config = self.config_snapshot();

        // 1. Export the bug package (bug.md + assets).
        let export = crate::export::run_export(
            &self.app,
            &self.state.paths,
            &task.workspace_id,
            &task.bug_id,
            Some(task.workspace_name.clone()).filter(|name| !name.trim().is_empty()),
        )
        .await;

        if self.current_status(&task.id) == Some(TaskStatus::Canceled) {
            return;
        }

        let export = match export {
            Ok(export) => export,
            Err(error) => {
                self.fail_task(&task.id, format!("导出缺陷失败：{error}"));
                return;
            }
        };
        task.md_path = export.markdown_path.clone();
        // Persist the export path early so failed tasks still expose their
        // generated bug package (e.g. when no repository is configured).
        let Some(prepared) = self.update_task(&task.id, |current| {
            if current.status != TaskStatus::Canceled {
                current.md_path = task.md_path.clone();
            }
        }) else {
            return;
        };
        if prepared.status == TaskStatus::Canceled {
            return;
        }

        // 2. Resolve the repository path. The task carries the path resolved at
        // enqueue time; `repo_mappings` is only a legacy fallback.
        let repo_path = match resolve_repo_path(&task, &config) {
            Ok(repo_path) => repo_path,
            Err(error) => {
                self.fail_task(&task.id, error);
                return;
            }
        };

        if !Path::new(&repo_path).is_dir() {
            self.fail_task(
                &task.id,
                format!("本地仓库路径不存在或不是目录：{repo_path}"),
            );
            return;
        }
        task.repo_path = repo_path;

        // 3. Validate the agent binary (relative names are resolved via PATH).
        if let Err(error) = validate_binary(&config.binary_path) {
            self.fail_task(&task.id, error);
            return;
        }

        // 3b. Make sure the opencode global config exposes the tapd MCP server.
        //     Only for the opencode binary, idempotent and best effort: a failure
        //     only warns and never blocks the task.
        if is_opencode_binary(&config.binary_path) {
            let sidecar = crate::commands::sidecar_command_path();
            match tokio::task::spawn_blocking(move || {
                crate::mcp_import::ensure_opencode_mcp(&sidecar)
            })
            .await
            {
                Ok(Ok(result)) => {
                    tracing::info!(task_id = %task.id, result = %result, "opencode MCP injection checked");
                }
                Ok(Err(error)) => {
                    tracing::warn!(task_id = %task.id, %error, "failed to inject tapd MCP into opencode");
                }
                Err(error) => {
                    tracing::warn!(task_id = %task.id, %error, "MCP injection task panicked");
                }
            }
        }

        let mut vars = PromptVars::from_task(&task);
        vars.project_rule = config.rule_for(&task.workspace_id);
        task.prompt = render_prompt(&config.prompt_template, &vars);

        // 4. Move to `running` with the resolved paths.
        let Some(running_task) = self.update_task(&task.id, |current| {
            if current.status == TaskStatus::Canceled {
                return;
            }
            current.md_path = task.md_path.clone();
            current.repo_path = task.repo_path.clone();
            current.prompt = task.prompt.clone();
            current.status = TaskStatus::Running;
            if current.started_at.is_none() {
                current.started_at = Some(now());
            }
        }) else {
            self.fail_task(&task.id, "任务在准备阶段丢失".to_string());
            return;
        };

        if running_task.status == TaskStatus::Canceled {
            return;
        }

        // 5. Start a private opencode server and subscribe to its event stream.
        //    Failures fall back to the TUI-only path instead of hanging.
        let cancel = self
            .cancels
            .lock()
            .expect("agent cancels lock")
            .get(&task.id)
            .cloned()
            .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
        let done = Arc::new(tokio::sync::Notify::new());
        let guard = Arc::new(PromptGuard::default());
        let mut warnings: Vec<String> = Vec::new();

        let server_log = self.logs_dir().join(format!("{}-server.log", task.id));
        let server = match ServerProcess::spawn(
            &config.binary_path,
            Path::new(&task.repo_path),
            &server_log,
        ) {
            Ok(server) => Some(Arc::new(server)),
            Err(error) => {
                let message = format!("无法启动 opencode 服务（{error}），回退为仅终端模式");
                warnings.push(message.clone());
                self.log_server_warning(&task.id, &message);
                None
            }
        };

        let mut server_active = false;
        if let Some(server) = server {
            match server.wait_ready(opencode::READY_TIMEOUT, &cancel).await {
                Ok(()) => {
                    server_active = true;
                    let events_path = self.events_dir().join(format!("{}.jsonl", task.id));
                    let (sink, receiver) = tokio_mpsc::unbounded_channel();
                    match server.subscribe_events(sink, events_path, cancel.clone()).await {
                        Ok((pump, flavor)) => {
                            tracing::info!(
                                task_id = %task.id,
                                base = server.base_url(),
                                ?flavor,
                                "subscribed to opencode events"
                            );
                            let consumer = self.spawn_event_consumer(
                                &task.id,
                                receiver,
                                guard.clone(),
                                done.clone(),
                            );
                            self.servers
                                .lock()
                                .expect("agent servers lock")
                                .insert(
                                    task.id.clone(),
                                    ActiveServer {
                                        process: server.clone(),
                                        pump: Some(pump),
                                        consumer: Some(consumer),
                                        session_id: None,
                                    },
                                );
                        }
                        Err(error) => {
                            let message = format!(
                                "无法订阅 opencode 事件流（{error}），回退为终端退出判定"
                            );
                            warnings.push(message.clone());
                            self.log_server_warning(&task.id, &message);
                            // The TUI still uses the server; keep it for abort.
                            self.servers
                                .lock()
                                .expect("agent servers lock")
                                .insert(
                                    task.id.clone(),
                                    ActiveServer {
                                        process: server.clone(),
                                        pump: None,
                                        consumer: None,
                                        session_id: None,
                                    },
                                );
                        }
                    }
                }
                Err(error) => {
                    let message = format!("opencode 服务未就绪（{error}），回退为仅终端模式");
                    warnings.push(message.clone());
                    self.log_server_warning(&task.id, &message);
                    server.stop();
                }
            }
        }

        if cancel.load(Ordering::SeqCst)
            || self.current_status(&task.id) == Some(TaskStatus::Canceled)
        {
            self.teardown_task(&task.id);
            return;
        }

        // 6. Run the TUI in the PTY, connected to the server when available.
        let (tui_args, tui_envs) = if server_active {
            match self.server_for(&task.id) {
                Some(server) => (
                    vec!["--server".to_string(), server.base_url().to_string()],
                    vec![(
                        opencode::SERVER_PASSWORD_ENV.to_string(),
                        server.password().to_string(),
                    )],
                ),
                None => (Vec::new(), Vec::new()),
            }
        } else {
            (Vec::new(), Vec::new())
        };

        let (sender, mut receiver) = tokio::sync::oneshot::channel::<PtyOutcome>();
        let core = self.clone();
        let pty_task = running_task.clone();
        let pty_config = config.clone();
        let pty_guard = guard.clone();
        std::thread::Builder::new()
            .name(format!("agent-pty-{}", pty_task.id))
            .spawn(move || {
                let outcome = core.run_pty(
                    &pty_task,
                    &pty_config,
                    tui_args,
                    tui_envs,
                    pty_guard,
                );
                let _ = sender.send(outcome);
            })
            .map_err(|error| tracing::warn!(%error, "failed to spawn agent pty thread"))
            .ok();

        // Wait for the TUI to exit or for a server event to close the turn.
        let mut outcome = tokio::select! {
            result = &mut receiver => match result {
                Ok(outcome) => outcome,
                Err(_) => PtyOutcome {
                    error: Some("Agent 终端线程意外结束".to_string()),
                    ..PtyOutcome::default()
                },
            },
            _ = done.notified() => {
                // The turn already reached a terminal state. Kill the TUI so
                // the queue advances immediately, then collect its exit code.
                self.stop_runtime(&task.id);
                match tokio::time::timeout(PTY_TEARDOWN_TIMEOUT, &mut receiver).await {
                    Ok(Ok(mut outcome)) => {
                        outcome.completed = true;
                        outcome
                    }
                    _ => PtyOutcome {
                        completed: true,
                        ..PtyOutcome::default()
                    },
                }
            }
        };

        if !warnings.is_empty() {
            let message = warnings.join("；");
            self.append_task_log(&task.log_path, &message);
            outcome.warning = Some(match outcome.warning.take() {
                Some(existing) => format!("{existing}；{message}"),
                None => message,
            });
        }

        // Always tear down the TUI + server before the worker takes the next
        // task, even when the task panicked further up.
        self.teardown_task(&task.id);
        self.finish_task(&task.id, outcome);
    }

    fn append_task_log(&self, log_path: &str, message: &str) {
        let line = format!("\r\n[tapd-client] {message}\r\n");
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
        {
            let _ = file.write_all(line.as_bytes());
            let _ = file.flush();
        }
    }

    fn log_server_warning(&self, task_id: &str, message: &str) {
        tracing::warn!(task_id, %message, "agent server fallback");
        let path = self.logs_dir().join(format!("{task_id}-server.log"));
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(file, "[tapd-client] {message}");
            let _ = file.flush();
        }
    }

    fn run_pty(
        &self,
        task: &AgentTask,
        config: &AgentConfig,
        args: Vec<String>,
        envs: Vec<(String, String)>,
        guard: Arc<PromptGuard>,
    ) -> PtyOutcome {
        // A cancel can land between the status update and this thread starting;
        // don't spawn a process that is already doomed.
        if self.current_status(&task.id) == Some(TaskStatus::Canceled) {
            return PtyOutcome {
                canceled: true,
                ..PtyOutcome::default()
            };
        }

        let handles = match open_pty(
            &config.binary_path,
            &args,
            &envs,
            Path::new(&task.repo_path),
            120,
            32,
        ) {
            Ok(handles) => handles,
            Err(error) => {
                return PtyOutcome {
                    error: Some(format!("启动 Agent 终端失败：{error}")),
                    ..PtyOutcome::default()
                }
            }
        };

        let PtyHandles {
            master,
            writer,
            mut reader,
            mut child,
        } = handles;

        let canceled = Arc::new(AtomicBool::new(false));
        let runtime = Arc::new(Mutex::new(AgentRuntime {
            master,
            writer,
            killer: child.clone_killer(),
            pid: child.process_id(),
            canceled: canceled.clone(),
        }));
        self.runtimes
            .lock()
            .expect("agent runtimes lock")
            .insert(task.id.clone(), runtime.clone());

        // Close the race where a cancel arrived just before the runtime became
        // visible to `agent_task_cancel`.
        if self.current_status(&task.id) == Some(TaskStatus::Canceled) {
            canceled.store(true, Ordering::SeqCst);
            if let Ok(mut runtime) = runtime.lock() {
                runtime.kill();
            }
        }

        let has_output = Arc::new(AtomicBool::new(false));
        let last_output = Arc::new(Mutex::new(Instant::now()));

        // Reader: blocking reads on its own thread, forwarded as raw chunks.
        let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let reader_has_output = has_output.clone();
        let reader_last_output = last_output.clone();
        let reader_handle = std::thread::Builder::new()
            .name(format!("agent-reader-{}", task.id))
            .spawn(move || {
                let mut buffer = [0u8; 8192];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(count) => {
                            reader_has_output.store(true, Ordering::SeqCst);
                            if let Ok(mut last) = reader_last_output.lock() {
                                *last = Instant::now();
                            }
                            if chunk_tx.send(buffer[..count].to_vec()).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            })
            .ok();

        // Batcher: coalesces chunks (20-40 ms window) then emits + writes log.
        let batch_app = self.app.clone();
        let batch_task_id = task.id.clone();
        let log_path = task.log_path.clone();
        let batcher_handle = std::thread::Builder::new()
            .name(format!("agent-batch-{}", task.id))
            .spawn(move || {
                let mut log = std::fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(true)
                    .open(&log_path)
                    .ok();
                let mut pending: Vec<u8> = Vec::new();

                loop {
                    match chunk_rx.recv_timeout(Duration::from_millis(30)) {
                        Ok(chunk) => {
                            pending.extend_from_slice(&chunk);
                            if pending.len() >= 256 * 1024 {
                                flush_output(&batch_app, &batch_task_id, &mut log, &mut pending);
                            }
                        }
                        Err(RecvTimeoutError::Timeout) => {
                            flush_output(&batch_app, &batch_task_id, &mut log, &mut pending);
                        }
                        Err(RecvTimeoutError::Disconnected) => {
                            flush_output(&batch_app, &batch_task_id, &mut log, &mut pending);
                            break;
                        }
                    }
                }
            })
            .ok();

        // Wait for the TUI to settle before injecting the prompt.
        let mut warning: Option<String> = None;
        let ready_quiet = Duration::from_millis(config.ready_quiet_ms.clamp(100, 10_000));
        let ready_timeout = Duration::from_millis(config.ready_timeout_ms.clamp(1_000, 120_000));
        let started = Instant::now();
        let mut ready = false;

        while started.elapsed() < ready_timeout {
            if canceled.load(Ordering::SeqCst) {
                break;
            }
            let produced_output = has_output.load(Ordering::SeqCst);
            let quiet_for = last_output
                .lock()
                .map(|last| last.elapsed())
                .unwrap_or_default();
            if produced_output && quiet_for >= ready_quiet {
                ready = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }

        if !canceled.load(Ordering::SeqCst) {
            if !ready {
                warning = Some(if has_output.load(Ordering::SeqCst) {
                    "TUI 就绪检测超时，已强制注入任务".to_string()
                } else {
                    "未检测到 TUI 输出，已按超时注入任务".to_string()
                });
                tracing::warn!(task_id = %task.id, warning = ?warning, "agent ready detection timed out");
            }

            let injected = {
                let mut runtime = runtime.lock().expect("agent runtime lock");
                runtime
                    .writer
                    .write_all(task.prompt.as_bytes())
                    .and_then(|_| runtime.writer.write_all(b"\r"))
                    .and_then(|_| runtime.writer.flush())
            };
            match injected {
                Ok(()) => guard.mark_injected(),
                Err(error) => {
                    warning = Some(match warning {
                        Some(existing) => format!("{existing}；注入任务失败：{error}"),
                        None => format!("注入任务失败：{error}"),
                    });
                }
            }
        }

        // Wait for the agent process to exit (blocks this thread only).
        let mut outcome = PtyOutcome {
            canceled: canceled.load(Ordering::SeqCst),
            warning,
            ..PtyOutcome::default()
        };
        match child.wait() {
            Ok(status) => {
                outcome.exit_code = Some(status.exit_code() as i32);
                if let Some(signal) = status.signal() {
                    outcome.error = Some(format!("Agent 进程被信号终止：{signal}"));
                }
            }
            Err(error) => {
                outcome.error = Some(format!("等待 Agent 进程失败：{error}"));
            }
        }
        outcome.canceled = outcome.canceled || canceled.load(Ordering::SeqCst);

        // Do not block forever on the readers: a grandchild process may keep
        // the slave fd open after the TUI exits, which delays EOF.
        join_with_timeout(reader_handle, Duration::from_millis(500));
        join_with_timeout(batcher_handle, Duration::from_millis(500));

        self.runtimes
            .lock()
            .expect("agent runtimes lock")
            .remove(&task.id);

        outcome
    }

    fn finish_task(&self, task_id: &str, outcome: PtyOutcome) {
        let warning = outcome.warning.clone();
        let snapshot = self.update_task(task_id, |task| {
            apply_finish(task, &outcome, &now());
        });

        if let Some(task) = &snapshot {
            if task.status == TaskStatus::Succeeded {
                if let Some(warning) = warning {
                    tracing::warn!(task_id, %warning, "agent finished with a warning");
                }
                tracing::info!(task_id, exit_code = ?task.exit_code, "agent task succeeded");
            } else if task.status == TaskStatus::Failed || task.status == TaskStatus::Canceled {
                tracing::warn!(
                    task_id,
                    status = ?task.status,
                    error = ?task.error,
                    "agent task did not succeed"
                );
            }
        }
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn join_with_timeout(handle: Option<std::thread::JoinHandle<()>>, timeout: Duration) {
    let Some(handle) = handle else {
        return;
    };
    let started = Instant::now();
    while !handle.is_finished() && started.elapsed() < timeout {
        std::thread::sleep(Duration::from_millis(10));
    }
    if handle.is_finished() {
        let _ = handle.join();
    }
    // Dropping a JoinHandle detaches the thread; it will exit once the fds close.
}

/// Accepts either an absolute/relative path or a bare command name resolved
/// through `PATH` (the default `opencode` is normally installed by a package
/// manager and only reachable through `PATH`).
fn validate_binary(binary: &str) -> Result<(), String> {
    let binary = binary.trim();
    if binary.is_empty() {
        return Err("未配置 Agent 可执行文件路径".to_string());
    }

    let path = Path::new(binary);
    let looks_like_path = path.is_absolute() || binary.contains('/') || binary.contains('\\');
    if looks_like_path {
        if !path.is_file() {
            return Err(format!("Agent 可执行文件不存在：{binary}"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path)
                .map_err(|error| error.to_string())?
                .permissions()
                .mode();
            if mode & 0o111 == 0 {
                return Err(format!("Agent 可执行文件没有执行权限：{binary}"));
            }
        }
        return Ok(());
    }

    let path_var = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(binary);
        if !candidate.is_file() {
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let executable = std::fs::metadata(&candidate)
                .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
                .unwrap_or(false);
            if executable {
                return Ok(());
            }
            continue;
        }
        #[cfg(not(unix))]
        return Ok(());
    }
    Err(format!("在 PATH 中找不到 Agent 可执行文件：{binary}"))
}

/// True when the configured agent is opencode (MCP injection only applies to it).
fn is_opencode_binary(binary: &str) -> bool {
    Path::new(binary)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(binary)
        .to_ascii_lowercase()
        .contains("opencode")
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Opens Terminal.app on `opencode -s <session>` inside the task repository.
#[cfg(target_os = "macos")]
fn open_terminal_session(binary: &str, repo_path: &str, session_id: &str) -> Result<(), String> {
    let command = format!(
        "cd {} && {} -s {}",
        shell_quote(repo_path),
        shell_quote(binary),
        shell_quote(session_id)
    );
    let escaped = command.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script \"{escaped}\"\nend tell"
    );
    let status = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .status()
        .map_err(|error| format!("无法启动 Terminal：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Terminal 拒绝了恢复会话的请求".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn open_terminal_session(
    _binary: &str,
    _repo_path: &str,
    _session_id: &str,
) -> Result<(), String> {
    Err("终端恢复目前仅支持 macOS".to_string())
}

fn detect_version(binary: &str) -> Result<String, String> {
    let binary = binary.trim();
    if binary.is_empty() {
        return Err("未配置 Agent 可执行文件路径".to_string());
    }

    let mut child = std::process::Command::new(binary)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 {binary}：{error}"))?;

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() >= Duration::from_secs(5) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("{binary} --version 超时（5 秒）"));
                }
                std::thread::sleep(Duration::from_millis(80));
            }
            Err(error) => return Err(format!("等待 {binary} --version 失败：{error}")),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let version = if !stdout.is_empty() { stdout } else { stderr };

    if version.is_empty() {
        return Err(format!("{binary} --version 没有输出"));
    }
    Ok(version.lines().next().unwrap_or_default().trim().to_string())
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

// ---------------------------------------------------------------------------
// Tauri integration
// ---------------------------------------------------------------------------

pub fn init(app: &AppHandle, state: SharedState) {
    let core = Arc::new(AgentCore::new(app.clone(), state));
    core.load();
    app.manage(core.clone());
    core.spawn_worker();

    let listener_core = core.clone();
    app.listen("agent://enqueue", move |event| {
        match serde_json::from_str::<EnqueueRequest>(event.payload()) {
            Ok(request) => {
                if let Err(error) = listener_core.enqueue(&request, "notification") {
                    tracing::warn!(%error, "failed to enqueue agent task from notification");
                }
            }
            Err(error) => {
                tracing::warn!(%error, payload = event.payload(), "invalid agent://enqueue payload");
            }
        }
    });
}

pub async fn command(
    app: &AppHandle,
    _state: &SharedState,
    name: &str,
    payload: Value,
) -> Result<Value, String> {
    let core = app
        .try_state::<Arc<AgentCore>>()
        .ok_or_else(|| "Agent 模块尚未初始化".to_string())?;

    match name {
        "agent_config_get" => {
            let config = core.config_snapshot();
            Ok(json!({ "config": config }))
        }
        "agent_config_set" => {
            let patch: AgentConfigPatch = serde_json::from_value(payload)
                .map_err(|error| format!("无效的 Agent 配置：{error}"))?;
            let config = core.update_config(patch);
            Ok(json!({ "config": config }))
        }
        "agent_enqueue_bug" => {
            let request: EnqueueRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的入队参数：{error}"))?;
            let task = core.enqueue(&request, request.source.as_deref().unwrap_or("manual"))?;
            Ok(json!({ "task": task }))
        }
        "agent_tasks_list" => Ok(json!(core.tasks_state())),
        "agent_summary" => Ok(json!(core.summary())),
        "agent_open_task" => {
            let request: TaskIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的任务参数：{error}"))?;
            let task_id = request.task_id.trim();
            if task_id.is_empty() {
                return Err("缺少 taskId".to_string());
            }
            if core.task_snapshot(task_id).is_none() {
                return Err("任务不存在".to_string());
            }
            focus_main_window(app);
            let _ = app.emit("agent://focus", json!({ "taskId": task_id }));
            Ok(json!({ "opened": true }))
        }
        "agent_permission_reply" => {
            let request: PermissionReplyRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的权限回复参数：{error}"))?;
            let task_id = request.task_id.trim();
            if task_id.is_empty() {
                return Err("缺少 taskId".to_string());
            }
            let task = core
                .reply_permission(task_id, request.response, request.remember)
                .await?;
            Ok(json!({ "task": task }))
        }
        "agent_task_cancel" => {
            let request: TaskIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的取消参数：{error}"))?;
            if request.task_id.trim().is_empty() {
                return Err("缺少 taskId".to_string());
            }
            let task = core.cancel(request.task_id.trim()).await?;
            Ok(json!({ "task": task }))
        }
        "agent_task_retry" => {
            let request: TaskIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的重试参数：{error}"))?;
            if request.task_id.trim().is_empty() {
                return Err("缺少 taskId".to_string());
            }
            let task = core.retry(request.task_id.trim())?;
            Ok(json!({ "task": task }))
        }
        "agent_task_log" => {
            let request: TaskIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的日志参数：{error}"))?;
            let data = core.read_log(request.task_id.trim())?;
            Ok(json!({ "data": data }))
        }
        "agent_open_session" => {
            let request: TaskIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的恢复参数：{error}"))?;
            core.open_session(request.task_id.trim())?;
            Ok(json!({ "opened": true }))
        }
        "agent_input" => {
            let request: TaskInputRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的输入参数：{error}"))?;
            core.write_input(request.task_id.trim(), &request.data)?;
            Ok(json!({ "ok": true }))
        }
        "agent_resize" => {
            let request: TaskResizeRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的尺寸参数：{error}"))?;
            core.resize(request.task_id.trim(), request.cols, request.rows)?;
            Ok(json!({ "ok": true }))
        }
        "agent_detect" => {
            let request: DetectRequest = serde_json::from_value(payload).unwrap_or_default();
            let path = request
                .path
                .map(|path| path.trim().to_string())
                .filter(|path| !path.is_empty())
                .unwrap_or_else(|| core.config_snapshot().binary_path);
            let version = detect_version(&path)?;
            Ok(json!({ "version": version, "path": path }))
        }
        other => Err(format!("unknown agent command: {other}")),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_task(id: &str, status: TaskStatus) -> AgentTask {
        AgentTask {
            id: id.to_string(),
            workspace_id: "45336192".to_string(),
            workspace_name: "UU".to_string(),
            bug_id: "1145336192001234567".to_string(),
            title: "示例缺陷".to_string(),
            severity: "严重".to_string(),
            priority: "高".to_string(),
            md_path: "/tmp/bug.md".to_string(),
            repo_path: "/tmp/repo".to_string(),
            status,
            created_at: "2026-11-10T00:00:00Z".to_string(),
            started_at: None,
            finished_at: None,
            exit_code: None,
            log_path: "/tmp/agent.log".to_string(),
            error: None,
            prompt: "prompt".to_string(),
            source: "manual".to_string(),
            session_id: None,
            review: None,
        }
    }

    #[test]
    fn config_defaults_match_spec() {
        let config = AgentConfig::default();
        assert_eq!(config.binary_path, "opencode");
        assert!(config.repo_mappings.is_empty());
        assert_eq!(config.ready_quiet_ms, 900);
        assert_eq!(config.ready_timeout_ms, 15_000);
        assert!(config.auto_open_console);
        assert!(config.prompt_template.contains("{{md_path}}"));
        assert!(config.prompt_template.contains("{{title}}"));
    }

    #[test]
    fn config_is_sanitized() {
        let config = AgentConfig {
            binary_path: "   ".to_string(),
            repo_mappings: BTreeMap::from([
                ("1".to_string(), "  /repo  ".to_string()),
                ("2".to_string(), "   ".to_string()),
            ]),
            projects: BTreeMap::new(),
            prompt_template: "  ".to_string(),
            ready_quiet_ms: 1,
            ready_timeout_ms: 999_999,
            auto_open_console: false,
        }
        .sanitized();

        assert_eq!(config.binary_path, "opencode");
        assert_eq!(config.ready_quiet_ms, 100);
        assert_eq!(config.ready_timeout_ms, 120_000);
        assert_eq!(config.repo_mappings.len(), 0);
        assert_eq!(
            config.projects.get("1").map(|project| project.repo_path.as_str()),
            Some("/repo")
        );
        assert_eq!(config.prompt_template, DEFAULT_PROMPT_TEMPLATE);
        assert!(!config.auto_open_console);
    }

    #[test]
    fn renders_prompt_placeholders() {
        let vars = PromptVars {
            title: "标题".to_string(),
            md_path: "/exports/bug.md".to_string(),
            repo_path: "/repo".to_string(),
            workspace_name: "UU".to_string(),
            bug_id: "42".to_string(),
            severity: "严重".to_string(),
            priority: "高".to_string(),
            project_rule: "只用 Rust 写".to_string(),
        };

        let rendered = render_prompt(
            "{{title}}|{{md_path}}|{{repo_path}}|{{workspace_name}}|{{bug_id}}|{{severity}}|{{priority}}|{{unknown}}",
            &vars,
        );
        assert_eq!(
            rendered,
            "标题|/exports/bug.md|/repo|UU|42|严重|高|{{unknown}}\n\n项目规则：\n只用 Rust 写"
        );
    }

    #[test]
    fn project_rule_uses_the_explicit_slot() {
        let vars = PromptVars {
            title: "t".to_string(),
            md_path: "m".to_string(),
            repo_path: "r".to_string(),
            workspace_name: "w".to_string(),
            bug_id: "1".to_string(),
            severity: "s".to_string(),
            priority: "p".to_string(),
            project_rule: "先跑 cargo test".to_string(),
        };

        assert_eq!(
            render_prompt("规则：{{project_rule}}", &vars),
            "规则：先跑 cargo test"
        );
    }

    #[test]
    fn empty_project_rule_adds_nothing() {
        let vars = PromptVars {
            title: "t".to_string(),
            md_path: "m".to_string(),
            repo_path: "r".to_string(),
            workspace_name: "w".to_string(),
            bug_id: "1".to_string(),
            severity: "s".to_string(),
            priority: "p".to_string(),
            project_rule: String::new(),
        };

        assert_eq!(render_prompt("{{title}}", &vars), "t");
    }

    #[test]
    fn queue_helpers_follow_insertion_order() {
        let tasks = vec![
            sample_task("a", TaskStatus::Succeeded),
            sample_task("b", TaskStatus::Queued),
            sample_task("c", TaskStatus::Queued),
        ];
        assert_eq!(next_queued_index(&tasks), Some(1));
        let counts = task_counts(&tasks);
        assert_eq!(counts.queued, 2);
        assert_eq!(counts.active, 0);
        assert_eq!(counts.waiting_review, 0);
        assert_eq!(active_task_id(&tasks).as_deref(), Some("b"));

        let mut running = tasks.clone();
        running[0].status = TaskStatus::Running;
        assert_eq!(active_task_id(&running).as_deref(), Some("a"));

        let mut preparing = tasks.clone();
        preparing[2].status = TaskStatus::Preparing;
        assert_eq!(active_task_id(&preparing).as_deref(), Some("c"));
    }

    #[test]
    fn active_task_falls_back_to_latest_finished() {
        let tasks = vec![
            sample_task("old", TaskStatus::Failed),
            sample_task("new", TaskStatus::Succeeded),
        ];
        assert_eq!(active_task_id(&tasks).as_deref(), Some("new"));
        assert_eq!(next_queued_index(&tasks), None);
        assert_eq!(active_task_id(&[]), None);
    }

    #[test]
    fn finish_status_maps_exit_codes() {
        assert_eq!(finish_status(false, Some(0)), TaskStatus::Succeeded);
        assert_eq!(finish_status(false, Some(2)), TaskStatus::Failed);
        assert_eq!(finish_status(false, None), TaskStatus::Failed);
        assert_eq!(finish_status(true, Some(0)), TaskStatus::Canceled);
    }

    #[test]
    fn statuses_serialize_as_snake_case() {
        let cases = [
            (TaskStatus::Queued, "\"queued\""),
            (TaskStatus::Preparing, "\"preparing\""),
            (TaskStatus::Running, "\"running\""),
            (TaskStatus::WaitingReview, "\"waiting_review\""),
            (TaskStatus::Succeeded, "\"succeeded\""),
            (TaskStatus::Failed, "\"failed\""),
            (TaskStatus::Canceled, "\"canceled\""),
        ];
        for (status, expected) in cases {
            assert_eq!(serde_json::to_string(&status).unwrap(), expected);
            let parsed: TaskStatus = serde_json::from_str(expected).unwrap();
            assert_eq!(parsed, status);
        }
    }

    #[test]
    fn task_review_defaults_to_none_for_old_files() {
        let mut value = serde_json::to_value(sample_task("a", TaskStatus::Running)).unwrap();
        value.as_object_mut().unwrap().remove("review");
        let parsed: AgentTask = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.review, None);
    }

    #[test]
    fn repo_path_uses_the_task_value_before_config() {
        let config = AgentConfig::default();
        assert!(config.repo_mappings.is_empty());

        let mut task = sample_task("a", TaskStatus::Queued);
        task.repo_path = "/tmp/repo".to_string();
        assert_eq!(
            resolve_repo_path(&task, &config),
            Ok("/tmp/repo".to_string())
        );

        // A blank task path falls back to the per-project setting.
        let config = AgentConfig {
            projects: BTreeMap::from([(
                "45336192".to_string(),
                ProjectAgentConfig {
                    repo_path: "/configured/repo".to_string(),
                    rule: String::new(),
                },
            )]),
            ..AgentConfig::default()
        };
        let mut task = sample_task("b", TaskStatus::Queued);
        task.repo_path = "  ".to_string();
        assert_eq!(
            resolve_repo_path(&task, &config),
            Ok("/configured/repo".to_string())
        );

        let missing = AgentConfig::default();
        let mut blank = sample_task("c", TaskStatus::Queued);
        blank.repo_path = String::new();
        assert!(resolve_repo_path(&blank, &missing).is_err());
    }

    #[test]
    fn state_and_summary_serialize_camel_case() {
        let tasks = vec![sample_task("a", TaskStatus::WaitingReview)];
        let state = AgentTasksState {
            tasks: tasks.clone(),
            active_task_id: Some("a".to_string()),
            queue_length: 0,
            queued_count: 0,
            active_count: 1,
            waiting_review_count: 1,
        };
        let value = serde_json::to_value(&state).unwrap();
        assert_eq!(value["queueLength"], 0);
        assert_eq!(value["queuedCount"], 0);
        assert_eq!(value["activeCount"], 1);
        assert_eq!(value["waitingReviewCount"], 1);
        assert_eq!(value["activeTaskId"], "a");

        let summary = serde_json::to_value(agent_summary(&tasks)).unwrap();
        assert_eq!(summary["running"], true);
        assert_eq!(summary["waitingReview"], true);
        assert_eq!(summary["activeTaskId"], "a");
        assert_eq!(summary["workspaceName"], "UU");
        assert_eq!(summary["bugId"], "1145336192001234567");
    }

    #[test]
    fn counts_and_summary_track_review_tasks() {
        let mut tasks = vec![
            sample_task("done", TaskStatus::Succeeded),
            sample_task("running", TaskStatus::Running),
            sample_task("waiting", TaskStatus::WaitingReview),
            sample_task("queued", TaskStatus::Queued),
        ];
        tasks[2].review = Some(PermissionReview {
            id: "per_1".to_string(),
            session_id: "ses_1".to_string(),
            action: "edit".to_string(),
            resource: "src/main.rs".to_string(),
            title: "允许编辑".to_string(),
        });

        let counts = task_counts(&tasks);
        assert_eq!(counts.queued, 1);
        assert_eq!(counts.active, 2);
        assert_eq!(counts.waiting_review, 1);

        let summary = agent_summary(&tasks);
        assert!(summary.running);
        assert!(summary.waiting_review);
        // The first active task in list order is the running one.
        assert_eq!(summary.active_task_id.as_deref(), Some("running"));
        assert_eq!(summary.title.as_deref(), Some("示例缺陷"));
        assert_eq!(summary.workspace_name.as_deref(), Some("UU"));
        assert_eq!(summary.bug_id.as_deref(), Some("1145336192001234567"));

        let mut only_waiting = vec![sample_task("waiting", TaskStatus::WaitingReview)];
        assert_eq!(
            agent_summary(&only_waiting).active_task_id.as_deref(),
            Some("waiting")
        );
        only_waiting.clear();
        assert_eq!(agent_summary(&only_waiting), AgentSummary::default());
    }

    #[test]
    fn finish_never_downgrades_a_terminal_task() {
        let mut task = sample_task("a", TaskStatus::Running);
        let outcome = PtyOutcome {
            exit_code: Some(0),
            ..PtyOutcome::default()
        };
        assert!(apply_finish(&mut task, &outcome, "2026-11-10T01:00:00Z"));
        assert_eq!(task.status, TaskStatus::Succeeded);

        // A later PTY exit with a non-zero code must not downgrade it.
        let late = PtyOutcome {
            exit_code: Some(2),
            error: Some("late".to_string()),
            ..PtyOutcome::default()
        };
        assert!(!apply_finish(&mut task, &late, "2026-11-10T01:00:01Z"));
        assert_eq!(task.status, TaskStatus::Succeeded);
        assert_eq!(task.error, None);
    }

    #[test]
    fn completion_marks_success_without_an_exit_code() {
        let mut task = sample_task("a", TaskStatus::Running);
        let outcome = PtyOutcome {
            completed: true,
            ..PtyOutcome::default()
        };
        assert!(apply_finish(&mut task, &outcome, "2026-11-10T01:00:00Z"));
        assert_eq!(task.status, TaskStatus::Succeeded);
        assert_eq!(task.exit_code, None);
        assert_eq!(task.finished_at.as_deref(), Some("2026-11-10T01:00:00Z"));
    }

    #[test]
    fn cancellation_and_failure_are_applied() {
        let mut task = sample_task("a", TaskStatus::WaitingReview);
        let outcome = PtyOutcome {
            canceled: true,
            ..PtyOutcome::default()
        };
        assert!(apply_finish(&mut task, &outcome, "2026-11-10T01:00:00Z"));
        assert_eq!(task.status, TaskStatus::Canceled);

        let mut task = sample_task("b", TaskStatus::Running);
        let outcome = PtyOutcome {
            exit_code: Some(1),
            ..PtyOutcome::default()
        };
        assert!(apply_finish(&mut task, &outcome, "2026-11-10T01:00:00Z"));
        assert_eq!(task.status, TaskStatus::Failed);
        assert_eq!(task.error.as_deref(), Some("Agent 进程退出码 1"));
    }

    #[test]
    fn recovery_marks_only_in_flight_tasks() {
        let mut tasks = vec![
            sample_task("queued", TaskStatus::Queued),
            sample_task("preparing", TaskStatus::Preparing),
            sample_task("running", TaskStatus::Running),
            sample_task("waiting", TaskStatus::WaitingReview),
            sample_task("done", TaskStatus::Succeeded),
        ];

        let recovered = recover_incomplete(&mut tasks, "2026-11-10T01:00:00Z");
        assert_eq!(recovered, 3);
        assert_eq!(tasks[0].status, TaskStatus::Queued);
        assert_eq!(tasks[1].status, TaskStatus::Failed);
        assert_eq!(tasks[1].error.as_deref(), Some("客户端重启"));
        assert_eq!(tasks[1].finished_at.as_deref(), Some("2026-11-10T01:00:00Z"));
        assert_eq!(tasks[2].status, TaskStatus::Failed);
        assert_eq!(tasks[3].status, TaskStatus::Failed);
        assert_eq!(tasks[4].status, TaskStatus::Succeeded);
    }

    #[test]
    fn validates_bare_command_names() {
        assert!(validate_binary("").is_err());
        assert!(validate_binary("/definitely/not/a/binary").is_err());
        assert!(validate_binary("definitely-not-a-real-command-xyz").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn pty_smoke_test_with_shell_script() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!(
            "tapd-agent-pty-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let script = dir.join("fake-agent.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\nprintf 'pty-smoke-ok\\n'\nsleep 0.1\n",
        )
        .expect("write script");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .expect("chmod");

        let handles = open_pty(script.to_str().unwrap(), &[], &[], &dir, 80, 24).expect("open pty");
        let PtyHandles {
            master,
            writer,
            mut reader,
            mut child,
        } = handles;

        let reader_handle = std::thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = reader.read_to_end(&mut buffer);
            String::from_utf8_lossy(&buffer).to_string()
        });

        let status = child.wait().expect("wait child");
        let output = reader_handle.join().expect("join reader");
        drop((master, writer));

        assert!(status.success(), "exit status: {status}");
        assert!(output.contains("pty-smoke-ok"), "output: {output:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
