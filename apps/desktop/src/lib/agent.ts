import { featureCommand } from "./feature";

export type AgentTaskStatus =
  | "queued"
  | "preparing"
  | "running"
  | "waiting_review"
  | "succeeded"
  | "failed"
  | "canceled";

/** Per-project agent settings, edited from the project card in settings. */
export type ProjectAgentConfig = {
  repoPath: string;
  rule: string;
};

export type AgentConfig = {
  binaryPath: string;
  /** Legacy: migrated into `projects` on load. */
  repoMappings: Record<string, string>;
  projects: Record<string, ProjectAgentConfig>;
  promptTemplate: string;
  readyQuietMs: number;
  readyTimeoutMs: number;
  autoOpenConsole: boolean;
};

/** A pending opencode permission prompt that needs a human decision. */
export type AgentReviewRequest = {
  id: string;
  sessionId: string;
  action: string;
  resource: string;
  title: string;
};

export type AgentTask = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  bugId: string;
  title: string;
  severity: string;
  priority: string;
  mdPath: string;
  repoPath: string;
  status: AgentTaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  logPath: string;
  error?: string;
  prompt: string;
  source: string;
  /** Present while the agent waits for a permission decision. */
  review?: AgentReviewRequest | null;
};

export type AgentTasksState = {
  tasks: AgentTask[];
  activeTaskId: string | null;
  /** Kept for compatibility: number of `queued` tasks. */
  queueLength: number;
  queuedCount?: number;
  activeCount?: number;
  waitingReviewCount?: number;
};

/** Lightweight agent state for the island capsule. */
export type AgentSummary = {
  running: boolean;
  waitingReview: boolean;
  activeTaskId: string | null;
  title: string | null;
  workspaceName: string | null;
  bugId: string | null;
};

export type PermissionReply = "once" | "always" | "reject";

export type AgentEnqueueRequest = {
  workspaceId: string;
  bugId: string;
  workspaceName?: string | null;
  title?: string | null;
  severity?: string | null;
  priority?: string | null;
};

export type AgentOutputPayload = {
  taskId: string;
  data: string;
};

export const AGENT_STATUS_LABELS: Record<AgentTaskStatus, string> = {
  queued: "排队中",
  preparing: "准备中",
  running: "运行中",
  waiting_review: "待审核",
  succeeded: "已完成",
  failed: "失败",
  canceled: "已取消",
};

export const AGENT_STATUS_TONES: Record<
  AgentTaskStatus,
  "neutral" | "blue" | "green" | "amber" | "red"
> = {
  queued: "neutral",
  preparing: "blue",
  running: "amber",
  waiting_review: "red",
  succeeded: "green",
  failed: "red",
  canceled: "neutral",
};

export const agentApi = {
  configGet: () => featureCommand<{ config: AgentConfig }>("agent_config_get"),
  configSet: (patch: Partial<AgentConfig>) =>
    featureCommand<{ config: AgentConfig }>("agent_config_set", patch),
  enqueueBug: (request: AgentEnqueueRequest) =>
    featureCommand<{ task: AgentTask }>("agent_enqueue_bug", request),
  tasksList: () => featureCommand<AgentTasksState>("agent_tasks_list"),
  summary: () => featureCommand<AgentSummary>("agent_summary"),
  cancel: (taskId: string) =>
    featureCommand<{ task: AgentTask }>("agent_task_cancel", { taskId }),
  retry: (taskId: string) =>
    featureCommand<{ task: AgentTask }>("agent_task_retry", { taskId }),
  taskLog: (taskId: string) =>
    featureCommand<{ data: string }>("agent_task_log", { taskId }),
  /** Focus the main window and select this task in the Agent tab. */
  openTask: (taskId: string) =>
    featureCommand<{ opened: boolean }>("agent_open_task", { taskId }),
  /** Answer a pending opencode permission prompt. */
  permissionReply: (taskId: string, response: PermissionReply, remember = true) =>
    featureCommand<{ task: AgentTask }>("agent_permission_reply", {
      taskId,
      response,
      remember,
    }),
  input: (taskId: string, data: string) =>
    featureCommand<{ ok: boolean }>("agent_input", { taskId, data }),
  resize: (taskId: string, cols: number, rows: number) =>
    featureCommand<{ ok: boolean }>("agent_resize", { taskId, cols, rows }),
  detect: (path?: string) =>
    featureCommand<{ version: string; path: string }>("agent_detect", {
      path: path ?? null,
    }),
};

/** Directory containing `bug.md`, for the console's "open export folder" action. */
export const exportDirFor = (mdPath: string): string | null => {
  if (!mdPath) return null;
  const index = mdPath.lastIndexOf("/");
  if (index <= 0) return null;
  return mdPath.slice(0, index);
};
