import { useCallback, useEffect, useState } from "react";
import {
  Bug,
  ChevronLeft,
  ChevronRight,
  ListFilter,
  RefreshCw,
  Search,
  UserRound,
  Users,
} from "lucide-react";
import clsx from "clsx";

import { api, type BugListPage, type BugSummary, type Workspace } from "../lib/api";
import {
  Badge,
  Button,
  EmptyState,
  PRIORITY_TONES,
  SEVERITY_TONES,
  STATUS_TONES,
  Spinner,
} from "./ui";

const STATUS_ORDER = [
  "new",
  "in_progress",
  "resolved",
  "verified",
  "reopened",
  "rejected",
  "closed",
];

const PRIORITIES = [
  ["urgent", "紧急"],
  ["high", "高"],
  ["medium", "中"],
  ["low", "低"],
  ["insignificant", "无关紧要"],
];

const SEVERITIES = [
  ["fatal", "致命"],
  ["serious", "严重"],
  ["normal", "一般"],
  ["prompt", "提示"],
  ["advice", "建议"],
];

type Scope = "mine" | "all";

type Props = {
  workspace: Workspace | null;
  me: string | null;
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  onOpenBug: (bug: BugSummary) => void;
  refreshToken: number;
};

export function BugListView(props: Props) {
  const { workspace, me, scope, onScopeChange, onOpenBug, refreshToken } = props;

  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [priority, setPriority] = useState("");
  const [severity, setSeverity] = useState("");
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [pageNo, setPageNo] = useState(1);
  const [page, setPage] = useState<BugListPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedKeyword(keyword.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  useEffect(() => {
    setPageNo(1);
  }, [scope]);

  const load = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.bugList({
        workspaceId: workspace.id,
        owner: scope === "mine" ? me : null,
        statuses: statusFilter,
        priorities: priority ? [priority] : [],
        severities: severity ? [severity] : [],
        keyword: debouncedKeyword || null,
        modifiedAfter: null,
        createdAfter: null,
        sortName: "created",
        order: "desc",
        page: pageNo,
        perpage: 50,
        confId: null,
      });
      setPage(result);
    } catch (cause) {
      setError(String(cause));
      setPage(null);
    } finally {
      setLoading(false);
    }
  }, [workspace, scope, me, statusFilter, priority, severity, debouncedKeyword, pageNo]);

  useEffect(() => {
    void load();
  }, [load, reloadTick, refreshToken]);

  const statusEntries = getStatusEntries(page);
  const activeFilterCount =
    statusFilter.length + (priority ? 1 : 0) + (severity ? 1 : 0);
  const totalPages = page ? Math.max(1, Math.ceil(page.total / Math.max(1, page.perpage))) : 1;

  const toggleStatus = (key: string) => {
    setPageNo(1);
    setStatusFilter((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key],
    );
  };

  const clearFilters = () => {
    setPageNo(1);
    setStatusFilter([]);
    setPriority("");
    setSeverity("");
    setKeyword("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-5 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-900">缺陷</h2>
          {page ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
              {page.total}
            </span>
          ) : null}
        </div>

        <div className="flex items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5">
          <button
            type="button"
            onClick={() => onScopeChange("mine")}
            className={clsx(
              "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition",
              scope === "mine"
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-500 hover:text-slate-700",
            )}
          >
            <UserRound size={12} />
            我负责的
          </button>
          <button
            type="button"
            onClick={() => onScopeChange("all")}
            className={clsx(
              "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition",
              scope === "all"
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-500 hover:text-slate-700",
            )}
          >
            <Users size={12} />
            全部
          </button>
        </div>

        {scope === "mine" && !me ? (
          <span className="text-[11px] text-amber-600">未能识别当前用户，暂按全部查询</span>
        ) : null}

        <div className="relative ml-auto w-64">
          <Search size={14} className="absolute left-3 top-2.5 text-slate-400" />
          <input
            value={keyword}
            onChange={(event) => {
              setPageNo(1);
              setKeyword(event.target.value);
            }}
            placeholder="搜索标题"
            className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-xs text-slate-800 outline-none transition focus:border-sky-400 focus:bg-white focus:ring-2 focus:ring-sky-100"
          />
        </div>

        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setReloadTick((tick) => tick + 1);
            void load();
          }}
          loading={loading}
          icon={<RefreshCw size={13} />}
        >
          刷新
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-white px-5 py-2.5">
        <ListFilter size={13} className="text-slate-400" />
        <div className="flex flex-wrap items-center gap-1">
          {statusEntries.map(([key, label]) => {
            const active = statusFilter.includes(key);
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggleStatus(key)}
                className={clsx(
                  "rounded-full border px-2.5 py-1 text-[11px] transition",
                  active
                    ? "border-sky-300 bg-sky-50 text-sky-700"
                    : "border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-700",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>

        <select
          value={priority}
          onChange={(event) => {
            setPageNo(1);
            setPriority(event.target.value);
          }}
          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 outline-none"
        >
          <option value="">优先级</option>
          {PRIORITIES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>

        <select
          value={severity}
          onChange={(event) => {
            setPageNo(1);
            setSeverity(event.target.value);
          }}
          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 outline-none"
        >
          <option value="">严重程度</option>
          {SEVERITIES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>

        {activeFilterCount > 0 ? (
          <button
            type="button"
            onClick={clearFilters}
            className="ml-1 text-[11px] text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline"
          >
            清除筛选（{activeFilterCount}）
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="m-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs leading-6 text-rose-700">
            <div className="font-semibold">缺陷加载失败</div>
            <div className="mt-1 break-all">{error}</div>
            <div className="mt-3">
              <Button size="sm" onClick={() => setReloadTick((tick) => tick + 1)}>
                重试
              </Button>
            </div>
          </div>
        ) : null}

        {!error && !page && loading ? (
          <div className="flex h-64 items-center justify-center gap-2 text-xs text-slate-400">
            <Spinner />
            正在读取缺陷…
          </div>
        ) : null}

        {!error && page && page.bugs.length === 0 ? (
          <EmptyState
            icon={<Bug size={22} />}
            title={scope === "mine" ? "你名下没有符合条件的缺陷" : "没有符合条件的缺陷"}
            description={
              activeFilterCount > 0
                ? "试试清除部分筛选条件，或切换到「全部」。"
                : "当前项目的缺陷列表为空，或视图权限不足。"
            }
            action={
              activeFilterCount > 0 ? (
                <Button size="sm" onClick={clearFilters}>
                  清除筛选
                </Button>
              ) : null
            }
          />
        ) : null}

        {!error && page && page.bugs.length > 0 ? (
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-2.5 font-medium">标题</th>
                <th className="w-24 px-3 py-2.5 font-medium">状态</th>
                <th className="w-20 px-3 py-2.5 font-medium">优先级</th>
                <th className="w-20 px-3 py-2.5 font-medium">严重程度</th>
                <th className="w-24 px-3 py-2.5 font-medium">处理人</th>
                <th className="w-24 px-3 py-2.5 font-medium">创建人</th>
                <th className="w-32 px-5 py-2.5 font-medium">创建时间</th>
              </tr>
            </thead>
            <tbody className={clsx("divide-y divide-slate-100", loading && "opacity-60")}>
              {page.bugs.map((bug) => (
                <tr
                  key={bug.id}
                  onClick={() => onOpenBug(bug)}
                  className="cursor-pointer bg-white text-xs transition hover:bg-sky-50/60"
                >
                  <td className="max-w-0 px-5 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-600">
                        BUG
                      </span>
                      <span className="truncate font-medium text-slate-800" title={bug.title}>
                        {bug.title}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 pl-9 text-[10px] text-slate-400">
                      <span className="font-mono">#{bug.shortId || bug.id.slice(-7)}</span>
                      {bug.versionReport ? <span>发现版本 {bug.versionReport}</span> : null}
                      {bug.iterationName ? <span className="truncate">{bug.iterationName}</span> : null}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge tone={STATUS_TONES[bug.status] ?? "neutral"}>
                      {bug.statusLabel || bug.status}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge tone={PRIORITY_TONES[bug.priority] ?? "neutral"}>
                      {bug.priorityLabel || bug.priority || "—"}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge tone={SEVERITY_TONES[bug.severity] ?? "neutral"} dot>
                      {bug.severityLabel || bug.severity || "—"}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1.5 text-slate-600">
                      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-slate-100 text-[9px] font-medium text-slate-500">
                        {initials(bug.owner)}
                      </span>
                      <span className="truncate">{bug.owner || "—"}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-slate-500">
                    <span className="line-clamp-1">{bug.creator || "—"}</span>
                  </td>
                  <td className="px-5 py-2.5 font-mono text-[11px] text-slate-400">
                    {formatTs(bug.created)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      {page && page.total > 0 ? (
        <div className="flex shrink-0 items-center justify-between border-t border-slate-200 bg-white px-5 py-2.5 text-[11px] text-slate-500">
          <span>
            共 {page.total} 条 · 第 {pageNo} / {totalPages} 页
            {loading ? <span className="ml-2 text-sky-600">同步中…</span> : null}
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={pageNo <= 1 || loading}
              onClick={() => setPageNo((current) => Math.max(1, current - 1))}
              icon={<ChevronLeft size={13} />}
            >
              上一页
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={pageNo >= totalPages || loading}
              onClick={() => setPageNo((current) => Math.min(totalPages, current + 1))}
            >
              下一页
              <ChevronRight size={13} />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function getStatusEntries(page: BugListPage | null): Array<[string, string]> {
  const map = page?.statusMap;
  if (map && Object.keys(map).length > 0) {
    const known = STATUS_ORDER.filter((key) => map[key]).map(
      (key) => [key, map[key]] as [string, string],
    );
    if (known.length > 0) return known;
    return Object.entries(map).filter(
      ([key, label]) => !["start", "end"].includes(key) && typeof label === "string",
    );
  }

  return [
    ["new", "新"],
    ["in_progress", "接受/处理"],
    ["resolved", "已解决"],
    ["verified", "已验证"],
    ["reopened", "重新打开"],
  ];
}

function initials(name: string): string {
  if (!name) return "?";
  return name.length > 2 ? name.slice(-2) : name;
}

function formatTs(value: string): string {
  if (!value) return "—";
  return value.length >= 16 ? value.slice(0, 16) : value;
}
