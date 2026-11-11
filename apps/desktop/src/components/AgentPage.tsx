import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import clsx from "clsx";
import {
  Ban,
  Bot,
  Bug,
  Check,
  CheckCheck,
  Copy,
  ExternalLink,
  FolderOpen,
  Hourglass,
  ListOrdered,
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
  type AgentRuntimeDescriptor,
  type AgentTask,
  type AgentTaskStatus,
  type AgentTasksState,
  type PermissionReply,
} from "../lib/agent";
import { relativeTime } from "../lib/api";
import { bugTitle } from "../lib/bug";
import { AgentApproval } from "./AgentApproval";
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
const isApprovalStatus = (status: AgentTaskStatus) => status === "awaiting_approval";

type Props = {
  /** Task selected by the island capsule (`agent://focus`). */
  focusTaskId: string | null;
  /** Incremented by the title-bar review badge to open the 待审核 tab. */
  focusReviewToken?: number;
  /** Jump to the bug a task belongs to (selects workspace + opens drawer). */
  onOpenBug: (workspaceId: string, bugId: string) => void;
  toast: (kind: "ok" | "error", text: string) => void;
};

type Tab = "run" | "approval" | "history";

/**
 * Agent workspace: "运行" (live queue: running task with PTY on the right,
 * queued tasks below), "待审核" (complex changes waiting for a commit decision)
 * and "历史" (terminal execution records, logs and bug links).
 */
