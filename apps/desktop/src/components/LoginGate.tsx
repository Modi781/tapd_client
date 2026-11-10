import { useState } from "react";
import { Bug, CheckCircle2, ExternalLink, Loader2, RefreshCw, ShieldCheck } from "lucide-react";

import { api, type AppInfo, type SessionStatus } from "../lib/api";
import { Badge, Button } from "./ui";

type Props = {
  info: AppInfo | null;
  status: SessionStatus | null;
  onRefresh: () => void;
  onToast: (kind: "ok" | "error", text: string) => void;
};

export function LoginGate({ info, status, onRefresh, onToast }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [nick, setNick] = useState(info?.me ?? "");

  const run = async (name: string, action: () => Promise<string>) => {
    setBusy(name);
    try {
      const message = await action();
      onToast("ok", message);
    } catch (error) {
      onToast("error", String(error));
    } finally {
      setBusy(null);
      onRefresh();
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-slate-100 via-white to-sky-50 p-6">
      <div className="w-full max-w-2xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center gap-4 border-b border-slate-100 px-7 py-6">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-sky-400 to-emerald-400 text-slate-900 shadow-lg shadow-sky-500/20">
            <Bug size={26} strokeWidth={2.4} />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-900">TAPD Client</h1>
            <p className="mt-0.5 text-xs text-slate-500">
              登录一次，之后在后台保留会话；界面与数据都来自你自己的权限。
            </p>
          </div>
          <Badge tone="blue" className="ml-auto">
            M0 · 会话桥
          </Badge>
        </div>

        <div className="space-y-4 px-7 py-6">
          <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
            <div className="text-sm font-semibold text-amber-900">需要先登录 TAPD</div>
            <p className="mt-1 text-xs leading-6 text-amber-800/80">
              点击下方按钮打开 TAPD 登录窗口，完成公司账号或 SSO 登录。登录成功后窗口会自动隐藏，只作为后台数据桥使用。
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="primary"
                loading={busy === "open"}
                icon={<ExternalLink size={14} />}
                onClick={() => void run("open", async () => {
                  await api.sessionShow();
                  return "已打开 TAPD 登录窗口";
                })}
              >
                打开登录窗口
              </Button>
              <Button
                variant="secondary"
                loading={busy === "refresh"}
                icon={<RefreshCw size={14} />}
                onClick={() => void run("refresh", async () => {
                  const status = await api.sessionStatus();
                  return status.url ? `当前页面：${status.url}` : "会话窗口尚未创建";
                })}
              >
                重新检测
              </Button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
              <div className="text-[10px] uppercase tracking-wide text-slate-400">会话窗口</div>
              <div className="mt-1 text-sm text-slate-700">
                {status?.exists ? (status.visible ? "显示中" : "已隐藏（后台桥）") : "未创建"}
              </div>
            </div>
            <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
              <div className="text-[10px] uppercase tracking-wide text-slate-400">当前地址</div>
              <div className="mt-1 truncate font-mono text-[11px] text-slate-600" title={status?.url ?? ""}>
                {status?.url || info?.sessionUrl || "—"}
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-100 p-4">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-700">
              <ShieldCheck size={14} className="text-emerald-500" />
              登录态自动识别
            </div>
            <p className="mt-1 text-[11px] leading-5 text-slate-500">
              页面进入 <span className="font-mono">/tapd_fe/&lt;项目&gt;/</span> 后会自动标记登录。若识别失败，可填写昵称并手动确认。
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="text-[11px] text-slate-500">
                我的 TAPD 昵称（可选）
                <input
                  value={nick}
                  onChange={(event) => setNick(event.target.value)}
                  placeholder="例如：郭俊宏"
                  className="mt-1 block w-52 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-800 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                />
              </label>
              <Button
                variant="secondary"
                loading={busy === "mark"}
                icon={<CheckCircle2 size={14} />}
                onClick={() => void run("mark", async () => {
                  await api.markLoggedIn(nick.trim() || undefined);
                  return "已标记登录成功";
                })}
              >
                已完成登录
              </Button>
              {busy === "mark" ? <Loader2 size={14} className="animate-spin text-slate-400" /> : null}
            </div>
          </div>
        </div>

        <div className="border-t border-slate-100 bg-slate-50/60 px-7 py-3 text-[11px] text-slate-400">
          数据只在本机处理；Cookie 不出 WebView，请求日志不记录 Cookie。
        </div>
      </div>
    </div>
  );
}
