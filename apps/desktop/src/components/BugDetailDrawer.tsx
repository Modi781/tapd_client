import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileArchive,
  FileText,
  Image as ImageIcon,
  MessageSquare,
  Paperclip,
  UserRound,
  Video,
  X,
} from "lucide-react";
import clsx from "clsx";

import {
  api,
  formatBytes,
  type Attachment,
  type BugDetail,
  type ChangeEntry,
  type ChangeField,
  type Comment,
  type ExportResult,
  type MediaRef,
} from "../lib/api";
import {
  Badge,
  Button,
  PRIORITY_TONES,
  SEVERITY_TONES,
  STATUS_TONES,
  Spinner,
} from "./ui";

type Props = {
  open: boolean;
  detail: BugDetail | null;
  loading: boolean;
  error: string | null;
  exporting: boolean;
  lastExport: ExportResult | null;
  onClose: () => void;
  onOpenWeb: (url: string) => void;
  onCopy: (text: string) => void;
  onExport: (detail: BugDetail) => void;
  onOpenPath: (path: string) => void;
};

export function BugDetailDrawer(props: Props) {
  const {
    open,
    detail,
    loading,
    error,
    exporting,
    lastExport,
    onClose,
    onOpenWeb,
    onCopy,
    onExport,
    onOpenPath,
  } = props;
  const [showCustomFields, setShowCustomFields] = useState(false);
  const [showChanges, setShowChanges] = useState(true);

  useEffect(() => {
    if (!open) return;
    setShowCustomFields(false);
    setShowChanges(true);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const customFields = useMemo(
    () =>
      detail
        ? Object.entries(detail.customFields).filter(([, value]) => value.trim().length > 0)
        : [],
    [detail],
  );
  const embeddedMedia = detail?.embeddedMedia ?? [];
  const changes = detail?.changes ?? { total: 0, changes: [], error: null };
  const resourceCount = (detail?.attachments.length ?? 0) + embeddedMedia.length;
  const changeCount = changes.total || changes.changes.length;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="关闭详情"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/20 backdrop-blur-[1px]"
      />

      <aside className="relative flex h-full w-[640px] max-w-[94vw] flex-col border-l border-slate-200 bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
              <span className="rounded bg-rose-50 px-1.5 py-0.5 font-bold text-rose-600">
                BUG
              </span>
              <span className="font-mono">#{detail?.shortId || detail?.id?.slice(-7) || "—"}</span>
              {detail ? (
                <>
                  <Badge tone={STATUS_TONES[detail.status] ?? "neutral"}>
                    {detail.statusLabel || detail.status}
                  </Badge>
                  <Badge tone={PRIORITY_TONES[detail.priority] ?? "neutral"}>
                    {detail.priorityLabel || detail.priority || "—"}
                  </Badge>
                  <Badge tone={SEVERITY_TONES[detail.severity] ?? "neutral"} dot>
                    {detail.severityLabel || detail.severity || "—"}
                  </Badge>
                </>
              ) : null}
            </div>
            <h2 className="mt-2 text-base font-semibold leading-6 text-slate-900">
              {detail?.title || (loading ? "正在读取缺陷…" : "缺陷详情")}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs leading-6 text-rose-700">
              {error}
            </div>
          ) : null}

          {!error && loading && !detail ? (
            <div className="flex h-48 items-center justify-center gap-2 text-xs text-slate-400">
              <Spinner />
              正在加载详情…
            </div>
          ) : null}

          {detail ? (
            <div className="space-y-5">
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  icon={<ArrowUpRight size={13} />}
                  onClick={() => onOpenWeb(detail.bugUrl)}
                >
                  在 TAPD 中打开
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Copy size={13} />}
                  onClick={() => onCopy(detail.bugUrl)}
                >
                  复制链接
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Download size={13} />}
                  loading={exporting}
                  onClick={() => onExport(detail)}
                >
                  {exporting ? "导出中…" : "导出 MD"}
                </Button>
              </div>

              {lastExport ? (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-[11px] text-emerald-900">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">
                      已导出 {lastExport.assetCount} 个资源 ·{" "}
                      {formatBytes(lastExport.downloadedBytes)}
                    </span>
                    <div className="ml-auto flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onOpenPath(lastExport.dir)}
                        className="rounded border border-emerald-300 bg-white px-2 py-1 text-[10px]"
                      >
                        打开目录
                      </button>
                      <button
                        type="button"
                        onClick={() => onCopy(lastExport.markdownPath)}
                        className="rounded border border-emerald-300 bg-white px-2 py-1 text-[10px]"
                      >
                        复制路径
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 break-all font-mono text-[10px] text-emerald-700">
                    {lastExport.markdownPath}
                  </div>
                  {lastExport.warnings.length > 0 ? (
                    <ul className="mt-2 space-y-0.5 border-t border-emerald-200 pt-2 text-[10px] text-amber-700">
                      {lastExport.warnings.slice(0, 4).map((warning) => (
                        <li key={warning} className="break-all">
                          · {warning}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              <MetaGrid detail={detail} />

              <section>
                <SectionTitle icon={<FileText size={14} />} title="缺陷描述" />
                {detail.descriptionText ? (
                  <div className="mt-2 whitespace-pre-wrap break-words rounded-xl border border-slate-100 bg-slate-50/70 p-4 text-[13px] leading-6 text-slate-700">
                    {detail.descriptionText}
                  </div>
                ) : (
                  <div className="mt-2 rounded-xl border border-dashed border-slate-200 p-4 text-xs text-slate-400">
                    暂无文字描述
                    {detail.descriptionHtml.includes("<video") ? "（包含视频，见资源）" : ""}
                  </div>
                )}
                {detail.descriptionHtml.includes("<img") ||
                detail.descriptionHtml.includes("<video") ? (
                  <p className="mt-2 text-[11px] text-slate-400">
                    描述中包含内嵌图片/视频，已在下方「资源」列出；导出 MD 时会下载到 assets 目录。
                  </p>
                ) : null}
              </section>

              <section>
                <SectionTitle
                  icon={<Paperclip size={14} />}
                  title={`资源（${resourceCount}）`}
                />
                <div className="mt-2 space-y-2">
                  {resourceCount === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-200 p-3 text-xs text-slate-400">
                      没有附件或内嵌图片/视频
                    </div>
                  ) : (
                    <>
                      {detail.attachments.map((attachment) => (
                        <AttachmentRow
                          key={attachment.id}
                          attachment={attachment}
                          onCopy={onCopy}
                          onOpen={onOpenWeb}
                        />
                      ))}
                      {embeddedMedia.length > 0 ? (
                        <div className="space-y-1.5 rounded-xl border border-slate-100 bg-slate-50/60 p-2">
                          <p className="px-1 text-[10px] text-slate-400">
                            描述 / 评论内嵌（{embeddedMedia.length}）
                          </p>
                          {embeddedMedia.map((media, index) => (
                            <EmbeddedMediaRow
                              key={`${media.url}-${index}`}
                              media={media}
                              onCopy={onCopy}
                              onOpen={onOpenWeb}
                            />
                          ))}
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </section>

              <section>
                <SectionTitle
                  icon={<MessageSquare size={14} />}
                  title={`评论（${countComments(detail.comments)}）`}
                />
                <div className="mt-2 space-y-3">
                  {detail.comments.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-200 p-3 text-xs text-slate-400">
                      还没有评论
                    </div>
                  ) : (
                    detail.comments.map((comment) => (
                      <CommentItem key={comment.id} comment={comment} depth={0} />
                    ))
                  )}
                </div>
              </section>

              <section>
                <button
                  type="button"
                  onClick={() => setShowChanges((current) => !current)}
                  className="flex w-full items-center gap-2 text-left"
                >
                  <SectionTitle
                    icon={
                      showChanges ? <ChevronDown size={14} /> : <ChevronRight size={14} />
                    }
                    title={`变更记录（${changeCount}）`}
                  />
                </button>
                {showChanges ? (
                  <div className="mt-2 space-y-2">
                    {changes.error ? (
                      <div className="break-all rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] leading-5 text-amber-700">
                        变更记录获取失败：{changes.error}
                      </div>
                    ) : changes.changes.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-slate-200 p-3 text-xs text-slate-400">
                        暂无变更记录
                      </div>
                    ) : (
                      <>
                        {changes.changes.map((entry) => (
                          <ChangeItem key={entry.seq} entry={entry} />
                        ))}
                        {changeCount > changes.changes.length ? (
                          <p className="px-1 text-[10px] text-slate-400">
                            仅显示最近 {changes.changes.length} 条，共 {changeCount} 条。
                          </p>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : null}
              </section>

              {customFields.length > 0 ? (
                <section>
                  <button
                    type="button"
                    onClick={() => setShowCustomFields((current) => !current)}
                    className="flex w-full items-center gap-2 text-left"
                  >
                    <SectionTitle
                      icon={
                        showCustomFields ? (
                          <ChevronDown size={14} />
                        ) : (
                          <ChevronRight size={14} />
                        )
                      }
                      title={`自定义字段（${customFields.length}）`}
                    />
                  </button>
                  {showCustomFields ? (
                    <dl className="mt-2 grid gap-2 rounded-xl border border-slate-100 bg-slate-50/60 p-3 text-xs sm:grid-cols-2">
                      {customFields.map(([key, value]) => (
                        <div key={key} className="min-w-0">
                          <dt className="truncate font-mono text-[10px] text-slate-400">{key}</dt>
                          <dd className="mt-0.5 break-words text-slate-700">{value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </section>
              ) : null}
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function MetaGrid({ detail }: { detail: BugDetail }) {
  const items: Array<[string, string]> = [
    ["处理人", detail.owner || "—"],
    ["创建人", detail.creator || "—"],
    ["创建时间", detail.created || "—"],
    ["最后修改", detail.modified || "—"],
    ["发现版本", detail.versionReport || "—"],
    ["迭代", detail.iterationName || "—"],
    ["模块", detail.module || "—"],
    ["修复人", detail.fixer || "—"],
  ];

  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-slate-100 bg-white p-3 text-xs sm:grid-cols-4">
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-[10px] uppercase tracking-wide text-slate-400">{label}</dt>
          <dd className="mt-0.5 truncate text-slate-700" title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Thumbnails are proxied through Rust: the main window cannot send TAPD cookies. */
const previewCache = new Map<string, string>();

function useMediaPreview(url: string, enabled: boolean) {
  const [source, setSource] = useState<string | null>(() => previewCache.get(url) ?? null);

  useEffect(() => {
    if (!enabled || source) return;
    const cached = previewCache.get(url);
    if (cached) {
      setSource(cached);
      return;
    }

    let cancelled = false;
    api
      .mediaPreview(url)
      .then((data) => {
        previewCache.set(url, data);
        if (!cancelled) setSource(data);
      })
      .catch(() => {
        /* preview is best-effort; the row still links to the original */
      });

    return () => {
      cancelled = true;
    };
  }, [url, enabled, source]);

  return source;
}

function AttachmentRow(props: {
  attachment: Attachment;
  onCopy: (text: string) => void;
  onOpen: (url: string) => void;
}) {
  const { attachment, onCopy, onOpen } = props;
  const Icon = iconForAttachment(attachment);
  const isImage = `${attachment.filetype} ${attachment.contentType}`
    .toLowerCase()
    .includes("image");
  const preview = useMediaPreview(attachment.downloadUrl, isImage);

  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-100 bg-white p-3">
      <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-slate-50 text-slate-400">
        {preview ? (
          <img
            src={preview}
            alt={attachment.filename}
            className="h-full w-full object-cover"
          />
        ) : (
          <Icon size={17} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-slate-700" title={attachment.filename}>
          {attachment.filename}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-slate-400">
          <span>{formatBytes(attachment.size)}</span>
          <span className="truncate">{attachment.contentType || attachment.filetype}</span>
          {attachment.owner ? <span>{attachment.owner}</span> : null}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onOpen(attachment.downloadUrl)}
        className="shrink-0 rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-600 transition hover:border-slate-300"
      >
        打开
      </button>
      <button
        type="button"
        onClick={() => onCopy(attachment.downloadUrl)}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-600 transition hover:border-slate-300"
      >
        <Copy size={11} />
        链接
      </button>
    </div>
  );
}

function EmbeddedMediaRow(props: {
  media: MediaRef;
  onCopy: (text: string) => void;
  onOpen: (url: string) => void;
}) {
  const { media, onCopy, onOpen } = props;
  const Icon = media.kind === "image" ? ImageIcon : media.kind === "video" ? Video : Paperclip;
  const kindLabel = media.kind === "image" ? "图片" : media.kind === "video" ? "视频" : "文件";
  const preview = useMediaPreview(media.url, media.kind === "image");

  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-100 bg-white p-2.5">
      <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-md bg-slate-50 text-slate-400">
        {preview ? (
          <img
            src={preview}
            alt={media.filenameHint}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <Icon size={15} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-slate-700" title={media.url}>
          {media.filenameHint || "内嵌资源"}
        </div>
        <div className="mt-0.5 text-[10px] text-slate-400">{kindLabel} · 描述/评论内嵌</div>
      </div>
      <button
        type="button"
        onClick={() => onOpen(media.url)}
        className="shrink-0 rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-600 transition hover:border-slate-300"
      >
        打开
      </button>
      <button
        type="button"
        onClick={() => onCopy(media.url)}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-600 transition hover:border-slate-300"
      >
        <Copy size={11} />
        链接
      </button>
    </div>
  );
}

function ChangeItem({ entry }: { entry: ChangeEntry }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
        <span className="font-mono text-slate-500">#{entry.seq}</span>
        <span className="font-medium text-slate-600">{entry.author || "未知"}</span>
        <span className="inline-flex items-center gap-1">
          <CalendarClock size={10} />
          {entry.time}
        </span>
        {entry.kind ? (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
            {entry.kind}
          </span>
        ) : null}
      </div>
      {entry.fields.length === 0 ? (
        <p className="mt-2 text-[11px] text-slate-400">（无字段明细）</p>
      ) : (
        <dl className="mt-2 space-y-1">
          {entry.fields.map((field, index) => (
            <ChangeFieldLine key={`${field.field}-${index}`} field={field} />
          ))}
        </dl>
      )}
    </div>
  );
}

function ChangeFieldLine({ field }: { field: ChangeField }) {
  return (
    <div className="grid grid-cols-[minmax(56px,auto)_1fr_auto_1fr] items-baseline gap-2 text-[11px] leading-5">
      <dt className="truncate text-slate-400" title={field.field}>
        {field.field}
      </dt>
      <dd
        className="break-words text-slate-400 line-through decoration-slate-300"
        title={field.before}
      >
        {field.before || "—"}
      </dd>
      <ArrowRight size={10} className="shrink-0 text-slate-300" />
      <dd className="break-words text-slate-700" title={field.after}>
        {field.after || "—"}
      </dd>
    </div>
  );
}

function CommentItem(props: { comment: Comment; depth: number }) {
  const { comment, depth } = props;

  return (
    <div
      className={clsx(
        "rounded-xl border border-slate-100 bg-white p-3",
        depth > 0 && "ml-5 border-l-2 border-l-slate-200",
      )}
    >
      <div className="flex items-center gap-2 text-[11px] text-slate-400">
        <span className="grid h-5 w-5 place-items-center rounded-full bg-slate-100 text-[9px] text-slate-500">
          {comment.author ? comment.author.slice(-2) : "?"}
        </span>
        <span className="font-medium text-slate-600">{comment.author || "未知"}</span>
        <span className="inline-flex items-center gap-1">
          <CalendarClock size={10} />
          {comment.created}
        </span>
        {comment.isDeleted ? <Badge tone="red">已删除</Badge> : null}
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-6 text-slate-700">
        {comment.plainText || "（空评论）"}
      </p>
      {comment.replies.length > 0 ? (
        <div className="mt-2 space-y-2">
          {comment.replies.map((reply) => (
            <CommentItem key={reply.id} comment={reply} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SectionTitle(props: { icon: ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
      <span className="text-slate-400">{props.icon}</span>
      {props.title}
    </div>
  );
}

function countComments(comments: Comment[]): number {
  return comments.reduce(
    (total, comment) => total + 1 + countComments(comment.replies),
    0,
  );
}

function iconForAttachment(attachment: Attachment) {
  const type = `${attachment.filetype} ${attachment.contentType}`.toLowerCase();
  if (type.includes("image")) return ImageIcon;
  if (type.includes("video")) return Video;
  if (type.includes("compress") || type.includes("zip")) return FileArchive;
  if (type.includes("text") || type.includes("log") || type.includes("ips")) return FileText;
  if (type.includes("user")) return UserRound;
  return Paperclip;
}
