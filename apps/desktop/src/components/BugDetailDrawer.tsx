import { memo, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileArchive,
  FileText,
  Eye,
  GitBranch,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  Paperclip,
  Send,
  UserPlus,
  UserRound,
  Video,
  X,
} from "lucide-react";
import clsx from "clsx";

import {
  api,
  ensureMediaEndpoint,
  formatBytes,
  mediaSrc,
  type Attachment,
  type BugDetail,
  type BugTransitionInfo,
  type ChangeEntry,
  type ChangeField,
  type Comment,
  type ExportResult,
  type MediaRef,
  type OpenMediaMode,
  type OpenTarget,
  type OpenTargetSet,
  type WorkspaceMember,
} from "../lib/api";
import { isMyBug, ownerNames } from "../lib/bug";
import { MediaPreview, type PreviewItem } from "./MediaPreview";
import { SkeletonBlock } from "./Skeleton";
import {
  Badge,
  Button,
  PRIORITY_TONES,
  SEVERITY_TONES,
  STATUS_TONES,
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
  onAgentFix: (detail: BugDetail) => void;
  onOpenPath: (path: string) => void;
  onOpenMedia: (
    url: string,
    mode: OpenMediaMode,
    kind?: string,
    target?: string,
  ) => void;
  /** TAPD nickname of the signed-in user; decides whether actions are open. */
  me: string | null;
  /** Workspace people directory for the owner / developer pickers. */
  members: WorkspaceMember[];
  membersLoading: boolean;
  onRefreshMembers: () => void;
  onClaim: (detail: BugDetail) => Promise<void>;
  onAddComment: (detail: BugDetail, comment: string) => Promise<void>;
  onChangeField: (detail: BugDetail, field: string, value: string) => Promise<void>;
  onTransition: (detail: BugDetail, status: string) => Promise<void>;
};

