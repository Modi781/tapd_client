import { ExternalLink, LogOut, RefreshCw } from "lucide-react";

import { avatarSrc, type AppInfo, type WorkspaceContext } from "../lib/api";
import { Avatar } from "./Avatar";
import { UpdatePanel } from "./UpdatePanel";
import { Badge, Button } from "./ui";

type Props = {
  info: AppInfo | null;
  context: WorkspaceContext | null;
  onShowLogin: () => void;
  onLogout: () => void;
  onRefresh: () => void;
  toast?: (kind: "ok" | "error", text: string) => void;
};

/** Account & session view, opened from the user chip in the sidebar. */
export function AccountPage({
  info,
  context,
  onShowLogin,
  onLogout,
  onRefresh,
  toast,
}: Props) {
  const nick = context?.user.nick || info?.me || "已登录";
  const company = context?.user.company || "—";
  const userId = context?.user.userId || "—";

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <section className="relative overflow-hidden rounded-2xl border border-border bg-surface p-6 ">
        <div className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full bg-sky-100/70 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-28 left-1/3 h-48 w-48 rounded-full bg-emerald-100/60 blur-3xl" />

        <div className="relative flex flex-wrap items-center gap-4">
          <Avatar
            src={avatarSrc(info?.meAvatar)}
            name={nick}
            rounded="rounded-2xl"
            className="h-16 w-16 text-xl   border-2 border-white"
          />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-normal tracking-tight text-slate-900">
                {nick}
              </h2>
              <Badge tone={info?.loggedIn ? "green" : "amber"} dot>
                {info?.loggedIn ? "已登录" : "未登录"}
              </Badge>
            </div>
            <p className="mt-0.5 truncate text-ui-caption text-slate-500">{company}</p>
            <p className="mt-0.5 truncate font-mono text-ui-xs text-slate-400">
              ID {userId}
            </p>
          </div>

          <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto bg-transparent">
            <Button
              size="sm"
              onClick={onRefresh}
              icon={<RefreshCw size={13} />}
              title="重新读取当前用户与会话状态"
            >
              刷新
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={onShowLogin}
              icon={<ExternalLink size={13} />}
            >
              打开 TAPD
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={onLogout}
              icon={<LogOut size={13} />}
              title="清除 TAPD Cookie、页面缓存与本地离线数据"
            >
              退出登录
            </Button>
          </div>
        </div>
      </section>

      <UpdatePanel toast={toast} />
    </div>
  );
}
