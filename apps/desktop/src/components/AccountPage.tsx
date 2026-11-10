import { ExternalLink, LogOut, RefreshCw, ShieldCheck } from "lucide-react";

import type { AppInfo, SessionStatus, WorkspaceContext } from "../lib/api";
import { Badge, Button } from "./ui";

type Props = {
  info: AppInfo | null;
  status: SessionStatus | null;
  context: WorkspaceContext | null;
  onShowLogin: () => void;
  onLogout: () => void;
  onRefresh: () => void;
};

function initialOf(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "T";
}

/** Standalone account & session view, opened from the user chip in the sidebar. */
export function AccountPage({
  info,
  status,
  context,
  onShowLogin,
  onLogout,
  onRefresh,
}: Props) {
  const nick = context?.user.nick || info?.me || "已登录";
  const company = context?.user.company || "—";
  const userId = context?.user.userId || "—";
  const sessionUrl = status?.url || info?.sessionUrl || "会话窗口尚未创建";

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <section className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full bg-sky-100/70 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-28 left-1/3 h-48 w-48 rounded-full bg-emerald-100/60 blur-3xl" />

        <div className="relative flex items-center gap-4">
          <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-sky-400 to-emerald-400 text-xl font-semibold text-white shadow-lg shadow-sky-500/25">
            {initialOf(nick)}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold tracking-tight text-slate-900">
                {nick}
              </h2>
              <Badge tone={info?.loggedIn ? "green" : "amber"} dot>
                {info?.loggedIn ? "已登录" : "未登录"}
              </Badge>
            </div>
            <p className="mt-0.5 truncate text-xs text-slate-500">{company}</p>
            <p className="mt-0.5 truncate font-mono text-[10px] text-slate-400">
              ID {userId}
            </p>
          </div>
          <Button
            size="sm"
            className="ml-auto"
            onClick={onRefresh}
            icon={<RefreshCw size={13} />}
          >
            刷新状态
          </Button>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <ShieldCheck size={15} className="text-slate-400" />
              会话
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              登录态保存在隐藏 WebView 的 Cookie 中，不写入配置文件。
            </p>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">会话窗口</div>
            <div className="mt-1 text-sm text-slate-700">
              {status?.exists
                ? status.visible
                  ? "显示中"
                  : "已隐藏（后台桥）"
                : "未创建"}
            </div>
          </div>
          <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">当前用户 ID</div>
            <div className="mt-1 truncate font-mono text-[12px] text-slate-700">{userId}</div>
          </div>
        </div>

        <div className="mt-3 break-all rounded-xl border border-slate-100 bg-slate-50 p-3 font-mono text-[11px] text-slate-500">
          {sessionUrl}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="primary"
            onClick={onShowLogin}
            icon={<ExternalLink size={13} />}
          >
            打开 TAPD
          </Button>
          <Button size="sm" variant="danger" onClick={onLogout} icon={<LogOut size={13} />}>
            退出登录并清除数据
          </Button>
        </div>
      </section>

      <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 text-[11px] leading-6 text-slate-500">
        退出登录会清除 TAPD Cookie、页面缓存与本地离线数据，并回到扫码登录界面。退出后可随时重新扫码登录。
      </div>
    </div>
  );
}
