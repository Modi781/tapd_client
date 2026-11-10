//! M7 — opencode agent queue, PTY session and console window.
//!
//! Owned by the M7 implementation. Exposed through `feature_command` names
//! starting with `agent_`.
//!
//! Design notes:
//! - The queue is strictly serial: one tokio worker picks `queued` tasks and
//!   runs them one at a time. Commands never start tasks directly.
//! - PTY work happens on dedicated std threads (reader, batcher, wait) so the
//!   async worker only awaits a oneshot result.
//! - All task state changes are persisted atomically and broadcast through
//!   `agent://state`. Terminal output is batched and sent via `agent://output`.

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
use tauri::{
    AppHandle, Emitter, Listener, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tapd_core::store::{read_json, write_json_atomic};

use crate::state::SharedState;

pub const CONSOLE_LABEL: &str = "agent-console";

const CONFIG_FILE: &str = "agent.json";
const TASKS_FILE: &str = "agent-tasks.json";
const LOG_DIR: &str = "agent-logs";

const DEFAULT_BINARY: &str = "opencode";
const MAX_LOG_TAIL_BYTES: usize = 400 * 1024;

pub const DEFAULT_PROMPT_TEMPLATE: &str = "请修复 TAPD 缺陷：{{title}}\n\n缺陷详情文件：{{md_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n要求：\n1. 先完整阅读 bug.md 和 assets/ 下的截图、视频。\n2. 定位根因，做最小必要修改。\n3.修复时请遵循团队代码规范，确保代码可读、可维护。\n4. 修复完成后，提交代码并在 TAPD 中更新缺陷状态并简要评论原由以及解决方案和修复影响范围。";

/// Previous default; migrated on load so existing installs pick up the new
/// commit + TAPD write-back instructions.
const LEGACY_PROMPT_TEMPLATE: &str = "请修复 TAPD 缺陷：{{title}}\n\n缺陷详情文件：{{md_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n要求：\n1. 先完整阅读 bug.md 和 assets/ 下的截图、视频。\n2. 定位根因，做最小必要修改。\n3. 修改后运行相关测试或构建。\n4. 不要自行 git commit / push，完成后说明改了哪些文件。";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentConfig {
    pub binary_path: String,
    /// TAPD workspace id -> absolute local repository path.
    pub repo_mappings: BTreeMap<String, String>,
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
            || self.prompt_template.trim() == LEGACY_PROMPT_TEMPLATE
        {
            self.prompt_template = DEFAULT_PROMPT_TEMPLATE.to_string();
        }

        self.ready_quiet_ms = self.ready_quiet_ms.clamp(100, 10_000);
        self.ready_timeout_ms = self.ready_timeout_ms.clamp(1_000, 120_000);
        self.repo_mappings = self
            .repo_mappings
            .into_iter()
            .map(|(key, value)| (key, value.trim().to_string()))
            .filter(|(_, value)| !value.is_empty())
            .collect();
        self
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AgentConfigPatch {
    binary_path: Option<String>,
    repo_mappings: Option<BTreeMap<String, String>>,
    prompt_template: Option<String>,
    ready_quiet_ms: Option<u64>,
    ready_timeout_ms: Option<u64>,
    auto_open_console: Option<bool>,
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Queued,
    Preparing,
    Running,
    Succeeded,
    Failed,
    Canceled,
}

impl TaskStatus {
    fn is_active(self) -> bool {
        matches!(self, Self::Preparing | Self::Running)
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
    queue_length: usize,
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
        }
    }
}

/// Replaces `{{variable}}` placeholders; unknown placeholders are left intact.
pub fn render_prompt(template: &str, vars: &PromptVars) -> String {
    let pairs = [
        ("title", vars.title.as_str()),
        ("md_path", vars.md_path.as_str()),
        ("repo_path", vars.repo_path.as_str()),
        ("workspace_name", vars.workspace_name.as_str()),
        ("bug_id", vars.bug_id.as_str()),
        ("severity", vars.severity.as_str()),
        ("priority", vars.priority.as_str()),
    ];

    let mut rendered = template.to_string();
    for (key, value) in pairs {
        rendered = rendered.replace(&format!("{{{{{key}}}}}"), value);
    }
    rendered
}

fn next_queued_index(tasks: &[AgentTask]) -> Option<usize> {
    tasks
        .iter()
        .position(|task| task.status == TaskStatus::Queued)
}

fn queue_length(tasks: &[AgentTask]) -> usize {
    tasks
        .iter()
        .filter(|task| task.status == TaskStatus::Queued)
        .count()
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

fn finish_status(canceled: bool, exit_code: Option<i32>) -> TaskStatus {
    if canceled {
        TaskStatus::Canceled
    } else if exit_code == Some(0) {
        TaskStatus::Succeeded
    } else {
        TaskStatus::Failed
    }
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

fn open_pty(binary: &str, cwd: &Path, cols: u16, rows: u16) -> Result<PtyHandles, String> {
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
    canceled: Arc<AtomicBool>,
}

#[derive(Debug, Default)]
struct PtyOutcome {
    exit_code: Option<i32>,
    canceled: bool,
    warning: Option<String>,
    error: Option<String>,
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

pub struct AgentCore {
    app: AppHandle,
    state: SharedState,
    config: Mutex<AgentConfig>,
    tasks: Mutex<Vec<AgentTask>>,
    runtimes: Mutex<HashMap<String, Arc<Mutex<AgentRuntime>>>>,
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
    }

    fn tasks_state(&self) -> AgentTasksState {
        let tasks = self.tasks.lock().expect("agent tasks lock").clone();
        AgentTasksState {
            active_task_id: active_task_id(&tasks),
            queue_length: queue_length(&tasks),
            tasks,
        }
    }

    fn emit_state(&self) {
        let state = self.tasks_state();
        let _ = self.app.emit("agent://state", state);
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
            if task.status == TaskStatus::Canceled {
                if task.finished_at.is_none() {
                    task.finished_at = Some(now());
                }
                return;
            }
            task.status = TaskStatus::Failed;
            task.error = Some(message);
            task.finished_at = Some(now());
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
        let repo_path = config
            .repo_mappings
            .get(workspace_id)
            .cloned()
            .unwrap_or_default();

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

    fn cancel(&self, task_id: &str) -> Result<AgentTask, String> {
        let snapshot = {
            let mut tasks = self.tasks.lock().expect("agent tasks lock");
            let task = tasks
                .iter_mut()
                .find(|task| task.id == task_id)
                .ok_or_else(|| "任务不存在".to_string())?;

            if task.status.is_terminal() {
                return Err("任务已经结束，无需取消".to_string());
            }
            task.status = TaskStatus::Canceled;
            task.finished_at = Some(now());
            if task.error.is_none() {
                task.error = Some("已取消".to_string());
            }
            task.clone()
        };

        let runtime = self
            .runtimes
            .lock()
            .expect("agent runtimes lock")
            .get(task_id)
            .cloned();
        if let Some(runtime) = runtime {
            let mut runtime = runtime.lock().expect("agent runtime lock");
            runtime.canceled.store(true, Ordering::SeqCst);
            if let Err(error) = runtime.killer.kill() {
                tracing::warn!(task_id, %error, "failed to kill agent process");
            }
        }

        self.persist_tasks();
        self.emit_state();
        Ok(snapshot)
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
                core.run_task(task).await;
            }
        });

        // Resume work left over from a previous session.
        if next_queued_index(&self.tasks.lock().expect("agent tasks lock")).is_some() {
            self.wake.notify_one();
        }
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

        // 2. Resolve the repository mapping.
        let Some(repo_path) = config
            .repo_mappings
            .get(&task.workspace_id)
            .map(|path| path.trim().to_string())
            .filter(|path| !path.is_empty())
        else {
            self.fail_task(
                &task.id,
                "未配置项目仓库路径，请在 设置 → Agent 修复 中配置".to_string(),
            );
            return;
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

        task.prompt = render_prompt(&config.prompt_template, &PromptVars::from_task(&task));

        // 4. Move to `running` with the resolved paths, then start the PTY.
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

        // 5. Reveal the console so the user can watch / take over.
        if config.auto_open_console {
            if let Err(error) = open_console_window(&self.app) {
                tracing::warn!(%error, "failed to open agent console window");
            }
        }

        // 6. Run the PTY on a dedicated thread and await its exit result.
        let (sender, receiver) = tokio::sync::oneshot::channel::<PtyOutcome>();
        let core = self.clone();
        let pty_task = running_task.clone();
        let pty_config = config.clone();
        std::thread::Builder::new()
            .name(format!("agent-pty-{}", pty_task.id))
            .spawn(move || {
                let outcome = core.run_pty(&pty_task, &pty_config);
                let _ = sender.send(outcome);
            })
            .map_err(|error| tracing::warn!(%error, "failed to spawn agent pty thread"))
            .ok();

        let outcome = match receiver.await {
            Ok(outcome) => outcome,
            Err(_) => PtyOutcome {
                error: Some("Agent 终端线程意外结束".to_string()),
                ..PtyOutcome::default()
            },
        };

        self.finish_task(&task.id, outcome);
    }

    fn run_pty(&self, task: &AgentTask, config: &AgentConfig) -> PtyOutcome {
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
                let _ = runtime.killer.kill();
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
            if let Err(error) = injected {
                warning = Some(match warning {
                    Some(existing) => format!("{existing}；注入任务失败：{error}"),
                    None => format!("注入任务失败：{error}"),
                });
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
            let was_canceled = task.status == TaskStatus::Canceled || outcome.canceled;
            task.finished_at = Some(now());
            task.exit_code = outcome.exit_code;

            if was_canceled {
                task.status = TaskStatus::Canceled;
                if task.error.is_none() {
                    task.error = Some("已取消".to_string());
                }
                return;
            }

            let status = finish_status(false, outcome.exit_code);
            if status == TaskStatus::Succeeded {
                task.status = TaskStatus::Succeeded;
                task.error = None;
            } else {
                let message = outcome.error.clone().unwrap_or_else(|| {
                    match outcome.exit_code {
                        Some(code) => format!("Agent 进程退出码 {code}"),
                        None => "Agent 进程异常结束".to_string(),
                    }
                });
                task.status = TaskStatus::Failed;
                task.error = Some(message);
            }
        });

        if let Some(task) = &snapshot {
            if task.status == TaskStatus::Succeeded {
                if let Some(warning) = warning {
                    tracing::warn!(task_id, %warning, "agent finished with a warning");
                }
                tracing::info!(task_id, exit_code = ?task.exit_code, "agent task succeeded");
            } else {
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

fn open_console_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(CONSOLE_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(window);
    }

    let window = WebviewWindowBuilder::new(
        app,
        CONSOLE_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("Agent 控制台")
    .inner_size(1120.0, 760.0)
    .min_inner_size(760.0, 480.0)
    .build()
    .map_err(|error| error.to_string())?;

    let _ = window.set_focus();
    Ok(window)
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
        "agent_task_cancel" => {
            let request: TaskIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的取消参数：{error}"))?;
            if request.task_id.trim().is_empty() {
                return Err("缺少 taskId".to_string());
            }
            let task = core.cancel(request.task_id.trim())?;
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
        "agent_console_open" => {
            open_console_window(app)?;
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
            prompt_template: "  ".to_string(),
            ready_quiet_ms: 1,
            ready_timeout_ms: 999_999,
            auto_open_console: false,
        }
        .sanitized();

        assert_eq!(config.binary_path, "opencode");
        assert_eq!(config.ready_quiet_ms, 100);
        assert_eq!(config.ready_timeout_ms, 120_000);
        assert_eq!(config.repo_mappings.len(), 1);
        assert_eq!(config.repo_mappings.get("1").map(String::as_str), Some("/repo"));
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
        };

        let rendered = render_prompt(
            "{{title}}|{{md_path}}|{{repo_path}}|{{workspace_name}}|{{bug_id}}|{{severity}}|{{priority}}|{{unknown}}",
            &vars,
        );
        assert_eq!(
            rendered,
            "标题|/exports/bug.md|/repo|UU|42|严重|高|{{unknown}}"
        );
    }

    #[test]
    fn queue_helpers_follow_insertion_order() {
        let tasks = vec![
            sample_task("a", TaskStatus::Succeeded),
            sample_task("b", TaskStatus::Queued),
            sample_task("c", TaskStatus::Queued),
        ];
        assert_eq!(next_queued_index(&tasks), Some(1));
        assert_eq!(queue_length(&tasks), 2);
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
    fn recovery_marks_only_in_flight_tasks() {
        let mut tasks = vec![
            sample_task("queued", TaskStatus::Queued),
            sample_task("preparing", TaskStatus::Preparing),
            sample_task("running", TaskStatus::Running),
            sample_task("done", TaskStatus::Succeeded),
        ];

        let recovered = recover_incomplete(&mut tasks, "2026-11-10T01:00:00Z");
        assert_eq!(recovered, 2);
        assert_eq!(tasks[0].status, TaskStatus::Queued);
        assert_eq!(tasks[1].status, TaskStatus::Failed);
        assert_eq!(tasks[1].error.as_deref(), Some("客户端重启"));
        assert_eq!(tasks[1].finished_at.as_deref(), Some("2026-11-10T01:00:00Z"));
        assert_eq!(tasks[2].status, TaskStatus::Failed);
        assert_eq!(tasks[3].status, TaskStatus::Succeeded);
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

        let handles = open_pty(script.to_str().unwrap(), &dir, 80, 24).expect("open pty");
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
