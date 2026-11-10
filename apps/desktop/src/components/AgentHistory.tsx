import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import clsx from "clsx";
import {
  Bug,
  ExternalLink,
  FolderOpen,
  Loader2,
  RotateCcw,
  ScrollText,
  Search,
} from "lucide-react";

import {
  AGENT_STATUS_LABELS,
  AGENT_STATUS_TONES,
  agentApi,
  exportDirFor,
  type AgentTask,
  type AgentTaskStatus,
} from "../lib/agent";
import { relativeTime } from "../lib/api";
import { AgentLogViewer } from "./AgentLogViewer";
import { Badge, Button } from "./ui";

// History only contains terminal tasks; active ones live in the run tab.
const STATUS_OPTIONS: AgentTaskStatus[] = ["succeeded", "failed", "canceled"];

const SELECT_CLASS =
  "rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100";

type Props = {
  tasks: AgentTask[];
  /** History row selected by the island capsule / enqueue flow. */
  focusTaskId?: string | null;
  onOpenBug: (workspaceId: string, bugId: string) => void;
  /** Called after a retry so the parent can focus the task in the run tab. */
  onQueued?: (taskId: string) => void;
  toast: (kind: "ok" | "error", text: string) => void;
};

/** Execution records: filterable newest-first list plus a detail/log viewer. */
export function AgentHistory({ tasks, focusTaskId, onOpenBug, onQueued, toast }: Props) {
  const [workspaceFilter, setWorkspaceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | AgentTaskStatus>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [logTask, setLogTask] = useState<AgentTask | null>(null);
  const [resumeBusy, setResumeBusy] = useState<string | null>(null);
  const [retryBusy, setRetryBusy] = useState<string | null>(null);
  const appliedFocusRef = useRef<string | null>(null);

  const workspaces = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of tasks) {
      map.set(task.workspaceId, task.workspaceName || task.workspaceId);
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [tasks]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return tasks
      .filter((task) => workspaceFilter === "all" || task.workspaceId === workspaceFilter)
      .filter((task) => statusFilter === "all" || task.status === statusFilter)
      .filter(
        (task) =>
          !keyword ||
          task.title.toLowerCase().includes(keyword) ||
          task.bugId.toLowerCase().includes(keyword),
      )
      .slice()
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [tasks, workspaceFilter, statusFilter, query]);

  // Keep a sensible selection as tasks stream in or filters change.
  useEffect(() => {
    setSelectedId((current) => {
      if (current && filtered.some((task) => task.id === current)) return current;
      return filtered[0]?.id ?? null;
    });
  }, [filtered]);

  const selected = useMemo(
    () => filtered.find((task) => task.id === selectedId) ?? null,
    [filtered, selectedId],
  );

  // A focus request from the island/enqueue flow wins over active filters.
  useEffect(() => {
    if (!focusTaskId) return;
    if (appliedFocusRef.current === focusTaskId) return;
    if (!tasks.some((task) => task.id === focusTaskId)) return;
    appliedFocusRef.current = focusTaskId;
    setWorkspaceFilter("all");
    setStatusFilter("all");
    setQuery("");
    setSelectedId(focusTaskId);
  }, [focusTaskId, tasks]);

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

  const resume = async (task: AgentTask) => {
    if (!task.sessionId) {
      toast("error", "该任务没有可恢复的会话 ID");
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

  const retry = async (task: AgentTask) => {
    setRetryBusy(task.id);
    try {
      const { task: queued } = await agentApi.retry(task.id);
      // Jump to the run tab with the new task selected: that is the result,
      // and it is more useful than a toast saying where the task went.
      onQueued?.(queued.id);
    } catch (error) {
      toast("error", String(error));
    } finally {
      setRetryBusy(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <select
          value={workspaceFilter}
          onChange={(event) => setWorkspaceFilter(event.target.value)}
          className={SELECT_CLASS}
          aria-label="按工作区筛选"
        >
          <option value="all">全部工作区</option>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(event) =>
            setStatusFilter(event.target.value as "all" | AgentTaskStatus)
          }
          className={SELECT_CLASS}
          aria-label="按状态筛选"
        >
          <option value="all">全部状态</option>
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {AGENT_STATUS_LABELS[status]}
            </option>
          ))}
        </select>

        <label className="relative min-w-[180px] flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题或缺陷 ID"
            className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-2.5 text-xs text-slate-700 outline-none transition placeholder:text-slate-300 focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
          />
        </label>

        <span className="shrink-0 text-[11px] text-slate-400">
          {filtered.length} 条记录
        </span>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        <div className="w-[300px] shrink-0 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-sm">
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-slate-400">
              没有匹配的执行记录
            </div>
          ) : (
            <div className="space-y-1">
              {filtered.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => setSelectedId(task.id)}
                  className={clsx(
                    "w-full rounded-lg px-2.5 py-2 text-left transition",
                    task.id === selectedId
                      ? "bg-sky-50 ring-1 ring-sky-200"
                      : "hover:bg-slate-50",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <Badge tone={AGENT_STATUS_TONES[task.status]} dot>
                      {AGENT_STATUS_LABELS[task.status]}
                    </Badge>
                    <span className="ml-auto shrink-0 text-[10px] text-slate-400">
                      {relativeTime(task.createdAt)}
                    </span>
                  </div>
                  <div className="mt-1 line-clamp-2 text-[12px] font-medium leading-4 text-slate-700">
                    {task.title || "（无标题）"}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[10px] text-slate-400">
                    {task.workspaceName || task.workspaceId} · #{task.bugId.slice(-7)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          {!selected ? (
            <div className="grid h-full place-items-center px-6 py-10 text-center text-xs text-slate-400">
              选择左侧记录查看详情
            </div>
          ) : (
            <div className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
                  {selected.title || "（无标题）"}
                </h2>
                <Badge tone={AGENT_STATUS_TONES[selected.status]}>
                  {AGENT_STATUS_LABELS[selected.status]}
                </Badge>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Bug size={12} />}
                  onClick={() => onOpenBug(selected.workspaceId, selected.bugId)}
                >
                  打开缺陷
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<FolderOpen size={12} />}
                  disabled={!selected.mdPath}
                  onClick={() => openExportDir(selected)}
                >
                  打开导出目录
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<ScrollText size={12} />}
                  disabled={!selected.logPath}
                  onClick={() => setLogTask(selected)}
                >
                  查看终端
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={
                    retryBusy === selected.id ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <RotateCcw size={12} />
                    )
                  }
                  disabled={retryBusy !== null}
                  onClick={() => void retry(selected)}
                >
                  重试
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={
                    resumeBusy === selected.id ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <ExternalLink size={12} />
                    )
                  }
                  disabled={!selected.sessionId || resumeBusy !== null}
                  onClick={() => void resume(selected)}
                >
                  终端恢复
                </Button>
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] sm:grid-cols-3">
                <Meta label="工作区" value={selected.workspaceName || selected.workspaceId} />
                <Meta label="缺陷 ID" value={selected.bugId} mono />
                <Meta label="来源" value={selected.source || "—"} />
                <Meta label="会话" value={selected.sessionId || "—"} mono wide />
                <Meta label="创建时间" value={relativeTime(selected.createdAt)} title={selected.createdAt} />
                <Meta
                  label="开始时间"
                  value={selected.startedAt ? relativeTime(selected.startedAt) : "—"}
                  title={selected.startedAt}
                />
                <Meta
                  label="结束时间"
                  value={selected.finishedAt ? relativeTime(selected.finishedAt) : "—"}
                  title={selected.finishedAt}
                />
                <Meta
                  label="退出码"
                  value={selected.exitCode !== undefined ? String(selected.exitCode) : "—"}
                  mono
                />
                <Meta label="仓库" value={selected.repoPath || "未配置仓库"} mono wide />
              </dl>

              {selected.error ? (
                <div className="mt-3 break-all rounded-lg bg-rose-50 px-2.5 py-2 text-[11px] leading-5 text-rose-700 ring-1 ring-rose-100">
                  <div className="mb-0.5 font-semibold">错误</div>
                  {selected.error}
                </div>
              ) : null}

              <details className="mt-3 rounded-lg border border-slate-100 bg-slate-50/60">
                <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[11px] font-medium text-slate-600">
                  提示词
                </summary>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-2.5 pb-2.5 font-mono text-[11px] leading-5 text-slate-600">
                  {selected.prompt || "（空）"}
                </pre>
              </details>
            </div>
          )}
        </div>
      </div>

      <AgentLogViewer
        task={logTask}
        onClose={() => setLogTask(null)}
        toast={toast}
      />
    </div>
  );
}

function Meta(props: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
  title?: string;
}) {
  return (
    <div className={clsx("min-w-0", props.wide && "col-span-2 sm:col-span-3")}>
      <dt className="text-[10px] uppercase tracking-wide text-slate-400">
        {props.label}
      </dt>
      <dd
        title={props.title}
        className={clsx(
          "truncate text-slate-700",
          props.mono && "font-mono text-[10px]",
        )}
      >
        {props.value}
      </dd>
    </div>
  );
}
