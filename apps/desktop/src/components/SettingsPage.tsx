import { useState } from "react";
import { Copy, FileJson, FolderOpen, ShieldCheck, X } from "lucide-react";

import type { AppInfo, WorkspaceContext } from "../lib/api";
import type { SettingsSectionProps } from "../lib/feature";
import { AgentSettings } from "./AgentSettings";
import { CapturesPage } from "./CapturesPage";
import { ProjectSettings } from "./ProjectSettings";
import { NotificationSettings } from "./NotificationSettings";
import { Button } from "./ui";

type Props = {
  info: AppInfo | null;
  context: WorkspaceContext | null;
  onOpenPath: (path: string) => void;
  onCopy: (text: string) => void;
  hiddenWorkspaceIds: string[];
  onSetWorkspaceVisible: (id: string, visible: boolean) => void;
  toast: SettingsSectionProps["toast"];
};

export function SettingsPage(props: Props) {
  const {
    info,
    context,
    onOpenPath,
    onCopy,
    hiddenWorkspaceIds,
    onSetWorkspaceVisible,
    toast,
  } = props;
  const [capturesOpen, setCapturesOpen] = useState(false);

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
      <ProjectSettings
        context={context}
        hiddenWorkspaceIds={hiddenWorkspaceIds}
        onSetWorkspaceVisible={onSetWorkspaceVisible}
        toast={toast}
      />

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

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <FileJson size={15} className="text-slate-400" />
              接口抓包
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              记录 TAPD 接口请求，便于排查问题。
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setCapturesOpen(true)}
            icon={<FileJson size={13} />}
          >
            打开抓包
          </Button>
        </div>
      </section>

      {capturesOpen ? (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/30 p-6 backdrop-blur-[1px]"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCapturesOpen(false);
          }}
        >
          <div className="flex h-[min(82vh,760px)] w-[min(1180px,94vw)] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/10">
            <header className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-4 py-3">
              <FileJson size={15} className="text-slate-400" />
              <h2 className="text-[13px] font-semibold text-slate-900">接口抓包</h2>
              <button
                type="button"
                aria-label="关闭抓包"
                onClick={() => setCapturesOpen(false)}
                className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
              >
                <X size={16} />
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <CapturesPage toast={toast} onOpenPath={onOpenPath} />
            </div>
          </div>
        </div>
      ) : null}
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
