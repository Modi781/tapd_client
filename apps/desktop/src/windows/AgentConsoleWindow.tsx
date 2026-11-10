import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { FolderOpen, RotateCcw, Square, Terminal as TerminalIcon } from "lucide-react";
import clsx from "clsx";

import "@xterm/xterm/css/xterm.css";

import {
  AGENT_STATUS_LABELS,
  agentApi,
  exportDirFor,
  type AgentOutputPayload,
  type AgentTask,
  type AgentTasksState,
  type AgentTaskStatus,
} from "../lib/agent";

const STATUS_STYLES: Record<AgentTaskStatus, string> = {
  queued: "bg-slate-700 text-slate-200",
  preparing: "bg-sky-500/15 text-sky-300",
  running: "bg-amber-500/15 text-amber-300",
  succeeded: "bg-emerald-500/15 text-emerald-300",
  failed: "bg-rose-500/15 text-rose-300",
  canceled: "bg-slate-700 text-slate-400",
};

export function AgentConsoleWindow() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const currentTaskIdRef = useRef<string | null>(null);

  const [tasksState, setTasksState] = useState<AgentTasksState | null>(null);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const currentTask =
    tasksState?.tasks.find((task) => task.id === currentTaskId) ?? null;

  const syncSize = useCallback(() => {
    const term = terminalRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
    } catch {
      /* the container can be zero-sized while the window is hidden */
    }
    const taskId = currentTaskIdRef.current;
    if (taskId) {
      void agentApi.resize(taskId, term.cols, term.rows).catch(() => {});
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      scrollback: 10_000,
      theme: {
        background: "#09090b",
        foreground: "#e4e4e7",
        cursor: "#38bdf8",
        selectionBackground: "#334155",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    terminalRef.current = term;
    fitRef.current = fit;

    const inputDisposable = term.onData((data) => {
      const taskId = currentTaskIdRef.current;
      if (!taskId) return;
      void agentApi.input(taskId, data).catch(() => {
        /* typing before the PTY exists is harmless */
      });
    });

    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const applyState = (next: AgentTasksState) => {
      if (disposed) return;
      setTasksState(next);
      const nextId = next.activeTaskId;
      if (nextId && nextId !== currentTaskIdRef.current) {
        currentTaskIdRef.current = nextId;
        setCurrentTaskId(nextId);
        term.reset();
        void agentApi
          .taskLog(nextId)
          .then(({ data }) => {
            if (!disposed && currentTaskIdRef.current === nextId && data) {
              term.write(data);
            }
          })
          .catch(() => {
            /* a missing log just means there is nothing to replay */
          });
        window.requestAnimationFrame(syncSize);
      } else if (!nextId && currentTaskIdRef.current) {
        currentTaskIdRef.current = null;
        setCurrentTaskId(null);
        term.reset();
      }
    };

    void agentApi
      .tasksList()
      .then(applyState)
      .catch((reason) => setError(String(reason)));

    void listen<AgentOutputPayload>("agent://output", (event) => {
      const { taskId, data } = event.payload;
      if (!data || taskId !== currentTaskIdRef.current) return;
      term.write(data);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });

    void listen<AgentTasksState>("agent://state", (event) => {
      applyState(event.payload);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });

    const onResize = () => syncSize();
    window.addEventListener("resize", onResize);
    const observer = new ResizeObserver(() => syncSize());
    observer.observe(container);

    window.requestAnimationFrame(() => {
      syncSize();
      term.focus();
    });

    // Focus this window when it opens (created by the Rust side).
    void agentApi.openConsole().catch(() => {});

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
      window.removeEventListener("resize", onResize);
      observer.disconnect();
      inputDisposable.dispose();
      term.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [syncSize]);

  const refresh = useCallback(async () => {
    try {
      const next = await agentApi.tasksList();
      setTasksState(next);
      const nextId = next.activeTaskId;
      if (nextId && nextId !== currentTaskIdRef.current) {
        currentTaskIdRef.current = nextId;
        setCurrentTaskId(nextId);
        const term = terminalRef.current;
        if (term) {
          term.reset();
          void agentApi
            .taskLog(nextId)
            .then(({ data }) => {
              if (currentTaskIdRef.current === nextId && data) term.write(data);
            })
            .catch(() => {});
        }
        window.requestAnimationFrame(syncSize);
      }
    } catch (reason) {
      setError(String(reason));
    }
  }, [syncSize]);

  const handleCancel = async (task: AgentTask) => {
    setBusy(true);
    try {
      await agentApi.cancel(task.id);
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleRetry = async (task: AgentTask) => {
    setBusy(true);
    try {
      await agentApi.retry(task.id);
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleOpenExportDir = (task: AgentTask) => {
    const dir = exportDirFor(task.mdPath);
    if (!dir) {
      setError("该任务还没有导出目录");
      return;
    }
    void invoke("open_path", { path: dir }).catch((reason) =>
      setError(String(reason)),
    );
  };

  const canCancel =
    currentTask !== null &&
    (currentTask.status === "queued" ||
      currentTask.status === "preparing" ||
      currentTask.status === "running");
  const canRetry =
    currentTask !== null &&
    (currentTask.status === "failed" ||
      currentTask.status === "canceled" ||
      currentTask.status === "succeeded");

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-200">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/10 bg-zinc-900/80 px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-sky-500/15 text-sky-300">
            <TerminalIcon size={15} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-semibold text-zinc-100">
                {currentTask?.title ?? "Agent 控制台"}
              </h1>
              {currentTask ? (
                <span
                  className={clsx(
                    "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                    STATUS_STYLES[currentTask.status],
                  )}
                >
                  {AGENT_STATUS_LABELS[currentTask.status]}
                </span>
              ) : null}
              {currentTask ? (
                <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-400">
                  {currentTask.workspaceName || currentTask.workspaceId} · #
                  {currentTask.bugId.slice(-7)}
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[10px] text-zinc-500">
              <span className="truncate font-mono" title={currentTask?.repoPath}>
                {currentTask?.repoPath || "未配置仓库"}
              </span>
              {tasksState ? (
                <span className="shrink-0">队列 {tasksState.queueLength}</span>
              ) : null}
              {currentTask?.exitCode !== undefined ? (
                <span className="shrink-0">exit {currentTask.exitCode}</span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <ConsoleButton
            onClick={() => currentTask && void handleCancel(currentTask)}
            disabled={!canCancel || busy}
            icon={<Square size={11} />}
          >
            中断
          </ConsoleButton>
          <ConsoleButton
            onClick={() => currentTask && void handleRetry(currentTask)}
            disabled={!canRetry || busy}
            icon={<RotateCcw size={11} />}
          >
            重试
          </ConsoleButton>
          <ConsoleButton
            onClick={() => currentTask && handleOpenExportDir(currentTask)}
            disabled={!currentTask?.mdPath}
            icon={<FolderOpen size={11} />}
          >
            打开导出目录
          </ConsoleButton>
        </div>
      </header>

      {error || currentTask?.error ? (
        <div className="flex items-start gap-2 border-b border-rose-500/20 bg-rose-500/10 px-4 py-2 text-[11px] leading-5 text-rose-200">
          <span className="min-w-0 flex-1 break-all">
            {error ?? currentTask?.error}
          </span>
          {error ? (
            <button
              type="button"
              onClick={() => setError(null)}
              className="shrink-0 text-rose-300/70 transition hover:text-rose-200"
            >
              关闭
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          className="h-full w-full px-2 py-1"
          onMouseDown={() => terminalRef.current?.focus()}
        />
        {!currentTask ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="text-center text-xs leading-6 text-zinc-500">
              <TerminalIcon size={22} className="mx-auto mb-2 text-zinc-600" />
              暂无 Agent 任务
              <div className="text-[11px] text-zinc-600">
                在缺陷详情点击「用 Agent 修复」，任务会自动开始。
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ConsoleButton(props: {
  onClick: () => void;
  disabled?: boolean;
  icon: ReactNode;
  children: ReactNode;
}) {
  const { onClick, disabled = false, icon, children } = props;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-zinc-300 transition hover:border-white/20 hover:bg-white/10 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {icon}
      {children}
    </button>
  );
}
