import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Bug,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  ListFilter,
  RefreshCw,
  Search,
  Sparkles,
  UserRound,
  Users,
  WifiOff,
} from "lucide-react";
import clsx from "clsx";

import {
  api,
  type BugListPage,
  type BugQuery,
  type BugSummary,
  type Workspace,
} from "../lib/api";
import { cacheApi, type Cached } from "../lib/cache";
import { beginRefresh } from "../lib/refresh";
import { SkeletonRows } from "./Skeleton";
import {
  Badge,
  Button,
  EmptyState,
  PRIORITY_TONES,
  SEVERITY_TONES,
  STATUS_TONES,
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
  /** Row actions (action column). */
  onOpenWeb?: (url: string) => void;
  onCopyLink?: (url: string) => void;
  onAgentFix?: (bug: BugSummary) => void;
  refreshToken: number;
};

function BugListViewImpl(props: Props) {
  const {
    workspace,
    me,
    scope,
    onScopeChange,
    onOpenBug,
    onOpenWeb,
    onCopyLink,
    onAgentFix,
    refreshToken,
  } = props;

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
  /** Sync time (Unix seconds) of the cached snapshot currently on screen. */
  const [snapshotAt, setSnapshotAt] = useState<number | null>(null);
  /** Newest request wins; older responses (filters/page changed) are dropped. */
  const requestIdRef = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedKeyword(keyword.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  useEffect(() => {
    setPageNo(1);
  }, [scope]);

  const load = useCallback(async () => {
    if (!workspace) return;

    const query: BugQuery = {
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
    };

    const requestId = ++requestIdRef.current;

    // Cache-first: paint the last snapshot for exactly this query before the
    // network round-trip, so a slow/offline TAPD never shows an empty table.
    let cached: Cached<BugListPage> | null = null;
    try {
      cached = await cacheApi.bugList(query);
    } catch {
      // A cache read failure is not a page failure; the live request decides.
    }
    if (requestId !== requestIdRef.current) return;

    const snapshot = cached?.data ?? null;
    const snapshotFetchedAt = cached?.fetchedAt ?? null;
    if (snapshot) {
      setPage(snapshot);
      setSnapshotAt(snapshotFetchedAt);
    }

    setError(null);
    setLoading(true);
    const done = beginRefresh();
    try {
      const result = await api.bugList(query);
      if (requestId !== requestIdRef.current) return;
      setPage(result);
      setSnapshotAt(null);
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      if (snapshot) {
        // Offline: keep the cached table and let the inline notice explain it.
        setSnapshotAt(snapshotFetchedAt);
      } else {
        setError(String(cause));
        setPage(null);
        setSnapshotAt(null);
      }
    } finally {
      done();
      if (requestId === requestIdRef.current) setLoading(false);
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
          onClick={() => setReloadTick((tick) => tick + 1)}
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

      {page && snapshotAt !== null && !loading && !error ? (
        <div className="flex items-center gap-2 border-b border-amber-100 bg-amber-50/80 px-5 py-1.5 text-[11px] text-amber-700">
          <WifiOff size={12} className="shrink-0" />
          <span className="truncate">
            离线数据 · 上次同步 {formatSnapshotTime(snapshotAt)}
          </span>
          <button
            type="button"
            onClick={() => setReloadTick((tick) => tick + 1)}
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-amber-200 bg-white px-1.5 py-0.5 text-[10px] text-amber-700 transition hover:bg-amber-100"
          >
            <RefreshCw size={10} />
            重试
          </button>
        </div>
      ) : null}

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
          <SkeletonRows
            className="pt-1"
            rows={9}
            columns={["w-[36%]", "w-12", "w-9", "w-14", "w-16", "w-12", "w-24"]}
            label="正在读取缺陷列表"
          />
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
          <table className="w-full min-w-[1040px] border-collapse text-left">
            <thead className="sticky top-0 z-20 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="min-w-[320px] px-4 py-2.5 font-medium">标题</th>
                <th className="w-[92px] px-3 py-2.5 font-medium">状态</th>
                <th className="w-[76px] px-3 py-2.5 font-medium">优先级</th>
                <th className="w-[100px] px-3 py-2.5 font-medium">严重程度</th>
                <th className="w-[104px] px-3 py-2.5 font-medium">处理人</th>
                <th className="w-[88px] px-3 py-2.5 font-medium">创建人</th>
                <th className="w-[136px] px-4 py-2.5 font-medium">创建时间</th>
                <th className="sticky right-0 z-30 w-[124px] border-l border-slate-200/70 bg-slate-50 px-3 py-2.5 text-right font-medium">
                  操作
                </th>
              </tr>
            </thead>
            <tbody className={clsx("divide-y divide-slate-100", loading && "opacity-60")}>
              {page.bugs.map((bug) => (
                <tr
                  key={bug.id}
                  onClick={() => onOpenBug(bug)}
                  className="group cursor-pointer bg-white text-xs transition hover:bg-sky-50"
                >
                  <td className="min-w-[320px] max-w-0 px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-600">
                        BUG
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate font-medium text-slate-800"
                        title={bug.title}
                      >
                        {bug.title}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 overflow-hidden pl-9 text-[10px] text-slate-400">
                      <span className="shrink-0 font-mono">#{bug.shortId || bug.id.slice(-7)}</span>
                      {bug.versionReport ? (
                        <span className="shrink-0">发现版本 {bug.versionReport}</span>
                      ) : null}
                      {bug.iterationName ? <span className="truncate">{bug.iterationName}</span> : null}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <Badge tone={STATUS_TONES[bug.status] ?? "neutral"}>
                      {bug.statusLabel || bug.status}
                    </Badge>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <Badge tone={PRIORITY_TONES[bug.priority] ?? "neutral"}>
                      {bug.priorityLabel || bug.priority || "—"}
                    </Badge>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <Badge tone={SEVERITY_TONES[bug.severity] ?? "neutral"} dot>
                      {bug.severityLabel || bug.severity || "—"}
                    </Badge>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <div className="flex items-center gap-1.5 text-slate-600">
                      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-slate-100 text-[9px] font-medium text-slate-500">
                        {initials(bug.owner)}
                      </span>
                      <span className="truncate">{bug.owner || "—"}</span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-slate-500">
                    <span className="line-clamp-1">{bug.creator || "—"}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[11px] text-slate-400">
                    {formatTs(bug.created)}
                  </td>
                  <td
                    className="sticky right-0 z-10 border-l border-slate-100 bg-white px-2 py-2.5 group-hover:bg-sky-50"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="flex items-center justify-end gap-0.5">
                      <RowAction
                        label="查看详情"
                        onClick={() => onOpenBug(bug)}
                        icon={<Eye size={13} />}
                      />
                      {onOpenWeb ? (
                        <RowAction
                          label="在 TAPD 中打开"
                          onClick={() => onOpenWeb(bug.bugUrl)}
                          icon={<ExternalLink size={13} />}
                        />
                      ) : null}
                      {onCopyLink ? (
                        <RowAction
                          label="复制链接"
                          onClick={() => onCopyLink(bug.bugUrl)}
                          icon={<Copy size={13} />}
                        />
                      ) : null}
                      {onAgentFix ? (
                        <RowAction
                          label="用 Agent 修复"
                          onClick={() => onAgentFix(bug)}
                          icon={<Sparkles size={13} />}
                        />
                      ) : null}
                    </div>
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

/**
 * Memoized so detail-pane state changes (open/loading/detail) do not reconcile
 * the whole bug table. Props must stay referentially stable: App passes
 * `useCallback` handlers and the workspace object from the loaded context.
 */
export const BugListView = memo(BugListViewImpl);

function RowAction(props: { label: string; icon: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
      className="grid h-6 w-6 place-items-center rounded-md text-slate-400 transition hover:bg-white hover:text-slate-700 hover:shadow-sm"
    >
      {props.icon}
    </button>
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

/** "上次同步" label: time only for today, date + time for older snapshots. */
function formatSnapshotTime(fetchedAt: number): string {
  const date = new Date(fetchedAt * 1000);
  if (Number.isNaN(date.getTime())) return "未知";

  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const options: Intl.DateTimeFormatOptions = {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    ...(sameDay ? {} : { month: "2-digit", day: "2-digit" }),
  };
  return date.toLocaleString("zh-CN", options);
}
