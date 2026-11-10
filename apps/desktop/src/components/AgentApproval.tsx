import { useState } from "react";
import { Archive, Bug, Check, Eye, FolderOpen, Loader2, ShieldAlert } from "lucide-react";

import { agentApi, type AgentTask } from "../lib/agent";
import { Badge, Button } from "./ui";

type Props = {
  tasks: AgentTask[];
  busy: string | null;
  queuePaused: boolean;
  onApprove: (task: AgentTask) => void;
  onStop: (task: AgentTask) => void;
  onResumeQueue: () => void;
  onOpenBug: (workspaceId: string, bugId: string) => void;
  onOpenExportDir: (task: AgentTask) => void;
};

/**
 * 待审核：Agent 判断改动复杂时暂停在这里，工作区保留未提交的 diff。
 * 通过后任务重新入队并收到「审核已通过」的提交提示词；停止会储藏改动并暂停队列。
 */
export function AgentApproval(props: Props) {
  const { tasks, busy, queuePaused } = props;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pr-0.5">
      {tasks.length > 0 && !queuePaused ? (
        <div className="flex shrink-0 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
          <ShieldAlert size={14} className="shrink-0 text-amber-500" />
          有待审核任务，队列已暂停；通过或停止后才会继续下一个任务。未决定前关闭客户端不会丢改动。
        </div>
      ) : null}
      {queuePaused ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[11px] text-amber-800">
          <ShieldAlert size={14} className="shrink-0 text-amber-600" />
          <span className="min-w-0 flex-1">
            队列已暂停：审核任务不会自动继续。处理完后可手动恢复。
          </span>
          <Button
            size="sm"
            variant="secondary"
            loading={busy === "queue:resume"}
            disabled={busy !== null && busy !== "queue:resume"}
            onClick={props.onResumeQueue}
          >
            继续队列
          </Button>
        </div>
      ) : null}

      {tasks.length === 0 ? (
        <div className="grid min-h-0 flex-1 place-items-center rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <div className="max-w-md">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-amber-50 text-amber-500">
              <ShieldAlert size={22} />
            </div>
            <h3 className="mt-3 text-sm font-semibold text-slate-800">没有待审核的改动</h3>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              复杂改动会在这里暂停。通过后重新入队提交；停止会把本次涉及的文件储藏到 git stash 并暂停队列，代码不会丢。
            </p>
          </div>
        </div>
      ) : (
        tasks.map((task) => (
          <ReviewCard key={task.id} task={task} {...props} />
        ))
      )}
    </div>
  );
}

function ReviewCard({
  task,
  busy,
  onApprove,
  onStop,
  onOpenBug,
  onOpenExportDir,
}: Props & { task: AgentTask }) {
  const approval = task.approval;
  const approveBusy = busy === `approve:${task.id}`;
  const stopBusy = busy === `stop:${task.id}`;
  const files = approval?.files ?? [];
  const [diff, setDiff] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffBusy, setDiffBusy] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const toggleDiff = async () => {
    if (diffOpen) {
      setDiffOpen(false);
      return;
    }
    setDiffOpen(true);
    if (diff !== null || diffBusy) return;
    setDiffBusy(true);
    setDiffError(null);
    try {
      const result = await agentApi.reviewDiff(task.id);
      setDiff(result.diff);
    } catch (error) {
      setDiffError(String(error));
    } finally {
      setDiffBusy(false);
    }
  };

  return (
    <article className="shrink-0 rounded-xl border border-amber-200/80 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start gap-2">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-amber-50 text-amber-600">
          <ShieldAlert size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3
              className="min-w-0 truncate text-[13px] font-semibold text-slate-900"
              title={task.title}
            >
              {task.title || "（无标题）"}
            </h3>
            <Badge tone="amber">待审核</Badge>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] text-slate-400">
            <span className="shrink-0">
              {task.workspaceName || task.workspaceId} · #{task.bugId.slice(-7)}
            </span>
            <span
              className="min-w-0 max-w-full truncate font-mono"
              title={task.repoPath}
            >
              {task.repoPath || "未配置仓库"}
            </span>
            {approval?.requestedAt ? (
              <span className="shrink-0">{formatReviewTime(approval.requestedAt)}</span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            icon={<Eye size={11} />}
            disabled={busy !== null}
            onClick={() => void toggleDiff()}
          >
            {diffOpen ? "收起改动" : "查看改动"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Bug size={11} />}
            disabled={busy !== null}
            onClick={() => onOpenBug(task.workspaceId, task.bugId)}
          >
            打开缺陷
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<FolderOpen size={11} />}
            disabled={busy !== null || !task.mdPath}
            onClick={() => onOpenExportDir(task)}
          >
            导出目录
          </Button>
        </div>
      </div>

      <div className="mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 px-3 py-2.5 text-xs leading-5 text-slate-600">
        {approval?.summary || "Agent 已暂停，等待确认后提交。"}
      </div>

      {files.length > 0 ? (
        <div className="mt-2">
          <div className="text-[10px] font-medium text-slate-400">
            涉及文件 {files.length} 个
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {files.slice(0, 12).map((file) => (
              <span
                key={file}
                title={file}
                className="max-w-[260px] truncate rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600"
              >
                {file}
              </span>
            ))}
            {files.length > 12 ? (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                +{files.length - 12}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {approval?.risk ? (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50/70 px-2.5 py-1.5 text-[11px] leading-5 text-amber-800">
          风险：{approval.risk}
        </div>
      ) : null}

      {diffOpen ? (
        <div className="mt-2 rounded-lg bg-zinc-950 p-2.5">
          <div className="mb-1.5 flex items-center gap-2 text-[10px] text-zinc-400">
            <span className="font-mono">git diff HEAD</span>
            <span className="ml-auto">只包含已跟踪文件；未跟踪文件见上方列表</span>
          </div>
          {diffBusy ? (
            <div className="flex items-center gap-1.5 py-3 text-[11px] text-zinc-400">
              <Loader2 size={12} className="animate-spin" />
              正在读取差异…
            </div>
          ) : diffError ? (
            <div className="break-all py-2 text-[11px] text-rose-300">{diffError}</div>
          ) : (
            <pre className="max-h-72 overflow-auto whitespace-pre font-mono text-[10px] leading-4 text-zinc-200">
              {diff ?? ""}
            </pre>
          )}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
        <p className="min-w-[200px] flex-1 text-[10px] leading-4 text-slate-400">
          通过会重新入队，Agent 只做核对、提交与 TAPD 回写；停止会把本次涉及的文件储藏到 git stash 并暂停队列。
        </p>
        <Button
          size="sm"
          variant="primary"
          loading={approveBusy}
          disabled={busy !== null && !approveBusy}
          icon={<Check size={12} />}
          onClick={() => onApprove(task)}
        >
          通过并提交
        </Button>
        <Button
          size="sm"
          variant="danger"
          loading={stopBusy}
          disabled={busy !== null && !stopBusy}
          icon={<Archive size={12} />}
          onClick={() => onStop(task)}
        >
          停止并储藏
        </Button>
      </div>
    </article>
  );
}

function formatReviewTime(raw: string): string {
  const timestamp = Date.parse(raw);
  if (Number.isNaN(timestamp)) return raw;
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
