import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import clsx from "clsx";
import {
  CheckCircle2,
  ClipboardList,
  Copy,
  Download,
  FileJson,
  FileText,
  Plug,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
} from "lucide-react";

import {
  api,
  type McpAuditEntry,
  type McpConfigInfo,
  type McpPolicy,
  type Workspace,
} from "../lib/api";
import { mcpApi, type McpImportResult } from "../lib/mcp";
import { Badge, Button, Spinner } from "./ui";

type Props = {
  workspaces: Workspace[];
  onCopy: (text: string) => void;
  toast: (kind: "ok" | "error", text: string) => void;
};

const COPY_BUTTON =
  "inline-flex shrink-0 items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-600 transition hover:border-slate-300";

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none transition placeholder:text-slate-300 focus:border-sky-300 focus:ring-2 focus:ring-sky-100";

/**
 * MCP tab: server status, policy/audit, one-click opencode import and
 * integration guides for other agents.
 */
export function McpPage({ workspaces, onCopy, toast }: Props) {
  const [mcp, setMcp] = useState<McpConfigInfo | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<McpImportResult | null>(null);
  const [policy, setPolicy] = useState<McpPolicy | null>(null);
  const [audit, setAudit] = useState<McpAuditEntry[]>([]);
  const [auditFilter, setAuditFilter] = useState<"all" | "denied" | "error">("all");
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [auditBusy, setAuditBusy] = useState(false);
  const [statusInput, setStatusInput] = useState("");

  const loadConfig = useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await api.mcpConfig();
      setMcp(next);
      setConfigError(null);
    } catch (error) {
      setConfigError(String(error));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const loadAudit = useCallback(async () => {
    try {
      setAudit(await api.mcpAuditList(120));
    } catch (error) {
      toast("error", String(error));
    }
  }, [toast]);

  const loadPolicy = useCallback(async () => {
    try {
      const next = await api.mcpPolicyGet();
      setPolicy(next);
      setStatusInput(next.allowedStatuses.join(", "));
    } catch (error) {
      toast("error", String(error));
    }
  }, [toast]);

  useEffect(() => {
    void loadPolicy();
    void loadAudit();
  }, [loadPolicy, loadAudit]);

  const savePolicy = async (patch: Partial<McpPolicy>) => {
    if (!policy) return;
    const next = { ...policy, ...patch };
    setPolicy(next);
    setSavingPolicy(true);
    try {
      const saved = await api.mcpPolicySet(next);
      setPolicy(saved);
      setStatusInput(saved.allowedStatuses.join(", "));
    } catch (error) {
      toast("error", String(error));
      await loadPolicy();
    } finally {
      setSavingPolicy(false);
    }
  };

  const commitStatuses = async () => {
    if (!policy) return;
    const raw = statusInput
      .split(/[,，\n]/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (raw.join("\u0000") === policy.allowedStatuses.join("\u0000")) return;
    await savePolicy({ allowedStatuses: raw });
  };

  const toggleWorkspace = (workspaceId: string) => {
    if (!policy) return;
    const allowed = new Set(policy.allowedWorkspaceIds);
    if (allowed.has(workspaceId)) allowed.delete(workspaceId);
    else allowed.add(workspaceId);
    void savePolicy({ allowedWorkspaceIds: [...allowed] });
  };

  const exportAudit = async () => {
    setAuditBusy(true);
    try {
      const path = await api.mcpAuditExport();
      toast("ok", `已导出审计日志：${path}`);
    } catch (error) {
      toast("error", String(error));
    } finally {
      setAuditBusy(false);
    }
  };

  const clearAudit = async () => {
    setAuditBusy(true);
    try {
      await api.mcpAuditClear();
      setAudit([]);
      toast("ok", "已清空 MCP 审计日志");
    } catch (error) {
      toast("error", String(error));
    } finally {
      setAuditBusy(false);
    }
  };

  const importOpencode = async () => {
    if (!mcp) return;
    if (mcp.imported) {
      toast("ok", "已导入，无需重复写入");
      return;
    }

    setImporting(true);
    try {
      const result = await mcpApi.importOpencode();
      setImportResult(result);
      toast("ok", result.changed ? "已写入 opencode 配置" : "已导入，无需重复写入");
      await loadConfig();
    } catch (error) {
      toast("error", String(error));
    } finally {
      setImporting(false);
    }
  };

  if (!mcp) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-xs text-slate-400">
          {configError ? (
            <>
              <Plug size={22} className="mx-auto mb-2 text-slate-300" />
              <p className="max-w-md break-all">读取 MCP 配置失败：{configError}</p>
              <Button
                size="sm"
                className="mt-3"
                onClick={() => void loadConfig()}
                loading={refreshing}
                icon={<RefreshCw size={13} />}
              >
                重试
              </Button>
            </>
          ) : (
            <>
              <Spinner className="mx-auto mb-2" />
              MCP 设置加载中…
            </>
          )}
        </div>
      </div>
    );
  }

  const commandPath = mcp.commandPath || "tapd-mcp";
  const port = mcp.port ? `127.0.0.1:${mcp.port}` : "—";
  const writable = policy ? policy.writesEnabled : !mcp.readOnly;
  const filteredAudit = audit.filter((entry) =>
    auditFilter === "all" ? true : entry.decision === auditFilter,
  );

  const guides = [
    {
      id: "claude",
      title: "Claude Code",
      hint: "命令行注册（stdio）",
      icon: <Terminal size={15} className="text-slate-400" />,
      code: `claude mcp add --transport stdio tapd -- ${commandPath}`,
    },
    {
      id: "cursor",
      title: "Cursor",
      hint: "~/.cursor/mcp.json",
      icon: <FileJson size={15} className="text-slate-400" />,
      code: JSON.stringify({ mcpServers: { tapd: { command: commandPath } } }, null, 2),
    },
    {
      id: "codex",
      title: "Codex",
      hint: "~/.codex/config.toml",
      icon: <FileText size={15} className="text-slate-400" />,
      code: `[mcp_servers.tapd]\ncommand = "${commandPath}"`,
    },
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Plug size={15} className="text-slate-400" />
              MCP 服务
            </h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              把 TAPD 缺陷接入 AI 客户端，支持查询、导出与修复后回写。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge tone="green" dot>
              已启用
            </Badge>
            <Badge tone={writable ? "blue" : "neutral"}>
              {writable ? "读写" : "只读"}
            </Badge>
            <Button
              size="sm"
              onClick={() => {
                void loadConfig();
                void loadPolicy();
                void loadAudit();
              }}
              loading={refreshing}
              icon={<RefreshCw size={13} />}
            >
              刷新
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-2 text-[11px] text-slate-500 sm:grid-cols-4">
          <StatusTile label="传输" value={mcp.transport} mono />
          <StatusTile label="本地端口" value={port} mono />
          <StatusTile label="工具" value={`${mcp.tools.length} 个`} />
          <StatusTile label="权限" value={writable ? "读写" : "只读"} />
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {mcp.tools.map((tool) => (
            <span
              key={tool}
              className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[10px] text-slate-600"
            >
              {tool}
            </span>
          ))}
        </div>

        <div className="mt-4 space-y-2">
          <PathRow label="MCP 程序路径" value={mcp.commandPath} onCopy={onCopy} />
          <PathRow
            label="opencode 配置"
            value={mcp.configPath ?? "未找到 opencode 配置目录"}
            copyable={Boolean(mcp.configPath)}
            onCopy={onCopy}
            badge={
              mcp.configPath ? (
                mcp.imported ? (
                  <Badge tone="green">已导入</Badge>
                ) : (
                  <Badge tone="amber">未导入</Badge>
                )
              ) : (
                <Badge tone="neutral">未找到</Badge>
              )
            }
          />
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <ShieldCheck size={15} className="text-slate-400" />
              MCP 策略
            </h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              策略只会在 TAPD 权限之上进一步收窄范围，不会扩大 AI 的访问能力。
            </p>
          </div>
          <span className="shrink-0 text-[10px] text-slate-400">
            {savingPolicy ? "保存中…" : "改动即保存"}
          </span>
        </div>

        {!policy ? (
          <div className="mt-4 flex items-center gap-2 text-xs text-slate-400">
            <Spinner />
            读取 MCP 策略…
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="space-y-3">
              <PolicyRow
                title="允许写操作"
                hint="评论与状态回写。关闭后仅保留查询、详情与导出工具。"
              >
                <Toggle
                  checked={policy.writesEnabled}
                  onChange={(value) => void savePolicy({ writesEnabled: value })}
                />
              </PolicyRow>
              <PolicyRow
                title="记录调用审计"
                hint="记录工具、客户端、决策、耗时与项目/缺陷；不保存评论正文和 Cookie。"
              >
                <Toggle
                  checked={policy.auditEnabled}
                  onChange={(value) => void savePolicy({ auditEnabled: value })}
                />
              </PolicyRow>
            </div>

            <div>
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] font-medium text-slate-600">
                  允许访问的项目
                </div>
                <div className="text-[10px] text-slate-400">
                  不选任何项目 = 全部项目
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => void savePolicy({ allowedWorkspaceIds: [] })}
                  className={chipClass(policy.allowedWorkspaceIds.length === 0)}
                >
                  全部项目
                </button>
                {workspaces.map((workspace) => {
                  const active = policy.allowedWorkspaceIds.includes(workspace.id);
                  return (
                    <button
                      key={workspace.id}
                      type="button"
                      onClick={() => toggleWorkspace(workspace.id)}
                      className={chipClass(active)}
                      title={workspace.prettyName || workspace.name}
                    >
                      {workspace.name}
                    </button>
                  );
                })}
                {workspaces.length === 0 ? (
                  <span className="text-[10px] text-slate-400">
                    项目列表尚未加载，稍后再试。
                  </span>
                ) : null}
              </div>
            </div>

            <div>
              <label className="text-[11px] font-medium text-slate-600">
                允许的目标状态
              </label>
              <input
                value={statusInput}
                onChange={(event) => setStatusInput(event.target.value)}
                onBlur={() => void commitStatuses()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                placeholder="例如 resolved, closed；留空 = 遵循 TAPD 工作流"
                className={`${INPUT_CLASS} mt-1.5 font-mono`}
              />
              <p className="mt-1 text-[10px] leading-5 text-slate-400">
                可填状态 key（resolved）或中文名（已解决），多个用逗号分隔。
              </p>
            </div>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <ClipboardList size={15} className="text-slate-400" />
              调用审计
            </h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              最近 {audit.length || 120} 次 MCP 调用；拒绝与失败也会记录。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              value={auditFilter}
              onChange={(event) =>
                setAuditFilter(event.target.value as "all" | "denied" | "error")
              }
              className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-slate-600 outline-none focus:border-sky-300"
            >
              <option value="all">全部</option>
              <option value="denied">被拒绝</option>
              <option value="error">失败</option>
            </select>
            <Button
              size="sm"
              onClick={() => void loadAudit()}
              icon={<RefreshCw size={12} />}
            >
              刷新
            </Button>
            <Button
              size="sm"
              onClick={() => void exportAudit()}
              loading={auditBusy}
              icon={<Download size={12} />}
            >
              导出
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => void clearAudit()}
              loading={auditBusy}
              icon={<Trash2 size={12} />}
            >
              清空
            </Button>
          </div>
        </div>

        <div className="mt-3 max-h-[360px] overflow-auto rounded-xl border border-slate-100">
          {filteredAudit.length === 0 ? (
            <div className="p-6 text-center text-[11px] text-slate-400">
              {audit.length ? "没有匹配的记录" : "暂无调用记录"}
            </div>
          ) : (
            <table className="w-full text-left text-[11px]">
              <thead className="sticky top-0 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-medium">时间</th>
                  <th className="px-2 py-2 font-medium">工具</th>
                  <th className="px-2 py-2 font-medium">客户端</th>
                  <th className="px-2 py-2 font-medium">结果</th>
                  <th className="px-2 py-2 font-medium">耗时</th>
                  <th className="px-2 py-2 font-medium">项目 / 缺陷</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredAudit.map((entry) => (
                  <tr
                    key={entry.id}
                    className="text-slate-600"
                    title={entry.error ?? undefined}
                  >
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-[10px] text-slate-400">
                      {formatAuditTime(entry.ts)}
                    </td>
                    <td className="px-2 py-2 font-mono text-[10px] text-slate-700">
                      {entry.tool}
                    </td>
                    <td className="px-2 py-2">{entry.client}</td>
                    <td className="px-2 py-2">
                      <Badge
                        tone={
                          entry.decision === "allowed"
                            ? "green"
                            : entry.decision === "denied"
                              ? "amber"
                              : "red"
                        }
                      >
                        {entry.decision === "allowed"
                          ? "允许"
                          : entry.decision === "denied"
                            ? "拒绝"
                            : "失败"}
                      </Badge>
                    </td>
                    <td className="px-2 py-2 tabular-nums text-slate-500">
                      {entry.durationMs}ms
                    </td>
                    <td className="max-w-[190px] truncate px-2 py-2 font-mono text-[10px] text-slate-400">
                      {entry.workspaceId ?? "—"}
                      {entry.bugId ? ` / ${entry.bugId}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Sparkles size={15} className="text-slate-400" />
              一键导入 opencode
            </h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              自动写入 opencode 全局配置；改动前备份，重复导入不会重复写入。
            </p>
          </div>
          <Badge tone={mcp.imported ? "green" : "amber"}>
            {mcp.imported ? "已导入" : "待导入"}
          </Badge>
        </div>

        <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50 p-3">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">目标配置</div>
          <div className="mt-1 break-all font-mono text-[11px] text-slate-600">
            {mcp.configPath ?? "未找到 opencode 配置目录"}
          </div>
          <p className="mt-2 text-[10px] leading-5 text-slate-400">
            无法安全解析配置时会保留原文件并提示。
          </p>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            onClick={() => void importOpencode()}
            loading={importing}
            icon={<Download size={13} />}
          >
            一键导入 opencode
          </Button>
          <Button size="sm" onClick={() => onCopy(mcp.snippet)} icon={<Copy size={13} />}>
            复制配置片段
          </Button>
          <span className="text-[10px] text-slate-400">
            重启 opencode 后运行 <span className="font-mono">opencode mcp list</span> 确认已连接。
          </span>
        </div>

        {importResult ? (
          <div className="mt-3 rounded-xl border border-emerald-100 bg-emerald-50/60 p-3 text-[11px] leading-5 text-emerald-800">
            <div className="flex items-center gap-1.5 font-medium">
              <CheckCircle2 size={12} />
              {importResult.changed ? "已写入 opencode 配置" : "已导入，无需重复写入"}
            </div>
            <div className="mt-1 break-all font-mono text-emerald-700">{importResult.path}</div>
            {importResult.backupPath ? (
              <div className="mt-1 break-all text-emerald-700">
                备份：<span className="font-mono">{importResult.backupPath}</span>
              </div>
            ) : null}
            {!importResult.imported ? (
              <div className="mt-1 text-emerald-700/80">
                配置中未检测到 tapd server，请检查写入结果。
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-between text-[11px] text-slate-500">
          <span>配置片段（可手动粘贴到 opencode.json / opencode.jsonc）</span>
          <button type="button" onClick={() => onCopy(mcp.snippet)} className={COPY_BUTTON}>
            <Copy size={10} />
            复制配置
          </button>
        </div>
        <pre className="mt-2 max-h-56 overflow-auto rounded-xl bg-slate-900 p-3 font-mono text-[10px] leading-5 text-slate-200">
          {mcp.snippet}
        </pre>
      </section>

      <section className="space-y-3">
        <div className="px-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Wrench size={15} className="text-slate-400" />
            接入其他 AI 客户端
          </h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            复制对应的命令或配置，替换为实际程序路径即可。
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          {guides.map((guide) => (
            <section
              key={guide.id}
              className="flex flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="flex items-center gap-2 text-xs font-semibold text-slate-900">
                    {guide.icon}
                    {guide.title}
                  </h3>
                  <p className="mt-1 break-all text-[10px] text-slate-400">{guide.hint}</p>
                </div>
                <button
                  type="button"
                  onClick={() => onCopy(guide.code)}
                  title="复制"
                  className={COPY_BUTTON}
                >
                  <Copy size={10} />
                  复制
                </button>
              </div>
              <pre className="mt-3 min-h-[96px] flex-1 overflow-auto rounded-xl bg-slate-900 p-3 font-mono text-[10px] leading-5 text-slate-200">
                {guide.code}
              </pre>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}

function chipClass(active: boolean): string {
  return clsx(
    "rounded-full border px-2.5 py-1 text-[10px] transition",
    active
      ? "border-sky-200 bg-sky-50 text-sky-700"
      : "border-slate-200 bg-white text-slate-500 hover:border-slate-300",
  );
}

function PolicyRow(props: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-slate-100 bg-slate-50/70 p-3">
      <div className="min-w-0">
        <div className="text-[11px] font-medium text-slate-700">{props.title}</div>
        <div className="mt-0.5 text-[10px] leading-5 text-slate-400">{props.hint}</div>
      </div>
      {props.children}
    </div>
  );
}

function Toggle(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      className={clsx(
        "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition",
        props.checked ? "bg-sky-500" : "bg-slate-200",
        props.disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span
        className={clsx(
          "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all",
          props.checked ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}

function formatAuditTime(raw: string): string {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function StatusTile({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div
        className={
          mono
            ? "mt-1 truncate font-mono text-slate-700"
            : "mt-1 truncate text-slate-700"
        }
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function PathRow(props: {
  label: string;
  value: string;
  onCopy: (text: string) => void;
  copyable?: boolean;
  badge?: ReactNode;
}) {
  const copyable = props.copyable ?? true;

  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50 p-2.5">
      <span className="w-24 shrink-0 text-[11px] text-slate-400">{props.label}</span>
      <span
        className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-600"
        title={props.value}
      >
        {props.value}
      </span>
      {props.badge}
      {copyable ? (
        <button
          type="button"
          onClick={() => props.onCopy(props.value)}
          className={COPY_BUTTON}
        >
          <Copy size={10} />
          复制
        </button>
      ) : null}
    </div>
  );
}
