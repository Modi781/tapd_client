import {
  Copy,
  FolderOpen,
  KeyRound,
  LogIn,
  LogOut,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import type { AppInfo, SessionStatus, WorkspaceContext } from "../lib/api";
import type { SettingsSectionProps } from "../lib/feature";
import { AgentSettings } from "./AgentSettings";
import { ProjectSettings } from "./ProjectSettings";
import { NotificationSettings } from "./NotificationSettings";
import { Button } from "./ui";

type Props = {
  info: AppInfo | null;
  status: SessionStatus | null;
  context: WorkspaceContext | null;
  onShowLogin: () => void;
  onLogout: () => void;
  onRefresh: () => void;
  onOpenPath: (path: string) => void;
  onCopy: (text: string) => void;
  toast: SettingsSectionProps["toast"];
};

export function SettingsPage(props: Props) {
  const { info, status, context, onShowLogin, onLogout, onRefresh, onOpenPath, onCopy, toast } = props;

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

      <ProjectSettings context={context} toast={toast} />

      <NotificationSettings toast={toast} />

      <AgentSettings toast={toast} />

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
        当前里程碑：登录会话、项目/缺陷列表、筛选与详情。SQLite 缓存、MD 导出、通知窗口与 opencode 队列在后续接入。
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