function BugDetailDrawerImpl(props: Props) {
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
    onAgentFix,
    onOpenPath,
    onOpenMedia,
    me,
    members,
    membersLoading,
    onRefreshMembers,
    onClaim,
    onAddComment,
    onChangeField,
    onTransition,
  } = props;
  const [showCustomFields, setShowCustomFields] = useState(false);
  const [showChanges, setShowChanges] = useState(true);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [targetSets, setTargetSets] = useState<Record<string, OpenTargetSet>>({});
  const [, bumpMedia] = useState(0);

  /** The single write action currently in flight (claim/comment/field/status). */
  const [busy, setBusy] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [transitions, setTransitions] = useState<BugTransitionInfo | null>(null);
  const [transitionsLoading, setTransitionsLoading] = useState(false);
  const [transitionsError, setTransitionsError] = useState<string | null>(null);

  const mine = detail ? isMyBug(detail.owner, me) : true;

  // Media URLs need the loopback proxy; recover if `app_info` raced startup.
  useEffect(() => {
    if (!open) return;
    void ensureMediaEndpoint().then(() => bumpMedia((value) => value + 1));
  }, [open]);

  // Reset collapsible sections each time the drawer is opened. Kept separate
  // from the key handler so opening the preview doesn't reset them again.
  useEffect(() => {
    if (!open) return;
    setShowCustomFields(false);
    setShowChanges(true);
    setPreviewIndex(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // The preview handles its own Escape; don't also close the drawer.
      if (event.key === "Escape" && previewIndex === null) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, previewIndex]);

  // A different bug starts with an empty comment box.
  useEffect(() => {
    setCommentText("");
  }, [detail?.id]);

  // Only bugs the user owns expose workflow transitions.
  useEffect(() => {
    if (!open || !detail || !mine) {
      setTransitions(null);
      setTransitionsError(null);
      setTransitionsLoading(false);
      return;
    }

    let cancelled = false;
    setTransitionsLoading(true);
    setTransitionsError(null);
    void api
      .bugTransitions(detail.workspaceId, detail.id)
      .then((info) => {
        if (!cancelled) setTransitions(info);
      })
      .catch((cause) => {
        if (!cancelled) setTransitionsError(String(cause));
      })
      .finally(() => {
        if (!cancelled) setTransitionsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, detail?.id, detail?.status, detail?.workspaceId, mine]);

  const runClaim = async () => {
    if (!detail || busy) return;
    setBusy("claim");
    try {
      await onClaim(detail);
    } catch {
      // The App reports the failure; the control just unlocks again.
    } finally {
      setBusy(null);
    }
  };

  const runFieldChange = async (field: string, value: string) => {
    if (!detail || busy || !value.trim() || value.trim() === currentFieldValue(detail, field)) {
      return;
    }
    setBusy(`field:${field}`);
    try {
      await onChangeField(detail, field, value);
    } catch {
      // Reported upstream.
    } finally {
      setBusy(null);
    }
  };

  const runTransition = async (status: string) => {
    if (!detail || busy) return;
    setBusy(`transition:${status}`);
    try {
      await onTransition(detail, status);
    } catch {
      // Reported upstream.
    } finally {
      setBusy(null);
    }
  };

  const submitComment = async () => {
    if (!detail || busy) return;
    const text = commentText.trim();
    if (!text) return;
    setBusy("comment");
    try {
      await onAddComment(detail, text);
      setCommentText("");
    } catch {
      // Reported upstream; keep the draft so it can be retried.
    } finally {
      setBusy(null);
    }
  };

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

  const previewItems = useMemo<PreviewItem[]>(() => {
    const items: PreviewItem[] = [];
    for (const attachment of detail?.attachments ?? []) {
      const kind = mediaKindOf(
        attachment.filename,
        attachment.contentType,
        attachment.filetype,
      );
      if (kind === "image" || kind === "video") {
        items.push({
          url: attachment.downloadUrl,
          kind,
          label: attachment.filename,
          size: attachment.size,
        });
      }
    }
    for (const media of detail?.embeddedMedia ?? []) {
      if (media.kind === "image" || media.kind === "video") {
        items.push({
          url: media.url,
          kind: media.kind,
          label: media.filenameHint,
        });
      }
    }
    return items;
  }, [detail]);

  const resourceKinds = useMemo(() => {
    const kinds = new Set<string>();
    for (const attachment of detail?.attachments ?? []) {
      kinds.add(
        mediaKindOf(attachment.filename, attachment.contentType, attachment.filetype),
      );
    }
    for (const media of detail?.embeddedMedia ?? []) {
      kinds.add(media.kind === "image" || media.kind === "video" ? media.kind : "file");
    }
    return Array.from(kinds).sort();
  }, [detail]);

  // Load the "open with" options once per resource kind.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    for (const kind of resourceKinds) {
      if (targetSets[kind]) continue;
      void api
        .openTargets(kind)
        .then((set) => {
          if (cancelled) return;
          setTargetSets((current) =>
            current[kind] ? current : { ...current, [kind]: set },
          );
        })
        .catch(() => {
          /* menu falls back to a single "打开" action */
        });
    }
    return () => {
      cancelled = true;
    };
  }, [open, resourceKinds, targetSets]);

  const selectTarget = (kind: string, id: string) => {
    setTargetSets((current) =>
      current[kind] ? { ...current, [kind]: { ...current[kind], selected: id } } : current,
    );
    void api.setOpenTarget(kind, id).catch(() => {
      /* keep the local choice; it is re-validated on the next load */
    });
  };

  useEffect(() => {
    if (!open) setPreviewIndex(null);
  }, [open]);

  return (
    <>
      <aside
        aria-hidden={!open}
        className={clsx(
          "flex h-full min-w-0 flex-col overflow-hidden rounded-xl bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)] ring-1 ring-black/[0.06]",
          !open && "pointer-events-none",
        )}
      >
        <div
          className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4"
          data-tauri-drag-region
        >
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
            {detail ? (
              <h2 className="mt-2 text-base font-semibold leading-6 text-slate-900">
                {detail.title}
              </h2>
            ) : loading ? (
              <SkeletonBlock className="mt-3 h-4 w-3/4 rounded" />
            ) : (
              <h2 className="mt-2 text-base font-semibold leading-6 text-slate-900">
                缺陷详情
              </h2>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭详情"
            title="关闭详情"
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

          {!error && loading && !detail ? <DetailSkeleton /> : null}

          {detail ? (
            <div className="space-y-5">
              <MetaGrid
                detail={detail}
                mine={mine}
                members={members}
                membersLoading={membersLoading}
                savingField={
                  busy?.startsWith("field:") ? busy.slice("field:".length) : null
                }
                onChangeField={(field, value) => void runFieldChange(field, value)}
                onRefreshMembers={onRefreshMembers}
              />

              {!mine ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] leading-5 text-amber-800">
                  <p className="font-semibold">
                    当前处理人：{detail.owner || "未分配"}
                  </p>
                  <p className="mt-0.5">
                    认领后才能评论、修改处理人与开发人员、流转状态。
                  </p>
                </div>
              ) : (
                <section>
                  <SectionTitle icon={<GitBranch size={14} />} title="状态流转" />
                  <div className="mt-2">
                    {transitionsLoading ? (
                      <p className="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
                        <Loader2 size={12} className="animate-spin" />
                        正在读取可流转状态…
                      </p>
                    ) : transitionsError ? (
                      <div className="break-all rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] leading-5 text-amber-700">
                        流转状态读取失败：{transitionsError}
                      </div>
                    ) : (transitions?.transitions.length ?? 0) === 0 ? (
                      <p className="rounded-xl border border-dashed border-slate-200 p-3 text-xs text-slate-400">
                        当前状态没有可执行的流转
                      </p>
                    ) : (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {transitions!.transitions.map((choice) => (
                          <Button
                            key={choice.key}
                            size="sm"
                            variant="secondary"
                            loading={busy === `transition:${choice.key}`}
                            disabled={busy !== null}
                            onClick={() => void runTransition(choice.key)}
                          >
                            {choice.label}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                </section>
              )}

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
                          previewItems={previewItems}
                          onPreview={setPreviewIndex}
                          onOpen={onOpenMedia}
                          targetSets={targetSets}
                          onSelectTarget={selectTarget}
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
                              previewItems={previewItems}
                              onPreview={setPreviewIndex}
                              onOpen={onOpenMedia}
                              targetSets={targetSets}
                              onSelectTarget={selectTarget}
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

              {mine ? (
                <section>
                  <SectionTitle
                    icon={<MessageSquarePlus size={14} />}
                    title="添加评论"
                  />
                  <textarea
                    value={commentText}
                    onChange={(event) => setCommentText(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                        event.preventDefault();
                        void submitComment();
                      }
                    }}
                    rows={4}
                    placeholder="写评论（纯文本，⌘/Ctrl + Enter 发送）"
                    className="mt-2 w-full resize-y rounded-xl border border-slate-200 bg-white p-3 text-xs leading-6 text-slate-700 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                  />
                  <div className="mt-2 flex items-center justify-end gap-2">
                    <span className="mr-auto text-[10px] text-slate-400">
                      {commentText.length > 0 ? `${commentText.length} 字` : ""}
                    </span>
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<Send size={13} />}
                      loading={busy === "comment"}
                      disabled={busy !== null || commentText.trim().length === 0}
                      onClick={() => void submitComment()}
                    >
                      发表评论
                    </Button>
                  </div>
                </section>
              ) : null}
            </div>
          ) : null}
        </div>

        {detail ? (
          <div className="shrink-0 border-t border-slate-100 bg-white px-4 py-3">
            {lastExport ? (
              <div className="mb-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[10px] leading-4 text-emerald-900">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">
                    已导出 {lastExport.assetCount} 个资源 ·{" "}
                    {formatBytes(lastExport.downloadedBytes)}
                  </span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onOpenPath(lastExport.dir)}
                      className="rounded border border-emerald-300 bg-white px-1.5 py-0.5"
                    >
                      打开目录
                    </button>
                    <button
                      type="button"
                      onClick={() => onCopy(lastExport.markdownPath)}
                      className="rounded border border-emerald-300 bg-white px-1.5 py-0.5"
                    >
                      复制路径
                    </button>
                  </div>
                </div>
                <div className="mt-0.5 truncate font-mono text-emerald-700" title={lastExport.markdownPath}>
                  {lastExport.markdownPath}
                </div>
                {lastExport.warnings.length > 0 ? (
                  <div className="mt-1 truncate text-amber-700" title={lastExport.warnings.join("；")}>
                    {lastExport.warnings[0]}
                    {lastExport.warnings.length > 1 ? ` 等 ${lastExport.warnings.length} 条` : ""}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {!mine ? (
                <Button
                  size="sm"
                  variant="primary"
                  icon={<UserPlus size={13} />}
                  loading={busy === "claim"}
                  disabled={busy !== null && busy !== "claim"}
                  onClick={() => void runClaim()}
                >
                  认领
                </Button>
              ) : null}
              <Button
                size="sm"
                variant={mine ? "primary" : "secondary"}
                icon={<ArrowUpRight size={13} />}
                onClick={() => onOpenWeb(detail.bugUrl)}
              >
                在 TAPD 中打开
              </Button>
              {mine ? (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Bot size={13} />}
                  disabled={exporting || loading}
                  onClick={() => onAgentFix(detail)}
                >
                  用 Agent 修复
                </Button>
              ) : null}
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
          </div>
        ) : null}
      </aside>

      {previewIndex !== null && previewItems[previewIndex] ? (
        <MediaPreview
          items={previewItems}
          index={previewIndex}
          onIndexChange={setPreviewIndex}
          onClose={() => setPreviewIndex(null)}
          onOpenExternal={(url, mode) =>
            onOpenMedia(url, mode, previewItems[previewIndex]?.kind)
          }
        />
      ) : null}
    </>
  );
}

/** Memoized: the pane is large and only changes when its own props change. */
export const BugDetailDrawer = memo(BugDetailDrawerImpl);

/**
 * Placeholder that mirrors the panel's loaded layout (meta grid, description,
 * resources, comments) so content does not jump into place.
 */
function DetailSkeleton() {
  return (
    <div role="status" aria-busy="true" className="space-y-5">
      <span className="sr-only">正在加载缺陷详情</span>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-slate-100 bg-white p-3 sm:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="space-y-1.5">
            <SkeletonBlock className="h-2.5 w-10" />
            <SkeletonBlock className="h-3 w-16" />
          </div>
        ))}
      </div>

      <div>
        <SkeletonBlock className="h-3 w-16" />
        <div className="mt-2 space-y-2 rounded-xl border border-slate-100 bg-slate-50/70 p-4">
          <SkeletonBlock className="h-3 w-full" />
          <SkeletonBlock className="h-3 w-11/12" />
          <SkeletonBlock className="h-3 w-2/3" />
        </div>
      </div>

      <div>
        <SkeletonBlock className="h-3 w-20" />
        <div className="mt-2 flex items-center gap-3 rounded-xl border border-slate-100 bg-white p-3">
          <SkeletonBlock className="h-10 w-10 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <SkeletonBlock className="h-3 w-1/2" />
            <SkeletonBlock className="h-2.5 w-1/4" />
          </div>
          <SkeletonBlock className="h-6 w-14 shrink-0 rounded-md" />
        </div>
      </div>

      <div>
        <SkeletonBlock className="h-3 w-16" />
        <div className="mt-2 space-y-2 rounded-xl border border-slate-100 bg-white p-3">
          <div className="flex items-center gap-2">
            <SkeletonBlock className="h-5 w-5 rounded-full" />
            <SkeletonBlock className="h-2.5 w-16" />
            <SkeletonBlock className="h-2.5 w-24" />
          </div>
          <SkeletonBlock className="h-3 w-full" />
          <SkeletonBlock className="h-3 w-4/5" />
        </div>
      </div>
    </div>
  );
}

function MetaGrid(props: {
  detail: BugDetail;
  mine: boolean;
  members: WorkspaceMember[];
  membersLoading: boolean;
  savingField: string | null;
  onChangeField: (field: string, value: string) => void;
  onRefreshMembers: () => void;
}) {
  const {
    detail,
    mine,
    members,
    membersLoading,
    savingField,
    onChangeField,
    onRefreshMembers,
  } = props;

  const items: Array<[string, string]> = [
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
      <UserField
        label="处理人"
        field="current_owner"
        value={detail.owner}
        mine={mine}
        members={members}
        membersLoading={membersLoading}
        saving={savingField === "current_owner"}
        onChange={onChangeField}
        onRefreshMembers={onRefreshMembers}
      />
      <UserField
        label="开发人员"
        field="de"
        value={detail.de}
        mine={mine}
        members={members}
        membersLoading={membersLoading}
        saving={savingField === "de"}
        onChange={onChangeField}
        onRefreshMembers={onRefreshMembers}
      />
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

/** Owner / developer cell: a picker for the owner, plain text otherwise. */
function UserField(props: {
  label: string;
  field: "current_owner" | "de";
  value: string;
  mine: boolean;
  members: WorkspaceMember[];
  membersLoading: boolean;
  saving: boolean;
  onChange: (field: string, value: string) => void;
  onRefreshMembers: () => void;
}) {
  const {
    label,
    field,
    value,
    mine,
    members,
    membersLoading,
    saving,
    onChange,
    onRefreshMembers,
  } = props;
  const current = value.trim();

  if (!mine) {
    return (
      <div className="min-w-0">
        <dt className="text-[10px] uppercase tracking-wide text-slate-400">{label}</dt>
        <dd className="mt-0.5 truncate text-slate-700" title={current || "—"}>
          {current || "—"}
        </dd>
      </div>
    );
  }

  const optionNicks = Array.from(
    new Set([
      ...members.map((member) => member.nick).filter(Boolean),
      ...ownerNames(current),
      ...(current ? [current] : []),
    ]),
  );

  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-slate-400">
        {label}
        {saving ? <Loader2 size={9} className="animate-spin" /> : null}
      </dt>
      <dd className="mt-0.5">
        <select
          value={current}
          disabled={saving}
          onChange={(event) => onChange(field, event.target.value)}
          onFocus={() => {
            if (members.length === 0 && !membersLoading) onRefreshMembers();
          }}
          title="从项目成员中选择"
          className="w-full min-w-0 truncate rounded-md border border-slate-200 bg-white px-1 py-0.5 text-xs text-slate-700 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100 disabled:opacity-60"
        >
          {!current ? (
            <option value="">
              {membersLoading ? "加载中…" : "未指定"}
            </option>
          ) : null}
          {optionNicks.map((nick) => (
            <option key={nick} value={nick}>
              {nick}
            </option>
          ))}
        </select>
      </dd>
    </div>
  );
}

function currentFieldValue(detail: BugDetail, field: string): string {
  return (field === "de" ? detail.de : detail.owner).trim();
}

/** TAPD resources are loaded through the loopback media proxy. */
function Thumbnail(props: {
  url: string;
  icon: typeof ImageIcon;
  iconSize?: number;
  onClick?: () => void;
  title?: string;
}) {
  const { url, icon: Icon, iconSize = 16, onClick, title } = props;
  const [broken, setBroken] = useState(false);
  const source = mediaSrc(url);
  const clickable = Boolean(onClick);

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={!clickable}
      className={clsx(
        "grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-slate-50 text-slate-400",
        clickable && "transition hover:ring-2 hover:ring-sky-200",
      )}
    >
      {source && !broken ? (
        <img
          src={source}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        <Icon size={iconSize} />
      )}
    </button>
  );
}

/** Explicit, always-visible entry point for the in-app preview. */
function PreviewButton(props: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      title="预览"
      aria-label="预览"
      className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:text-slate-800"
    >
      <Eye size={13} />
    </button>
  );
}

