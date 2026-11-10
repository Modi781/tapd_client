import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Ban,
  Bot,
  Bug,
  Check,
  CheckCheck,
  ExternalLink,
  FolderOpen,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Square,
  Terminal,
  X,
} from "lucide-react";

import {
  AGENT_STATUS_LABELS,
  AGENT_STATUS_TONES,
  agentApi,
  exportDirFor,
  type AgentTask,
  type AgentTaskStatus,
  type AgentTasksState,
  type PermissionReply,
} from "../lib/agent";
import { AgentHistory } from "./AgentHistory";
import { AgentTerminal } from "./AgentTerminal";
import { Segmented } from "./Segmented";
import { Badge, Button } from "./ui";

const ACTIVE_STATUSES: AgentTaskStatus[] = [
  "queued",
  "preparing",
  "running",
  "waiting_review",
];
const isActiveStatus = (status: AgentTaskStatus) => ACTIVE_STATUSES.includes(status);

type Props = {
  /** Task selected by the island capsule (`agent://focus`). */
  focusTaskId: string | null;
  /** Jump to the bug a task belongs to (selects workspace + opens drawer). */
  onOpenBug: (workspaceId: string, bugId: string) => void;
  toast: (kind: "ok" | "error", text: string) => void;
};

type Tab = "run" | "history";

/**
 * Agent workspace: "运行" (active queue, review, logs/resume) and "历史"
 * (terminal execution records, logs and bug links).
 */