export function AgentPage({
  focusTaskId,
  focusReviewToken = 0,
  onOpenBug,
  toast,
}: Props) {
  const [tasksState, setTasksState] = useState<AgentTasksState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>("run");
  // Task explicitly selected by `agent://focus` or a click in the run queue;
  // cleared when the active task changes so the terminal follows the worker.
  const [explicitTaskId, setExplicitTaskId] = useState<string | null>(null);
  const [permissionBusy, setPermissionBusy] = useState<PermissionReply | null>(null);
  const [permissionOptionBusy, setPermissionOptionBusy] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [resumeBusy, setResumeBusy] = useState<string | null>(null);
  /** Current runtime descriptor; decides whether external decisions are allowed. */
  const [runtime, setRuntime] = useState<AgentRuntimeDescriptor | null>(null);
  const [terminalFocus, setTerminalFocus] = useState(0);
  /** Set when the runtime rejects a desktop decision; UI falls back to review. */
  const [replyFallback, setReplyFallback] = useState<string | null>(null);

  const appliedFocusRef = useRef<string | null>(null);
  const focusRefreshRef = useRef<string | null>(null);

  const tasks = tasksState?.tasks ?? [];
  const activeTaskId = tasksState?.activeTaskId ?? null;
  const runTasks = tasks.filter((task) => isActiveStatus(task.status));
  const approvalTasks = tasks.filter((task) => isApprovalStatus(task.status));

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

  // Runtime capability declaration. If the desktop cannot deliver a decision
  // (or the runtime rejects it), the UI must point at the terminal instead of
  // offering buttons that would silently fail.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([agentApi.configGet(), agentApi.runtimes()])
      .then(([configResult, runtimeResult]) => {
        if (cancelled) return;
        const current = runtimeResult.runtimes.find(
          (item) => item.id === configResult.config.runtimeId,
        );
        setRuntime(current ?? runtimeResult.runtimes[0] ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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
      if (isApprovalStatus(focused.status)) {
        setTab("approval");
      } else if (isActiveStatus(focused.status)) {
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
      return;
    }

    // Terminal tasks are not in the live snapshot; the history tab fetches
    // them by id.
    appliedFocusRef.current = focusTaskId;
    setTab("history");
  }, [focusTaskId, tasksState, refresh]);

  // The title-bar review badge opens the approval queue directly.
  useEffect(() => {
    if (focusReviewToken > 0) setTab("approval");
  }, [focusReviewToken]);

  // The queue is strictly FIFO: active work first, then the insertion order in
  // which the Rust worker will pick the rest.
  const activeRunTasks = runTasks.filter((task) => task.status !== "queued");
  const queuedTasks = runTasks.filter((task) => task.status === "queued");
  const queuePosition = (task: AgentTask): number | null => {
    const index = queuedTasks.findIndex((item) => item.id === task.id);
    return index >= 0 ? index + 1 : null;
  };

  // Prefer the selected task, then a pending permission prompt, then the active
  // task, then the next queued one. Terminal tasks never leak into the run tab.
  const reviewTask = runTasks.find(
    (task) => task.status === "waiting_review" && task.review,
  );
  const fallbackId =
    reviewTask?.id ??
    (activeTaskId && runTasks.some((task) => task.id === activeTaskId)
      ? activeTaskId
      : null) ??
    runTasks[0]?.id ??
    null;
  const selectedId =
    (explicitTaskId && runTasks.some((task) => task.id === explicitTaskId)
      ? explicitTaskId
      : null) ?? fallbackId;
  const selectedTask = runTasks.find((task) => task.id === selectedId) ?? null;
  const selectedQueuePosition = selectedTask ? queuePosition(selectedTask) : null;
  /** The PTY log file exists once the task is actually running. */
  const logReady =
    selectedTask !== null &&
    (selectedTask.status === "running" || selectedTask.status === "waiting_review");

  // A new permission prompt (or a different task) deserves a fresh attempt.
  useEffect(() => {
    setReplyFallback(null);
  }, [selectedTask?.id, selectedTask?.review?.id]);

  const counts = useMemo(() => {
    const queued =
      tasksState?.queuedCount ??
      tasks.filter((task) => task.status === "queued").length;
    const active = tasks.filter(
      (task) => task.status === "preparing" || task.status === "running",
    ).length;
    const waiting =
      tasksState?.waitingReviewCount ??
      tasks.filter((task) => task.status === "waiting_review").length;
    const awaiting =
      tasksState?.awaitingApprovalCount ??
      tasks.filter((task) => task.status === "awaiting_approval").length;
    return {
      queued,
      active,
      waiting,
      awaiting,
      paused: Boolean(tasksState?.queuePaused),
    };
  }, [tasksState, tasks]);

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
    if (!selectedTask?.review || permissionBusy) return;
    setPermissionBusy(response);
    setReplyFallback(null);
    try {
      await agentApi.permissionReply(selectedTask.id, response, response === "always");
      await refresh();
    } catch (error) {
      // The runtime did not accept the desktop decision. Never retry blindly:
      // keep the review visible and point the user at the terminal.
      setReplyFallback(String(error));
      toast("error", String(error));
    } finally {
      setPermissionBusy(null);
    }
  };

  const handlePermissionOption = async (optionId: string) => {
    if (!selectedTask?.review || permissionOptionBusy) return;
    setPermissionOptionBusy(optionId);
    setReplyFallback(null);
    try {
      await agentApi.permissionOption(selectedTask.id, optionId);
      await refresh();
    } catch (error) {
      setReplyFallback(String(error));
      toast("error", String(error));
    } finally {
      setPermissionOptionBusy(null);
    }
  };

  const handleApprove = async (task: AgentTask) => {
    if (actionBusy) return;
    setActionBusy(`approve:${task.id}`);
    try {
      await agentApi.approveReview(task.id);
      // The approved task re-enters the queue; show it running again.
      setExplicitTaskId(task.id);
      setTab("run");
      await refresh();
    } catch (error) {
      toast("error", String(error));
    } finally {
      setActionBusy(null);
    }
  };

  const handleStopReview = async (task: AgentTask) => {
    if (actionBusy) return;
    setActionBusy(`stop:${task.id}`);
    try {
      const { task: stopped } = await agentApi.stopReview(task.id);
      // The stash ref is only visible in history otherwise; keep it in reach.
      toast("ok", stopped.error ?? "已停止并储藏改动");
      await refresh();
    } catch (error) {
      toast("error", String(error));
    } finally {
      setActionBusy(null);
    }
  };

  const handleResumeQueue = () =>
    runAction("queue:resume", () => agentApi.resumeQueue());

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

  const canCancel = selectedTask !== null && ACTIVE_STATUSES.includes(selectedTask.status);
  /** Capability says the desktop may not answer this runtime's prompts. */
  const runtimeBlocksDecision =
    runtime !== null && !runtime.capabilities.externalDecision;
  const decisionFallbackText = `${runtime?.name ?? "当前运行时"} 不接受桌面回执，该确认请直接在任务中处理。`;
  /** Only the PTY transport accepts keystrokes; ACP/process are read-only. */
  const interactive =
    selectedTask !== null && (selectedTask.transport ?? "pty") === "pty";
  const reviewOptions = selectedTask?.review?.options ?? [];

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
                    <span className="inline-flex min-w-[2ch] justify-center rounded-full bg-rose-500 px-1.5 py-0.5 text-ui-2xs font-normal leading-none tabular-nums text-white">
                      {counts.waiting}
                    </span>
                  ) : null}
                </span>
              ),
            },
            {
              value: "approval",
              label: (
                <span className="inline-flex items-center gap-1.5">
                  待审核
                  {counts.awaiting > 0 ? (
                    <span className="inline-flex min-w-[2ch] justify-center rounded-full bg-amber-500 px-1.5 py-0.5 text-ui-2xs font-normal leading-none tabular-nums text-white">
                      {counts.awaiting}
                    </span>
                  ) : null}
                </span>
              ),
            },
            { value: "history", label: "历史" },
          ]}
        />

        <span className="text-ui-sm text-slate-400">
          {counts.active} 运行 · {counts.queued} 排队 · {counts.waiting} 权限 ·{" "}
          {counts.awaiting} 待审核
          {counts.paused ? " · 队列已暂停" : ""}
        </span>

        {counts.paused ? (
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto"
            loading={actionBusy === "queue:resume"}
            disabled={actionBusy !== null && actionBusy !== "queue:resume"}
            onClick={handleResumeQueue}
          >
            继续队列
          </Button>
        ) : null}

        <button
          type="button"
          onClick={() => void refresh()}
          title="刷新任务状态"
          className={clsx(
            "grid h-7 w-7 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700",
            !counts.paused && "ml-auto",
          )}
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {tab === "history" ? (
        <AgentHistory
          revision={`${counts.active}:${counts.queued}:${counts.waiting}:${counts.awaiting}`}
          focusTaskId={focusTaskId}
          onOpenBug={onOpenBug}
          onQueued={(taskId) => {
            setExplicitTaskId(taskId);
            setTab("run");
          }}
          toast={toast}
        />
      ) : tab === "approval" ? (
        <AgentApproval
          tasks={approvalTasks}
          busy={actionBusy}
          queuePaused={counts.paused}
          onApprove={handleApprove}
          onStop={handleStopReview}
          onResumeQueue={handleResumeQueue}
          onOpenBug={onOpenBug}
          onOpenExportDir={openExportDir}
        />
      ) : (
        <div className="flex min-h-0 flex-1 gap-3">
          {/* Left: live execution queue, FIFO. */}
          <aside className="flex w-[300px] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-surface ">
            <div className="flex shrink-0 items-center gap-1.5 border-b border-slate-100 px-3 py-2">
              <ListOrdered size={13} className="text-slate-400" />
              <span className="text-ui-sm text-slate-500">执行队列</span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {!loaded ? (
                <div className="flex items-center justify-center gap-2 py-10 text-ui-caption text-slate-400">
                  <Loader2 size={14} className="animate-spin" />
                  正在读取…
                </div>
              ) : runTasks.length === 0 ? (
                <div
                  className="flex h-full items-center justify-center px-3 text-center text-ui-caption text-slate-400"
                  title="在缺陷详情点击「用 Agent 修复」后会排在这里"
                >
                  队列为空
                </div>
              ) : (
                <div className="space-y-1">
                  {activeRunTasks.length > 0 ? (
                    <QueueGroup label="正在运行" />
                  ) : null}
                  {activeRunTasks.map((task) => (
                    <RunQueueRow
                      key={task.id}
                      task={task}
                      selected={task.id === selectedId}
                      onSelect={() => setExplicitTaskId(task.id)}
                    />
                  ))}

                  {queuedTasks.length > 0 ? (
                    <QueueGroup label={`排队中 ${queuedTasks.length}`} />
                  ) : null}
                  {queuedTasks.map((task) => (
                    <RunQueueRow
                      key={task.id}
                      task={task}
                      position={queuePosition(task)}
                      selected={task.id === selectedId}
                      onSelect={() => setExplicitTaskId(task.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          </aside>

          {/* Right: PTY terminal for the running task, queue card otherwise. */}
          <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface ">
            {!selectedTask ? (
              <div className="grid min-h-0 flex-1 place-items-center p-6 text-center">
                <div className="max-w-md">
                  <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-400">
                    <Bot size={22} />
                  </div>
                  <h3
                    className="mt-3 text-ui-base text-slate-800"
                    title="在缺陷详情点击「用 Agent 修复」后，任务会出现在这里；已结束的任务在「历史」中查看终端或恢复会话。"
                  >
                    当前没有运行中的任务
                  </h3>
                  {counts.awaiting > 0 ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mt-3"
                      onClick={() => setTab("approval")}
                    >
                      有 {counts.awaiting} 个改动待审核
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : selectedTask.status === "queued" ? (
              <QueuedTaskDetail
                task={selectedTask}
                position={selectedQueuePosition ?? 1}
                queuePaused={counts.paused}
                busy={actionBusy}
                onCancel={() =>
                  void runAction(`cancel:${selectedTask.id}`, () =>
                    agentApi.cancel(selectedTask.id),
                  )
                }
                onOpenBug={() => onOpenBug(selectedTask.workspaceId, selectedTask.bugId)}
              />
            ) : (
              <>
                <div className="shrink-0 border-b border-slate-100 px-3.5 py-2.5">
                  <div className="flex flex-wrap items-start gap-2.5">
                    <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center theme-static-dark rounded-lg bg-slate-900 text-sky-300">
                      <Terminal size={14} />
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <h2
                          className="truncate text-ui-base font-normal text-slate-900"
                          title={bugTitle(selectedTask.title)}
                        >
                          {bugTitle(selectedTask.title) || "（无标题）"}
                        </h2>
                        <Badge tone={AGENT_STATUS_TONES[selectedTask.status]}>
                          {AGENT_STATUS_LABELS[selectedTask.status]}
                        </Badge>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-ui-xs text-slate-400">
                        <span className="shrink-0">
                          {selectedTask.workspaceName || selectedTask.workspaceId} · #
                          {selectedTask.bugId.slice(-7)}
                        </span>
                        <span
                          className="min-w-0 max-w-full truncate font-mono"
                          title={selectedTask.repoPath}
                        >
                          {selectedTask.repoPath || "未配置仓库"}
                        </span>
                        {selectedTask.startedAt ? (
                          <span className="shrink-0">
                            开始于 {relativeTime(selectedTask.startedAt)}
                          </span>
                        ) : null}
                        {logReady ? (
                          <span className="shrink-0">Option+拖动选中文本</span>
                        ) : null}
                        {selectedTask.exitCode !== undefined ? (
                          <span className="shrink-0">exit {selectedTask.exitCode}</span>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={
                          actionBusy === `cancel:${selectedTask.id}` ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Square size={11} />
                          )
                        }
                        disabled={!canCancel || actionBusy !== null}
                        onClick={() =>
                          void runAction(
                            `cancel:${selectedTask.id}`,
                            () => agentApi.cancel(selectedTask.id),
                          )
                        }
                      >
                        中断
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={
                          resumeBusy === selectedTask.id ? (
                            <Loader2 size={11} className="animate-spin" />
                          ) : (
                            <ExternalLink size={11} />
                          )
                        }
                        disabled={!selectedTask.sessionId || resumeBusy !== null}
                        onClick={() => void resumeSession(selectedTask)}
                      >
                        终端恢复
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<FolderOpen size={11} />}
                        disabled={!selectedTask.mdPath}
                        onClick={() => openExportDir(selectedTask)}
                      >
                        打开导出目录
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<Bug size={11} />}
                        onClick={() =>
                          onOpenBug(selectedTask.workspaceId, selectedTask.bugId)
                        }
                      >
                        打开缺陷
                      </Button>
                    </div>
                  </div>
                </div>

                {selectedTask.review ? (
                  <div className="shrink-0 border-b border-amber-200/70 bg-amber-50/70 px-3.5 py-2.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <ShieldAlert size={14} className="shrink-0 text-amber-600" />
                      <span className="shrink-0 text-ui-caption font-normal text-amber-900">
                        Agent 请求权限
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate text-ui-sm text-amber-800"
                        title={selectedTask.review.title}
                      >
                        {selectedTask.review.title}
                      </span>
                    </div>
                    <div
                      className="mt-1 truncate font-mono text-ui-xs text-amber-700/90"
                      title={`${selectedTask.review.action} · ${selectedTask.review.resource}`}
                    >
                      {selectedTask.review.action} · {selectedTask.review.resource}
                    </div>
                    {replyFallback ? (
                      <div
                        className="mb-2 rounded-lg border border-rose-200 bg-surface/70 px-2.5 py-1.5 text-ui-sm leading-4 text-rose-700"
                        title={replyFallback}
                      >
                        运行时没有接受这次回执，请重试或选择其他选项。
                      </div>
                    ) : null}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {runtimeBlocksDecision ? (
                        <>
                          <span className="min-w-0 flex-1 text-ui-sm leading-4 text-amber-900">
                            {decisionFallbackText}
                          </span>
                          {interactive ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              icon={<Terminal size={12} />}
                              onClick={() =>
                                setTerminalFocus((value) => value + 1)
                              }
                            >
                              去终端处理
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="secondary"
                              icon={<Copy size={12} />}
                              disabled={!selectedTask.sessionId}
                              onClick={() => {
                                if (selectedTask.sessionId) {
                                  void navigator.clipboard.writeText(
                                    selectedTask.sessionId,
                                  );
                                }
                              }}
                            >
                              复制会话 ID
                            </Button>
                          )}
                        </>
                      ) : reviewOptions.length > 0 ? (
                        <>
                          {reviewOptions.map((option) => {
                            const rejecting = option.kind.startsWith("reject");
                            const always = option.kind === "allow_always";
                            const busy = permissionOptionBusy === option.optionId;
                            return (
                              <Button
                                key={option.optionId}
                                size="sm"
                                variant={
                                  rejecting
                                    ? "danger"
                                    : always
                                      ? "secondary"
                                      : "primary"
                                }
                                icon={
                                  busy ? (
                                    <Loader2 size={12} className="animate-spin" />
                                  ) : rejecting ? (
                                    <Ban size={12} />
                                  ) : always ? (
                                    <CheckCheck size={12} />
                                  ) : (
                                    <Check size={12} />
                                  )
                                }
                                disabled={
                                  permissionOptionBusy !== null ||
                                  permissionBusy !== null
                                }
                                onClick={() =>
                                  void handlePermissionOption(option.optionId)
                                }
                              >
                                {option.name}
                              </Button>
                            );
                          })}
                        </>
                      ) : (
                        <>
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
                        </>
                      )}
                    </div>
                  </div>
                ) : null}

                {selectedTask.error ? (
                  <div className="shrink-0 break-all border-b border-rose-100 bg-rose-50 px-3.5 py-1.5 text-ui-sm leading-5 text-rose-700">
                    {selectedTask.error}
                  </div>
                ) : null}

                {logReady ? (
                  <div className="min-h-0 flex-1 bg-zinc-950 p-1.5">
                    <AgentTerminal
                      key={selectedTask.id}
                      taskId={selectedTask.id}
                      interactive={interactive}
                      convertEol={!interactive}
                      focusToken={terminalFocus}
                      className="h-full w-full"
                    />
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-slate-50/70 p-6 text-center">
                    <div className="grid h-12 w-12 place-items-center theme-static-dark rounded-2xl bg-slate-900 text-sky-300">
                      <Terminal size={22} />
                    </div>
                    <div>
                      <p
                        className="text-ui-base text-slate-700"
                        title="任务开始后，opencode TUI 会直接显示在这里，可以像命令行一样操作。"
                      >
                        任务尚未开始
                      </p>
                      <p className="mt-2 break-all font-mono text-ui-xs text-slate-400">
                        {selectedTask.logPath}
                      </p>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function QueueGroup({ label }: { label: string }) {
  return (
    <div className="px-1.5 pb-1 pt-2 text-ui-xs font-normal text-slate-400 first:pt-0.5">
      {label}
    </div>
  );
}

function RunQueueRow(props: {
  task: AgentTask;
  position?: number | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const { task, position } = props;
  const spinning = task.status === "preparing" || task.status === "running";
  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={clsx(
        "w-full rounded-lg px-2.5 py-2 text-left transition",
        props.selected ? "bg-sky-50 border border-sky-200" : "hover:bg-slate-50",
      )}
    >
      <div className="flex items-center gap-1.5">
        {position ? (
          <span
            className="grid h-4 min-w-4 place-items-center rounded bg-slate-100 px-1 font-mono text-ui-2xs text-slate-500"
            title={`排队第 ${position} 位`}
          >
            {position}
          </span>
        ) : spinning ? (
          <Loader2 size={11} className="shrink-0 animate-spin text-sky-500" />
        ) : (
          <ShieldAlert size={11} className="shrink-0 text-rose-500" />
        )}
        <Badge tone={AGENT_STATUS_TONES[task.status]} dot={task.status === "queued"}>
          {AGENT_STATUS_LABELS[task.status]}
        </Badge>
        <span className="ml-auto shrink-0 text-ui-xs text-slate-400">
          {task.status === "queued"
            ? relativeTime(task.createdAt)
            : task.startedAt
              ? relativeTime(task.startedAt)
              : ""}
        </span>
      </div>
      <div
        className="mt-1 line-clamp-2 text-ui-caption font-normal leading-4 text-slate-700"
        title={bugTitle(task.title)}
      >
        {bugTitle(task.title) || "（无标题）"}
      </div>
      <div className="mt-0.5 truncate font-mono text-ui-xs text-slate-400">
        {task.workspaceName || task.workspaceId} · #{task.bugId.slice(-7)}
      </div>
    </button>
  );
}

function QueuedTaskDetail(props: {
  task: AgentTask;
  position: number;
  queuePaused: boolean;
  busy: string | null;
  onCancel: () => void;
  onOpenBug: () => void;
}) {
  const { task, position } = props;
  const cancelKey = `cancel:${task.id}`;
  return (
    <>
      <div className="shrink-0 border-b border-slate-100 px-4 py-3">
        <div className="flex flex-wrap items-start gap-2.5">
          <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500">
            <Hourglass size={14} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h2
                className="truncate text-ui-base font-normal text-slate-900"
                title={bugTitle(task.title)}
              >
                {bugTitle(task.title) || "（无标题）"}
              </h2>
              <Badge tone="neutral">排队中</Badge>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-ui-xs text-slate-400">
              <span className="shrink-0">
                {task.workspaceName || task.workspaceId} · #{task.bugId.slice(-7)}
              </span>
              <span
                className="min-w-0 max-w-full truncate font-mono"
                title={task.repoPath}
              >
                {task.repoPath || "未配置仓库"}
              </span>
              <span className="shrink-0">入队 {relativeTime(task.createdAt)}</span>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              icon={
                props.busy === cancelKey ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <X size={11} />
                )
              }
              disabled={props.busy !== null}
              onClick={props.onCancel}
            >
              取消排队
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<Bug size={11} />}
              onClick={props.onOpenBug}
            >
              打开缺陷
            </Button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-slate-50/70 p-6 text-center">
        <div className="grid h-12 w-12 place-items-center theme-static-dark rounded-2xl bg-slate-900 text-sky-300">
          <Hourglass size={22} />
        </div>
        <div>
          <p
            className="text-ui-base text-slate-700"
            title={
              position > 1
                ? `前面还有 ${position - 1} 个任务；开始后 opencode 终端会显示在这里。`
                : "下一个就轮到它；开始后 opencode 终端会显示在这里。"
            }
          >
            排队第 {position} 位
          </p>
          {props.queuePaused ? (
            <p className="mt-2 text-ui-sm text-amber-600">
              队列已暂停，点击右上角「继续队列」恢复执行。
            </p>
          ) : null}
          <p className="mt-2 break-all font-mono text-ui-xs text-slate-400">
            {task.logPath}
          </p>
        </div>
      </div>
    </>
  );
}