/**
 * Split button: the icon shows the current default app, the caret picks
 * another one. Only "open" targets live in this menu.
 */
function OpenButton(props: {
  kind: string;
  targets: OpenTargetSet | undefined;
  onSelect: (id: string) => void;
  onOpen: () => void;
}) {
  const { kind, targets, onSelect, onOpen } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const selected =
    targets?.targets.find((target) => target.id === targets.selected) ?? null;

  return (
    <div className="relative shrink-0">
      <div className="inline-flex items-stretch overflow-hidden rounded-md border border-slate-200 bg-white text-[11px] text-slate-600">
        <button
          type="button"
          onClick={onOpen}
          title={selected ? `用${selected.label}打开` : "打开"}
          className="inline-flex items-center gap-1.5 px-2 py-1 transition hover:bg-slate-50"
        >
          <TargetIcon target={selected} fallback="打开" />
          打开
        </button>
        <button
          type="button"
          aria-label="选择默认打开方式"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((current) => !current)}
          className="border-l border-slate-200 px-1 transition hover:bg-slate-50"
        >
          <ChevronDown size={11} />
        </button>
      </div>

      {menuOpen ? (
        <>
          <button
            type="button"
            aria-label="关闭菜单"
            onClick={() => setMenuOpen(false)}
            className="fixed inset-0 z-20 cursor-default"
          />
          <div className="absolute right-0 z-30 mt-1 w-52 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
            <p className="px-3 py-1 text-[10px] text-slate-400">默认打开方式</p>
            {(targets?.targets ?? []).map((target) => {
              const active = target.id === targets?.selected;
              return (
                <button
                  key={`${kind}-${target.id}`}
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onSelect(target.id);
                  }}
                  className={clsx(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition hover:bg-slate-50",
                    active ? "text-slate-800" : "text-slate-600",
                  )}
                >
                  <TargetIcon target={target} fallback="应用" />
                  <span className="truncate">{target.label}</span>
                  {active ? <Check size={12} className="ml-auto text-sky-500" /> : null}
                </button>
              );
            })}
            {targets && targets.targets.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-slate-400">没有可用的应用</p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function TargetIcon(props: {
  target: Pick<OpenTarget, "icon" | "label"> | null;
  fallback: string;
}) {
  const { target, fallback } = props;
  if (target?.icon) {
    return (
      <img
        src={target.icon}
        alt={target.label}
        title={fallback}
        className="h-4 w-4 shrink-0 rounded-[4px] object-contain"
      />
    );
  }
  return (
    <span
      title={fallback}
      className="grid h-4 w-4 shrink-0 place-items-center rounded-[4px] bg-slate-100 text-slate-500"
    >
      <Paperclip size={9} />
    </span>
  );
}

