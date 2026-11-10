import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type AppPaths = {
  dataDir: string;
  logsDir: string;
  capturesDir: string;
  exportsDir: string;
  runtimeFile: string;
  configFile: string;
};

export type AppInfo = {
  version: string;
  paths: AppPaths;
  loggedIn: boolean;
  me: string | null;
  lastWorkspaceId: string | null;
  pollIntervalSecs: number;
  runtimePort: number | null;
  /** Port and capability of the local media proxy (images/videos). */
  mediaPort: number | null;
  mediaToken: string | null;
  sessionUrl: string | null;
};

export type SessionStatus = {
  exists: boolean;
  visible: boolean;
  url: string | null;
  loggedIn: boolean;
};

export type CapturedRequest = {
  id: number;
  ts: string;
  method: string;
  url: string;
  status: number | null;
  contentType: string | null;
  requestBody: string | null;
  responseBody: string | null;
  size: number | null;
  durationMs: number | null;
  error: string | null;
  truncated: boolean;
};

export type BridgePing = {
  url: string;
  title: string;
  readyState: string;
  hasInvoke: boolean;
  hasCapture: boolean;
  captureCount: number;
  cookieLength: number;
  userAgent: string;
};

export type UserProfile = {
  nick: string;
  userId: string;
  company: string;
};

export type Workspace = {
  id: string;
  name: string;
  prettyName: string;
  category: string;
  status: string;
  logoColor: string | null;
  lastVisitedTime: string | null;
  jumpUrl: string | null;
};

export type WorkspaceContext = {
  user: UserProfile;
  workspaces: Workspace[];
};

export type BugQuery = {
  workspaceId: string;
  owner: string | null;
  statuses: string[];
  priorities: string[];
  severities: string[];
  keyword: string | null;
  modifiedAfter: string | null;
  createdAfter: string | null;
  sortName: string;
  order: string;
  page: number;
  perpage: number;
  confId: string | null;
};

export type BugSummary = {
  id: string;
  shortId: string;
  workspaceId: string;
  title: string;
  status: string;
  statusLabel: string;
  priority: string;
  priorityLabel: string;
  severity: string;
  severityLabel: string;
  owner: string;
  creator: string;
  created: string;
  modified: string;
  due: string;
  iterationId: string;
  iterationName: string;
  module: string;
  versionReport: string;
  storyId: string;
  storyName: string;
  bugUrl: string;
};

export type BugListPage = {
  page: number;
  perpage: number;
  total: number;
  statusMap: Record<string, string>;
  bugs: BugSummary[];
};

export type Comment = {
  id: string;
  author: string;
  created: string;
  descriptionHtml: string;
  plainText: string;
  isDeleted: boolean;
  replies: Comment[];
};

export type Attachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  filetype: string;
  owner: string;
  created: string;
  entryId: string;
  videoPoster: string;
  videoOriginFile: string;
  downloadUrl: string;
};

export type MediaKind = "image" | "video" | "file";

/** Image/video embedded in the rich-text description or a comment. */
export type MediaRef = {
  url: string;
  kind: MediaKind;
  filenameHint: string;
};

export type ChangeField = {
  field: string;
  before: string;
  after: string;
};

export type ChangeEntry = {
  seq: number;
  time: string;
  author: string;
  kind: string;
  fields: ChangeField[];
};

export type ChangeHistory = {
  total: number;
  changes: ChangeEntry[];
  error: string | null;
};

export type BugDetail = BugSummary & {
  descriptionHtml: string;
  descriptionText: string;
  platform: string;
  os: string;
  testtype: string;
  testphase: string;
  source: string;
  resolution: string;
  resolved: string;
  closed: string;
  reopenTime: string;
  fixer: string;
  de: string;
  te: string;
  participants: string;
  cc: string;
  follower: string;
  releaseName: string;
  workspaceName: string;
  customFields: Record<string, string>;
  comments: Comment[];
  attachments: Attachment[];
  embeddedMedia: MediaRef[];
  changes: ChangeHistory;
};

export type McpConfigInfo = {
  commandPath: string;
  snippet: string;
  transport: string;
  readOnly: boolean;
  tools: string[];
  port: number | null;
  /** opencode global config path, when discoverable. */
  configPath: string | null;
  /** Whether the opencode config already registers tapd-mcp. */
  imported: boolean;
};

export type OpenMediaMode = "file" | "browser" | "reveal" | "path";

