import { featureCommand } from "./feature";

export type AgentTaskStatus =
  | "queued"
  | "preparing"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export type AgentConfig = {
  binaryPath: string;
  repoMappings: Record<string, string>;
  promptTemplate: string;
  readyQuietMs: number;
  readyTimeoutMs: number;
  autoOpenConsole: boolean;
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
};

export type AgentTasksState = {
  tasks: AgentTask[];
  activeTaskId: string | null;
  queueLength: number;
};

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
  cancel: (taskId: string) =>
    featureCommand<{ task: AgentTask }>("agent_task_cancel", { taskId }),
  retry: (taskId: string) =>
    featureCommand<{ task: AgentTask }>("agent_task_retry", { taskId }),
  taskLog: (taskId: string) =>
    featureCommand<{ data: string }>("agent_task_log", { taskId }),
  openConsole: () => featureCommand<{ opened: boolean }>("agent_console_open"),
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