function AttachmentRow(props: {
  attachment: Attachment;
  previewItems: PreviewItem[];
  onPreview: (index: number) => void;
  onOpen: (url: string, mode: OpenMediaMode, kind?: string, target?: string) => void;
  targetSets: Record<string, OpenTargetSet>;
  onSelectTarget: (kind: string, id: string) => void;
}) {
  const { attachment, previewItems, onPreview, onOpen, targetSets, onSelectTarget } = props;
  const Icon = iconForAttachment(attachment);
  const kind = mediaKindOf(attachment.filename, attachment.contentType, attachment.filetype);
  const previewable = kind === "image" || kind === "video";
  const previewIndex = previewable
    ? previewItems.findIndex((item) => item.url === attachment.downloadUrl)
    : -1;

  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-100 bg-white p-3">
      <Thumbnail
        url={attachment.downloadUrl}
        icon={Icon}
        iconSize={17}
        title={previewable ? "预览" : undefined}
        onClick={previewable && previewIndex >= 0 ? () => onPreview(previewIndex) : undefined}
      />
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
      {previewable && previewIndex >= 0 ? (
        <PreviewButton onClick={() => onPreview(previewIndex)} />
      ) : null}
      <OpenButton
        kind={kind}
        targets={targetSets[kind]}
        onSelect={(id) => onSelectTarget(kind, id)}
        onOpen={() => onOpen(attachment.downloadUrl, "file", kind)}
      />
    </div>
  );
}

