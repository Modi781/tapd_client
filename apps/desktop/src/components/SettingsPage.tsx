import { useEffect, useState } from "react";
import {
  Copy,
  FolderOpen,
  KeyRound,
  LogIn,
  LogOut,
  RefreshCw,
  Server,
  ShieldCheck,
} from "lucide-react";

import {
  api,
  type AppInfo,
  type McpConfigInfo,
  type SessionStatus,
  type Workspace,
  type WorkspaceContext,
} from "../lib/api";
import { Badge, Button } from "./ui";

type Props = {
  info: AppInfo | null;
  status: SessionStatus | null;
  context: WorkspaceContext | null;
  onShowLogin: () => void;
  onLogout: () => void;
  onRefresh: () => void;
  onOpenPath: (path: string) => void;
  onCopy: (text: string) => void;
};

export function SettingsPage(props: Props) {
  const { info, status, context, onShowLogin, onLogout, onRefresh, onOpenPath, onCopy } = props;
  const [mcp, setMcp] = useState<McpConfigInfo | null>(null);

  useEffect(() => {
    void api
      .mcpConfig()
      .then(setMcp)
      .catch(() => setMcp(null));
  }, []);

  const paths: Array<[string, string]> = info
    ? [
        ["数据目录", info.paths.dataDir],
        ["日志目录", info.paths.logsDir],
        ["抓包目录", info.paths.capturesDir],
        ["导出目录", info.paths.exportsDir],
        ["配置文件", info.paths.configFile],
        ["runtime.json", info.paths.runtimeFile],
      ]
    : [];

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <KeyRound size={15} className="text-slate-400" />
              账户与会话
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              登录态保存在隐藏 WebView 的 Cookie 中，不写入配置文件。
            </p>
          </div>
          <Button size="sm" onClick={onRefresh} icon={<RefreshCw size={13} />}>
            刷新状态
          </Button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <InfoTile label="登录状态" value={info?.loggedIn ? "已登录" : "未登录"} />
          <InfoTile label="当前用户" value={context?.user.nick || info?.me || "—"} />
          <InfoTile label="公司" value={context?.user.company || "—"} />
        </div>

        <div className="mt-3 break-all rounded-xl border border-slate-100 bg-slate-50 p-3 font-mono text-[11px] text-slate-500">
          {status?.url || info?.sessionUrl || "会话窗口尚未创建"}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" onClick={onShowLogin} icon={<LogIn size={13} />}>
            打开 TAPD 窗口
          </Button>
          <Button size="sm" variant="danger" onClick={onLogout} icon={<LogOut size={13} />}>
            退出登录并清除数据
          </Button>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Server size={15} className="text-slate-400" />
          项目
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          项目列表来自 TAPD「我的项目」。点击左侧项目切换；默认进入上次选择的项目。
        </p>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {(context?.workspaces ?? []).map((workspace) => (
            <WorkspaceRow key={workspace.id} workspace={workspace} />
          ))}
          {!context ? (
            <div className="rounded-xl border border-dashed border-slate-200 p-3 text-xs text-slate-400">
              登录后加载项目
            </div>
          ) : null}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Server size={15} className="text-slate-400" />
              MCP 服务
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              AI 客户端通过 stdio 连接本应用，读取当前登录账号可见的缺陷。v1 为只读。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone="green">已启用</Badge>
            <Badge tone="neutral">只读</Badge>
          </div>
        </div>

        <div className="mt-4 grid gap-2 text-[11px] text-slate-500 sm:grid-cols-3">
          <div className="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">传输</div>
            <div className="mt-1 font-mono text-slate-700">{mcp?.transport ?? "stdio"}</div>
          </div>
          <div className="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">本地端口</div>
            <div className="mt-1 font-mono text-slate-700">
              {mcp?.port ? `127.0.0.1:${mcp.port}` : info?.runtimePort ? `127.0.0.1:${info.runtimePort}` : "—"}
            </div>
          </div>
          <div className="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">工具</div>
            <div className="mt-1 text-slate-700">{mcp?.tools.length ?? 6} 个</div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {(mcp?.tools ?? []).map((tool) => (
            <span
              key={tool}
              className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[10px] text-slate-600"
            >
              {tool}
            </span>
          ))}
        </div>

        <div className="mt-4">
          <div className="flex items-center justify-between text-[11px] text-slate-500">
            <span>opencode 配置（写入项目的 opencode.json）</span>
            <button
              type="button"
              onClick={() => onCopy(mcp?.snippet ?? "")}
              className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[10px] text-slate-600 transition hover:border-slate-300"
            >
              <Copy size={10} />
              复制配置
            </button>
          </div>
          <pre className="mt-2 max-h-56 overflow-auto rounded-xl bg-slate-900 p-3 font-mono text-[10px] leading-5 text-slate-200">
            {mcp?.snippet ?? "正在读取 MCP 配置…"}
          </pre>
          <p className="mt-2 text-[10px] leading-5 text-slate-400">
            也可以用命令行注册：
            <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-600">
              opencode mcp add tapd -- {mcp?.commandPath ?? "tapd-mcp"}
            </span>
            。重启 opencode 后运行 <span className="font-mono">opencode mcp list</span> 确认已连接。
          </p>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <ShieldCheck size={15} className="text-slate-400" />
          运行信息
        </h2>

        <dl className="mt-3 space-y-1 text-xs">
          <PlainRow label="版本" value={info?.version ?? "—"} onCopy={onCopy} />
          <PlainRow
            label="MCP 本地端口"
            value={info?.runtimePort ? `127.0.0.1:${info.runtimePort}` : "未启动"}
            onCopy={onCopy}
          />
          <PlainRow label="轮询间隔" value={`${info?.pollIntervalSecs ?? 60}s`} onCopy={onCopy} />
        </dl>

        <div className="mt-4 divide-y divide-slate-100">
          {paths.map(([label, value]) => (
            <div key={label} className="flex items-center gap-3 py-2 text-xs">
              <span className="w-24 shrink-0 text-slate-400">{label}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-600" title={value}>
                {value}
              </span>
              <button
                type="button"
                onClick={() => onOpenPath(value)}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-600 transition hover:border-slate-300"
              >
                <FolderOpen size={11} />
              </button>
              <button
                type="button"
                onClick={() => onCopy(value)}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-600 transition hover:border-slate-300"
              >
                <Copy size={11} />
              </button>
            </div>
          ))}
        </div>
      </section>

      <p className="px-1 text-[11px] leading-5 text-slate-400">
        当前里程碑：登录会话、项目/缺陷列表、筛选与详情。SQLite 缓存、MD 导出、MCP 工具、通知窗口与 opencode 队列在后续接入。
      </p>
    </div>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 truncate text-sm font-medium text-slate-800">{value}</div>
    </div>
  );
}

function WorkspaceRow({ workspace }: { workspace: Workspace }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-slate-100 bg-white px-3 py-2">
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: workspace.logoColor || "#0ea5e9" }}
      />
      <span className="min-w-0 flex-1 truncate text-xs text-slate-700">{workspace.name}</span>
      <Badge tone="neutral">{workspace.id}</Badge>
    </div>
  );
}

function PlainRow(props: { label: string; value: string; onCopy: (text: string) => void }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <dt className="w-24 shrink-0 text-slate-400">{props.label}</dt>
      <dd className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-600">{props.value}</dd>
      <button
        type="button"
        onClick={() => props.onCopy(props.value)}
        className="text-slate-300 transition hover:text-slate-500"
      >
        <Copy size={11} />
      </button>
    </div>
  );
}