export type DirEntryInfo = { name: string; path: string };

/** One folder level for the folder picker. */
export type DirListing = {
  path: string;
  parent: string | null;
  entries: DirEntryInfo[];
};

/** One selectable "open with" app. `icon` is a data URL when available. */
export type OpenTarget = {
  id: string;
  label: string;
  icon: string | null;
};

export type OpenTargetSet = {
  kind: string;
  selected: string;
  targets: OpenTarget[];
};

export type ExportResult = {
  dir: string;
  markdownPath: string;
  assetCount: number;
  downloadedBytes: number;
  warnings: string[];
};

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  sessionStatus: () => invoke<SessionStatus>("session_status"),
  sessionShow: () => invoke<void>("session_show"),
  sessionHide: () => invoke<void>("session_hide"),
  markLoggedIn: (nick?: string) =>
    invoke<void>("session_mark_logged_in", { nick: nick ?? null }),
  logout: () => invoke<void>("session_logout"),
  ping: () => invoke<BridgePing>("session_ping"),
  captures: () => invoke<CapturedRequest[]>("capture_snapshot"),
  clearCaptures: () => invoke<void>("capture_clear"),
  exportCaptures: () => invoke<string>("capture_export"),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  listDirs: (path?: string) => invoke<DirListing>("list_dirs", { path: path ?? null }),
  openMedia: (url: string, mode: OpenMediaMode, kind?: string, target?: string) =>
    invoke<string>("open_media", {
      url,
      mode,
      kind: kind ?? null,
      target: target ?? null,
    }),
  openTargets: (kind: string) => invoke<OpenTargetSet>("open_targets", { kind }),
  setOpenTarget: (kind: string, id: string) =>
    invoke<void>("set_open_target", { kind, id }),
  workspaceContext: () => invoke<WorkspaceContext>("workspace_context"),
  bugList: (query: BugQuery) => invoke<BugListPage>("bug_list", { query }),
  bugDetail: (workspaceId: string, bugId: string) =>
    invoke<BugDetail>("bug_detail", { workspaceId, bugId }),
  exportBugMd: (workspaceId: string, bugId: string, workspaceName: string | null) =>
    invoke<ExportResult>("export_bug_md", { workspaceId, bugId, workspaceName }),
  setCurrentUser: (nick: string) =>
    invoke<void>("set_current_user", { nick }),
  setLastWorkspace: (workspaceId: string) =>
    invoke<void>("set_last_workspace", { workspaceId }),
  mcpConfig: () => invoke<McpConfigInfo>("mcp_config"),
};

export const onSessionChanged = (callback: () => void): Promise<UnlistenFn> =>
  listen("session://changed", () => callback());

export const onSessionUrl = (
  callback: (url: string) => void,
): Promise<UnlistenFn> =>
  listen<string>("session://url", (event) => callback(event.payload));

let mediaBase: string | null = null;

const buildMediaBase = (port: number, token: string): string =>
  `http://127.0.0.1:${port}/media?token=${encodeURIComponent(token)}&url=`;

/** Remembers the media proxy base URL once `app_info` has been loaded. */
export const setMediaEndpoint = (
  info: Pick<AppInfo, "mediaPort" | "mediaToken">,
): void => {
  mediaBase =
    info.mediaPort && info.mediaToken
      ? buildMediaBase(info.mediaPort, info.mediaToken)
      : null;
};

/**
 * Fetches the media proxy endpoint on demand. `app_info` can be read before the
 * loopback server has written its runtime info, which would leave every
 * thumbnail/preview without a URL.
 */
export const ensureMediaEndpoint = async (): Promise<void> => {
  if (mediaBase) return;
  try {
    const endpoint = await invoke<{ port: number; token: string }>("media_endpoint");
    mediaBase = buildMediaBase(endpoint.port, endpoint.token);
  } catch {
    // The server is still starting; the next open will retry.
  }
};

/**
 * Local proxy URL for a TAPD resource. The main window has no tapd.cn cookies,
 * so images/videos are served by the app's loopback media proxy.
 */
export const mediaSrc = (url: string): string | undefined =>
  mediaBase ? `${mediaBase}${encodeURIComponent(url)}` : undefined;

export const formatBytes = (bytes: number | null | undefined): string => {
  if (!bytes || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

export const relativeTime = (iso: string): string => {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return iso;
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return `${Math.max(1, Math.round(delta / 1000))} 秒前`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)} 小时前`;
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
};