function EmbeddedMediaRow(props: {
  media: MediaRef;
  previewItems: PreviewItem[];
  onPreview: (index: number) => void;
  onOpen: (url: string, mode: OpenMediaMode, kind?: string, target?: string) => void;
  targetSets: Record<string, OpenTargetSet>;
  onSelectTarget: (kind: string, id: string) => void;
}) {
  const { media, previewItems, onPreview, onOpen, targetSets, onSelectTarget } = props;
  const Icon = media.kind === "image" ? ImageIcon : media.kind === "video" ? Video : Paperclip;
  const kindLabel = media.kind === "image" ? "图片" : media.kind === "video" ? "视频" : "文件";
  const previewable = media.kind === "image" || media.kind === "video";
  const previewIndex = previewable
    ? previewItems.findIndex((item) => item.url === media.url)
    : -1;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-100 bg-white p-2.5">
      <Thumbnail
        url={media.url}
        icon={Icon}
        iconSize={15}
        title={previewable ? "预览" : undefined}
        onClick={previewable && previewIndex >= 0 ? () => onPreview(previewIndex) : undefined}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-slate-700" title={media.url}>
          {media.filenameHint || "内嵌资源"}
        </div>
        <div className="mt-0.5 text-[10px] text-slate-400">{kindLabel} · 描述/评论内嵌</div>
      </div>
      {previewable && previewIndex >= 0 ? (
        <PreviewButton onClick={() => onPreview(previewIndex)} />
      ) : null}
      <OpenButton
        kind={media.kind === "image" || media.kind === "video" ? media.kind : "file"}
        targets={targetSets[media.kind === "image" || media.kind === "video" ? media.kind : "file"]}
        onSelect={(id) =>
          onSelectTarget(
            media.kind === "image" || media.kind === "video" ? media.kind : "file",
            id,
          )
        }
        onOpen={() =>
          onOpen(
            media.url,
            "file",
            media.kind === "image" || media.kind === "video" ? media.kind : "file",
          )
        }
      />
    </div>
  );
}

function mediaKindOf(
  filename: string,
  contentType: string,
  filetype: string,
): "image" | "video" | "file" {
  const type = `${contentType} ${filetype}`.toLowerCase();
  if (type.includes("image")) return "image";
  if (type.includes("video")) return "video";

  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(extension)) return "image";
  if (["mp4", "mov", "webm", "m4v", "avi"].includes(extension)) return "video";
  return "file";
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
