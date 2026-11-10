import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  CheckCircle2,
  Copy,
  Download,
  FileJson,
  FileText,
  Plug,
  RefreshCw,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";

import { api, type McpConfigInfo } from "../lib/api";
import { mcpApi, type McpImportResult } from "../lib/mcp";
import { Badge, Button, Spinner } from "./ui";

type Props = {
  onCopy: (text: string) => void;
  toast: (kind: "ok" | "error", text: string) => void;
};

const COPY_BUTTON =
  "inline-flex shrink-0 items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-600 transition hover:border-slate-300";

/**
 * MCP tab: server status, one-click opencode import and integration guides for
 * other agents.
 */
export function McpPage({ onCopy, toast }: Props) {
  const [mcp, setMcp] = useState<McpConfigInfo | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<McpImportResult | null>(null);

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
              AI 客户端通过 stdio 启动随应用分发的 tapd-mcp，读取当前账号可见的缺陷；修复完成后可追加评论、更新状态。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge tone="green" dot>
              已启用
            </Badge>
            <Badge tone={mcp.readOnly ? "neutral" : "blue"}>
              {mcp.readOnly ? "只读" : "读写"}
            </Badge>
            <Button
              size="sm"
              onClick={() => void loadConfig()}
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
          <StatusTile label="权限" value={mcp.readOnly ? "只读" : "读写"} />
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
          <PathRow label="sidecar 路径" value={mcp.commandPath} onCopy={onCopy} />
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
              <Sparkles size={15} className="text-slate-400" />
              一键导入 opencode
            </h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              将 tapd 写入 opencode 全局配置的 mcp.servers，保留其他已有配置；改动前自动备份，重复导入不会重复写入。
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
            写入 <span className="font-mono text-slate-600">mcp.servers.tapd</span>，command
            指向 sidecar 路径。若配置文件含注释（JSONC）而无法安全解析，会直接报错并保持原文件不变。
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
            复制对应的命令或配置，填入实际的 sidecar 路径即可；所有客户端都通过 stdio 启动 tapd-mcp。
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