export function AgentPage({ focusTaskId, onOpenBug, toast }: Props) {
  const [tasksState, setTasksState] = useState<AgentTasksState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>("run");
  // Task explicitly selected by `agent://focus`; cleared when the active task changes.
  const [explicitTaskId, setExplicitTaskId] = useState<string | null>(null);
  const [permissionBusy, setPermissionBusy] = useState<PermissionReply | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [resumeBusy, setResumeBusy] = useState<string | null>(null);

  const appliedFocusRef = useRef<string | null>(null);
  const focusRefreshRef = useRef<string | null>(null);

  const tasks = tasksState?.tasks ?? [];
  const activeTaskId = tasksState?.activeTaskId ?? null;
  const runTasks = tasks.filter((task) => isActiveStatus(task.status));
  const historyTasks = tasks.filter((task) => !isActiveStatus(task.status));

  const refresh = useCallback(async () => {
    try {
      setTasksState(await agentApi.tasksList());
    } catch (error) {
      toast("error", String(error));
    } finally {
      setLoaded(true);
    }
  }, [toast]);

  // Initial snapshot plus every state change pushed by the Rust side.
  useEffect(() => {
    void refresh();

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<AgentTasksState>("agent://state", (event) => {
      if (!cancelled) setTasksState(event.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refresh]);

  // A focused task stays selected until the queue moves to a different task.
  useEffect(() => {
    setExplicitTaskId(null);
  }, [activeTaskId]);

  // Follow the island capsule's focus request. Terminal tasks belong to the
  // history tab; active/queued ones to the run tab.
  useEffect(() => {
    if (!focusTaskId) {
      appliedFocusRef.current = null;
      focusRefreshRef.current = null;
      return;
    }
    if (appliedFocusRef.current === focusTaskId) return;

    const focused = tasksState?.tasks.find((task) => task.id === focusTaskId);
    if (focused) {
      appliedFocusRef.current = focusTaskId;
      if (isActiveStatus(focused.status)) {
        setExplicitTaskId(focusTaskId);
        setTab("run");
      } else {
        setTab("history");
      }
      return;
    }

    // The task may not be in the last snapshot yet; refresh once per focus id.
    if (focusRefreshRef.current !== focusTaskId) {
      focusRefreshRef.current = focusTaskId;
      void refresh();
    }
  }, [focusTaskId, tasksState, refresh]);

  // Prefer a pending permission prompt, then the active task, then the first
  // queued task. Terminal tasks never leak into the run tab.
  const reviewTask = runTasks.find(
    (task) => task.status === "waiting_review" && task.review,
  );
  const selectedId =
    (explicitTaskId && runTasks.some((task) => task.id === explicitTaskId)
      ? explicitTaskId
      : null) ??
    reviewTask?.id ??
    (activeTaskId && runTasks.some((task) => task.id === activeTaskId)
      ? activeTaskId
      : null) ??
    runTasks[0]?.id ??
    null;
  const runTask = runTasks.find((task) => task.id === selectedId) ?? null;
  /** The PTY log file exists once the task is actually running. */
  const logReady =
    runTask !== null &&
    (runTask.status === "running" || runTask.status === "waiting_review");

  const counts = useMemo(() => {
    const queued =
      tasksState?.queuedCount ??
      tasks.filter((task) => task.status === "queued").length;
    const active =
      tasksState?.activeCount ??
      tasks.filter((task) => task.status === "preparing" || task.status === "running")
        .length;
    const waiting =
      tasksState?.waitingReviewCount ??
      tasks.filter((task) => task.status === "waiting_review").length;
    return { queued, active, waiting };
  }, [tasksState, tasks]);

  const queuedTasks = runTasks.filter((task) => task.status === "queued");

  const runAction = useCallback(
    async (key: string, action: () => Promise<unknown>) => {
      if (actionBusy) return;
      setActionBusy(key);
      try {
        await action();
        // The queue re-renders from the pushed `agent://state` snapshot, so a
        // success toast would only duplicate the visible status change.
        await refresh();
      } catch (error) {
        toast("error", String(error));
      } finally {
        setActionBusy(null);
      }
    },
    [actionBusy, refresh, toast],
  );

  const handlePermission = async (response: PermissionReply) => {
    if (!runTask?.review || permissionBusy) return;
    setPermissionBusy(response);
    try {
      await agentApi.permissionReply(runTask.id, response, response === "always");
      await refresh();
    } catch (error) {
      toast("error", String(error));
    } finally {
      setPermissionBusy(null);
    }
  };

  const openExportDir = (task: AgentTask) => {
    const dir = exportDirFor(task.mdPath);
    if (!dir) {
      toast("error", "该任务还没有导出目录");
      return;
    }
    void invoke("open_path", { path: dir }).catch((error) =>
      toast("error", String(error)),
    );
  };

  const resumeSession = async (task: AgentTask) => {
    if (!task.sessionId) {
      toast("error", "该任务还没有 opencode 会话 ID");
      return;
    }
    setResumeBusy(task.id);
    try {
      await agentApi.openSession(task.id);
    } catch (error) {
      toast("error", String(error));
    } finally {
      setResumeBusy(null);
    }
  };

  const canCancel = runTask !== null && ACTIVE_STATUSES.includes(runTask.status);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 pt-2.5">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            {
              value: "run",
              label: (
                <span className="inline-flex items-center gap-1.5">
                  运行
                  {counts.waiting > 0 ? (
                    <span className="inline-flex min-w-[2ch] justify-center rounded-full bg-rose-500 px-1.5 py-0.5 text-[9px] font-semibold leading-none tabular-nums text-white">
                      {counts.waiting}
                    </span>
                  ) : null}
                </span>
              ),
            },
            { value: "history", label: "历史" },
          ]}
        />

        <span className="text-[11px] text-slate-400">
          {counts.active} 运行 · {counts.queued} 排队 · {counts.waiting} 待审核
        </span>

        <button
          type="button"
          onClick={() => void refresh()}
          title="刷新任务状态"
          className="ml-auto grid h-7 w-7 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {tab === "history" ? (
        <AgentHistory
          tasks={historyTasks}
          focusTaskId={focusTaskId}
          onOpenBug={onOpenBug}
          onQueued={(taskId) => {
            setExplicitTaskId(taskId);
            setTab("run");
          }}
          toast={toast}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {!loaded ? (
            <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-slate-400">
              <Loader2 size={14} className="animate-spin" />
              正在读取 Agent 任务…
            </div>
          ) : !runTask ? (
            <div className="grid min-h-0 flex-1 place-items-center p-6 text-center">
              <div className="max-w-md">
                <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-400">
                  <Bot size={22} />
                </div>
                <h3 className="mt-3 text-sm font-semibold text-slate-800">
                  当前没有运行中的任务
                </h3>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  在缺陷详情点击「用 Agent 修复」后，任务会出现在这里；已结束的任务在「历史」中查看终端或恢复会话。
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="shrink-0 border-b border-slate-100 px-3.5 py-2.5">
                <div className="flex flex-wrap items-start gap-2.5">
                  <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-slate-900 text-sky-300">
                    <Terminal size={14} />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <h2
                        className="truncate text-[13px] font-semibold text-slate-900"
                        title={runTask.title}
                      >
                        {runTask.title || "（无标题）"}
                      </h2>
                      <Badge tone={AGENT_STATUS_TONES[runTask.status]}>
                        {AGENT_STATUS_LABELS[runTask.status]}
                      </Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] text-slate-400">
                      <span className="shrink-0">
                        {runTask.workspaceName || runTask.workspaceId} · #
                        {runTask.bugId.slice(-7)}
                      </span>
                      <span
                        className="min-w-0 max-w-full truncate font-mono"
                        title={runTask.repoPath}
                      >
                        {runTask.repoPath || "未配置仓库"}
                      </span>
                      <span className="shrink-0">
                        排队 {counts.queued} · 运行 {counts.active} · 待审核{" "}
                        {counts.waiting}
                      </span>
                      {logReady ? (
                        <span className="shrink-0">Option+拖动选中文本</span>
                      ) : null}
                      {runTask.exitCode !== undefined ? (
                        <span className="shrink-0">exit {runTask.exitCode}</span>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={
                        actionBusy === `cancel:${runTask.id}` ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Square size={11} />
                        )
                      }
                      disabled={!canCancel || actionBusy !== null}
                      onClick={() =>
                        void runAction(
                          `cancel:${runTask.id}`,
                          () => agentApi.cancel(runTask.id),
                        )
                      }
                    >
                      中断
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={
                        resumeBusy === runTask.id ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : (
                          <ExternalLink size={11} />
                        )
                      }
                      disabled={!runTask.sessionId || resumeBusy !== null}
                      onClick={() => void resumeSession(runTask)}
                    >
                      终端恢复
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<FolderOpen size={11} />}
                      disabled={!runTask.mdPath}
                      onClick={() => openExportDir(runTask)}
                    >
                      打开导出目录
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Bug size={11} />}
                      onClick={() => onOpenBug(runTask.workspaceId, runTask.bugId)}
                    >
                      打开缺陷
                    </Button>
                  </div>
                </div>
              </div>

              {runTask.review ? (
                <div className="shrink-0 border-b border-amber-200/70 bg-amber-50/70 px-3.5 py-2.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <ShieldAlert size={14} className="shrink-0 text-amber-600" />
                    <span className="shrink-0 text-xs font-semibold text-amber-900">
                      Agent 请求权限
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate text-[11px] text-amber-800"
                      title={runTask.review.title}
                    >
                      {runTask.review.title}
                    </span>
                  </div>
                  <div
                    className="mt-1 truncate font-mono text-[10px] text-amber-700/90"
                    title={`${runTask.review.action} · ${runTask.review.resource}`}
                  >
                    {runTask.review.action} · {runTask.review.resource}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="primary"
                      icon={
                        permissionBusy === "once" ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Check size={12} />
                        )
                      }
                      disabled={permissionBusy !== null}
                      onClick={() => void handlePermission("once")}
                    >
                      允许一次
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={
                        permissionBusy === "always" ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <CheckCheck size={12} />
                        )
                      }
                      disabled={permissionBusy !== null}
                      onClick={() => void handlePermission("always")}
                    >
                      总是允许
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      icon={
                        permissionBusy === "reject" ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Ban size={12} />
                        )
                      }
                      disabled={permissionBusy !== null}
                      onClick={() => void handlePermission("reject")}
                    >
                      拒绝
                    </Button>
                  </div>
                </div>
              ) : null}

              {queuedTasks.length > 0 ? (
                <div className="shrink-0 border-b border-slate-100 bg-slate-50/70 px-3.5 py-1.5">
                  <div className="flex items-center gap-1.5 overflow-x-auto">
                    <span className="shrink-0 text-[10px] font-medium text-slate-400">
                      排队 {queuedTasks.length}
                    </span>
                    {queuedTasks.map((task) => {
                      const key = `cancel:${task.id}`;
                      return (
                        <div
                          key={task.id}
                          className="flex shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] text-slate-600"
                        >
                          <span className="max-w-[170px] truncate" title={task.title}>
                            {task.title || "（无标题）"}
                          </span>
                          <span className="font-mono text-slate-400">
                            #{task.bugId.slice(-7)}
                          </span>
                          <button
                            type="button"
                            title="取消排队任务"
                            aria-label="取消排队任务"
                            disabled={actionBusy !== null}
                            onClick={() =>
                              void runAction(
                                key,
                                () => agentApi.cancel(task.id),
                              )
                            }
                            className="grid h-4 w-4 place-items-center rounded text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
                          >
                            {actionBusy === key ? (
                              <Loader2 size={10} className="animate-spin" />
                            ) : (
                              <X size={10} />
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {runTask.error ? (
                <div className="shrink-0 break-all border-b border-rose-100 bg-rose-50 px-3.5 py-1.5 text-[11px] leading-5 text-rose-700">
                  {runTask.error}
                </div>
              ) : null}

              {logReady ? (
                <div className="min-h-0 flex-1 bg-zinc-950 p-1.5">
                  <AgentTerminal
                    key={runTask.id}
                    taskId={runTask.id}
                    interactive
                    className="h-full w-full"
                  />
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-slate-50/70 p-6 text-center">
                  <div className="grid h-12 w-12 place-items-center rounded-2xl bg-slate-900 text-sky-300">
                    <Terminal size={22} />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-slate-700">任务尚未开始</p>
                    <p className="mt-1 max-w-md text-[11px] leading-5 text-slate-500">
                      任务开始后，opencode TUI 会直接显示在这里，可以像命令行一样操作。
                    </p>
                    <p className="mt-2 break-all font-mono text-[10px] text-slate-400">
                      {runTask.logPath}
                    </p>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
