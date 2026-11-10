import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Copy,
  ExternalLink,
  FolderOpen,
  Loader2,
  ScrollText,
  X,
} from "lucide-react";

import { agentApi, type AgentTask } from "../lib/agent";
import { stripAnsi } from "../lib/ansi";

type Props = {
  task: AgentTask | null;
  onClose: () => void;
  toast: (kind: "ok" | "error", text: string) => void;
};

/**
 * Read the IO log recorded for a task. Newlines are preserved (`pre` +
 * `whitespace-pre-wrap`), ANSI sequences are stripped for readability.
 */
export function AgentLogViewer({ task, onClose, toast }: Props) {
  const [log, setLog] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!task) return;
    let cancelled = false;
    setLog("");
    setError(null);
    setCopied(false);
    setLoading(true);
    void agentApi
      .taskLog(task.id)
      .then(({ data }) => {
        if (!cancelled) setLog(stripAnsi(data));
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [task]);

  useEffect(() => {
    if (!task) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [task, onClose]);

  const lineCount = useMemo(() => (log ? log.split("\n").length : 0), [log]);

  if (!task) return null;

  const copyLog = async () => {
    try {
      await navigator.clipboard.writeText(log);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (reason) {
      toast("error", `复制失败：${String(reason)}`);
    }
  };

  const openFile = () => {
    void invoke("open_path", { path: task.logPath }).catch((reason) =>
      toast("error", String(reason)),
    );
  };

  const resume = async () => {
    try {
      await agentApi.openSession(task.id);
      toast("ok", "已在 Terminal 中恢复该会话");
    } catch (reason) {
      toast("error", String(reason));
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/30 p-6 backdrop-blur-[1px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-[min(82vh,760px)] w-[min(960px,92vw)] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/10">
        <header className="flex shrink-0 items-start gap-3 border-b border-slate-100 px-4 py-3">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-zinc-900 text-sky-300">
            <ScrollText size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[13px] font-semibold text-slate-900">
              {task.title || "Agent 日志"}
            </h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-slate-400">
              <span>
                {task.workspaceName || task.workspaceId} · #{task.bugId.slice(-7)}
              </span>
              {task.sessionId ? (
                <span className="truncate font-mono">{task.sessionId}</span>
              ) : null}
              <span className="truncate font-mono" title={task.logPath}>
                {task.logPath}
              </span>
              {lineCount > 0 ? <span>{lineCount} 行</span> : null}
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭日志"
            onClick={onClose}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto bg-zinc-950">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-zinc-400">
              <Loader2 size={14} className="animate-spin" />
              正在读取日志…
            </div>
          ) : error ? (
            <div className="p-4 text-xs leading-5 text-rose-300">{error}</div>
          ) : log ? (
            <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[11px] leading-5 text-zinc-200">
              {log}
            </pre>
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-zinc-500">
              日志为空
            </div>
          )}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-slate-100 bg-white px-4 py-2.5">
          <button
            type="button"
            onClick={() => void copyLog()}
            disabled={!log}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-600 transition hover:border-slate-300 disabled:opacity-40"
          >
            <Copy size={11} />
            {copied ? "已复制" : "复制日志"}
          </button>
          <button
            type="button"
            onClick={openFile}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-600 transition hover:border-slate-300"
          >
            <FolderOpen size={11} />
            打开日志文件
          </button>
          <span className="ml-auto text-[10px] text-slate-400">
            读取日志末尾约 400 KB；原始 IO 日志保存在本地，换行保持原样
          </span>
          {task.sessionId ? (
            <button
              type="button"
              onClick={() => void resume()}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-600 transition hover:border-slate-300"
            >
              <ExternalLink size={11} />
              终端恢复
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
