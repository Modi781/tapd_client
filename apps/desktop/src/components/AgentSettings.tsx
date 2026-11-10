import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Bot,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  Square,
  Terminal,
} from "lucide-react";

import {
  AGENT_STATUS_LABELS,
  AGENT_STATUS_TONES,
  agentApi,
  type AgentConfig,
  type AgentTask,
  type AgentTasksState,
} from "../lib/agent";
import { api, relativeTime } from "../lib/api";
import type { SettingsSectionProps } from "../lib/feature";
import { Badge, Button, Spinner } from "./ui";

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none transition placeholder:text-slate-300 focus:border-sky-300 focus:ring-2 focus:ring-sky-100";

const PROMPT_VARIABLES = [
  "{{title}}",
  "{{md_path}}",
  "{{repo_path}}",
  "{{workspace_name}}",
  "{{bug_id}}",
  "{{severity}}",
  "{{priority}}",
  "{{project_rule}}",
];

export function AgentSettings({ toast }: SettingsSectionProps) {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [tasksState, setTasksState] = useState<AgentTasksState | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [busyTask, setBusyTask] = useState<string | null>(null);

  const refreshTasks = useCallback(async () => {
    try {
      setTasksState(await agentApi.tasksList());
    } catch (error) {
      toast("error", String(error));
    }
  }, [toast]);

  useEffect(() => {
    void agentApi
      .configGet()
      .then(({ config: next }) => setConfig(next))
      .catch((error) => toast("error", String(error)));

    void refreshTasks();

    let unlisten: (() => void) | undefined;
    void listen<AgentTasksState>("agent://state", (event) => {
      setTasksState(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [refreshTasks, toast]);

  const patchConfig = (patch: Partial<AgentConfig>) => {
    setConfig((current) => (current ? { ...current, ...patch } : current));
  };

  /** Persists the whole config; called on blur / on toggle, there is no save button. */
  const commit = async (patch?: Partial<AgentConfig>) => {
    const base = config;
    if (!base) return;
    const next = { ...base, ...(patch ?? {}) };
    setConfig(next);
    try {
      const { config: saved } = await agentApi.configSet({
        binaryPath: next.binaryPath,
        promptTemplate: next.promptTemplate,
        readyQuietMs: finiteOr(next.readyQuietMs, 900),
        readyTimeoutMs: finiteOr(next.readyTimeoutMs, 15_000),
        autoOpenConsole: next.autoOpenConsole,
      });
      setConfig(saved);
    } catch (error) {
      toast("error", String(error));
    }
  };

  const handleDetect = async () => {
    setDetecting(true);
    try {
      const result = await agentApi.detect(config?.binaryPath);
      setVersion(result.version);
      toast("ok", `检测到 ${result.path}：${result.version}`);
    } catch (error) {
      setVersion(null);
      toast("error", String(error));
    } finally {
      setDetecting(false);
    }
  };

  const runTaskAction = async (
    taskId: string,
    action: () => Promise<unknown>,
    okMessage: string,
  ) => {
    setBusyTask(taskId);
    try {
      await action();
      toast("ok", okMessage);
      await refreshTasks();
    } catch (error) {
      toast("error", String(error));
    } finally {
      setBusyTask(null);
    }
  };

  const openConsole = () => {
    void agentApi
      .openConsole()
      .catch((error) => toast("error", String(error)));
  };

  const queue = tasksState?.tasks.slice().reverse() ?? [];

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Bot size={15} className="text-slate-400" />
              Agent 修复
            </h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              在本地仓库启动 opencode 完整 TUI，自动注入缺陷任务；队列严格串行（并发 1）。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              onClick={() => void handleDetect()}
              loading={detecting}
              icon={<Terminal size={13} />}
            >
              检测版本
            </Button>
          </div>
        </div>

        {!config ? (
          <div className="mt-4 flex items-center gap-2 text-xs text-slate-400">
            <Spinner />
            读取 Agent 配置…
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div>
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-medium text-slate-600">
                  opencode 可执行路径
                </label>
                {version ? (
                  <Badge tone="green">{version}</Badge>
                ) : (
                  <span className="text-[10px] text-slate-400">
                    可填相对命令名（走 PATH）或绝对路径
                  </span>
                )}
              </div>
              <input
                value={config.binaryPath}
                onChange={(event) => patchConfig({ binaryPath: event.target.value })}
                onBlur={() => void commit()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                placeholder="opencode"
                className={`${INPUT_CLASS} mt-1.5 font-mono`}
              />
            </div>

            <div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-slate-600">
                  提示词模板
                </span>
                <span className="text-[10px] text-slate-400">
                  支持变量：{PROMPT_VARIABLES.join(" ")}
                </span>
              </div>
              <textarea
                value={config.promptTemplate}
                onChange={(event) =>
                  patchConfig({ promptTemplate: event.target.value })
                }
                onBlur={() => void commit()}
                rows={11}
                className={`${INPUT_CLASS} mt-1.5 resize-y leading-5`}
              />
              <div className="mt-1.5 flex flex-wrap gap-1">
                {PROMPT_VARIABLES.map((variable) => (
                  <span
                    key={variable}
                    className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500"
                  >
                    {variable}
                  </span>
                ))}
              </div>
              <p className="mt-1.5 text-[10px] leading-4 text-slate-400">
                仓库文件夹和项目规则在「项目」卡片里配置；模板含{" "}
                <code className="rounded bg-slate-100 px-1 font-mono">{"{{project_rule}}"}</code>{" "}
                时按位置插入，否则追加到末尾。
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <NumberField
                label="就绪静默（ms）"
                hint="输出静默达到该时长后注入任务"
                value={config.readyQuietMs}
                onChange={(value) => patchConfig({ readyQuietMs: value })}
                onCommit={() => void commit()}
              />
              <NumberField
                label="就绪超时（ms）"
                hint="超时后强制注入并记录 warning"
                value={config.readyTimeoutMs}
                onChange={(value) => patchConfig({ readyTimeoutMs: value })}
                onCommit={() => void commit()}
              />
              <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
                <div className="text-[10px] uppercase tracking-wide text-slate-400">
                  打开控制台
                </div>
                <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={config.autoOpenConsole}
                    onChange={(event) =>
                      void commit({ autoOpenConsole: event.target.checked })
                    }
                    className="h-3.5 w-3.5 accent-sky-600"
                  />
                  任务开始时自动打开
                </label>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Terminal size={15} className="text-slate-400" />
              Agent 队列
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              串行执行；运行中可在控制台直接接管输入。任务记录保存在数据目录。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge tone="neutral">队列 {tasksState?.queueLength ?? 0}</Badge>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void refreshTasks()}
              icon={<RefreshCw size={13} />}
            >
              刷新
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={openConsole}
              icon={<Terminal size={13} />}
            >
              打开控制台
            </Button>
          </div>
        </div>

        <div className="mt-3 space-y-2">
          {queue.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 p-4 text-xs text-slate-400">
              还没有 Agent 任务。打开缺陷详情点击「用 Agent 修复」。
            </div>
          ) : (
            queue.slice(0, 20).map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                busy={busyTask === task.id}
                onCancel={() =>
                  void runTaskAction(
                    task.id,
                    () => agentApi.cancel(task.id),
                    "已取消任务",
                  )
                }
                onRetry={() =>
                  void runTaskAction(
                    task.id,
                    () => agentApi.retry(task.id),
                    "已重新加入队列",
                  )
                }
                onOpenLog={() =>
                  void api
                    .openPath(task.logPath)
                    .catch((error) => toast("error", String(error)))
                }
                onOpenConsole={openConsole}
              />
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function NumberField(props: {
  label: string;
  hint: string;
  value: number;
  onChange: (value: number) => void;
  onCommit?: () => void;
}) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">
        {props.label}
      </div>
      <input
        type="number"
        min={0}
        value={Number.isFinite(props.value) ? props.value : ""}
        onChange={(event) => props.onChange(Number(event.target.value))}
        onBlur={props.onCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className={`${INPUT_CLASS} mt-1.5 font-mono`}
      />
      <div className="mt-1 text-[10px] leading-4 text-slate-400">{props.hint}</div>
    </div>
  );
}

function TaskRow(props: {
  task: AgentTask;
  busy: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onOpenLog: () => void;
  onOpenConsole: () => void;
}) {
  const { task } = props;
  const running =
    task.status === "queued" ||
    task.status === "preparing" ||
    task.status === "running";
  const retryable =
    task.status === "failed" ||
    task.status === "canceled" ||
    task.status === "succeeded";

  return (
    <div className="rounded-xl border border-slate-100 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={AGENT_STATUS_TONES[task.status]}>
          {AGENT_STATUS_LABELS[task.status]}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700">
          {task.title}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-slate-400">
          {task.workspaceName || task.workspaceId} #{task.bugId.slice(-7)}
        </span>
        <span className="shrink-0 text-[10px] text-slate-400">
          {relativeTime(task.createdAt)}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-slate-400">
        <span className="truncate font-mono" title={task.repoPath}>
          {task.repoPath || "未配置仓库"}
        </span>
        {task.exitCode !== undefined ? (
          <span className="shrink-0">exit {task.exitCode}</span>
        ) : null}
        <span className="shrink-0">来源 {task.source}</span>
      </div>

      {task.error ? (
        <div className="mt-1.5 break-all rounded-lg bg-rose-50 px-2 py-1 text-[10px] leading-4 text-rose-600">
          {task.error}
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-1.5">
        <TinyButton
          onClick={props.onCancel}
          disabled={!running || props.busy}
          icon={<Square size={10} />}
        >
          取消
        </TinyButton>
        <TinyButton
          onClick={props.onRetry}
          disabled={!retryable || props.busy}
          icon={<RotateCcw size={10} />}
        >
          重试
        </TinyButton>
        <TinyButton onClick={props.onOpenLog} icon={<FolderOpen size={10} />}>
          打开日志
        </TinyButton>
        <TinyButton onClick={props.onOpenConsole} icon={<Terminal size={10} />}>
          控制台
        </TinyButton>
      </div>
    </div>
  );
}

function TinyButton(props: {
  onClick: () => void;
  disabled?: boolean;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[10px] text-slate-600 transition hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {props.icon}
      {props.children}
    </button>
  );
}
