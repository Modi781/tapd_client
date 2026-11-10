import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { featureCommand } from "./feature";

export type NotificationKind = "new" | "transferred" | "reopened";
export type NotificationItemState = "pending" | "handled" | "viewed" | "ignored";
export type NotificationScope = "mine" | "project";

export type QuietHours = {
  enabled: boolean;
  start: string;
  end: string;
};

export type NotificationSettings = {
  enabled: boolean;
  scope: NotificationScope;
  includeNew: boolean;
  includeTransferred: boolean;
  includeReopened: boolean;
  pollIntervalSecs: number;
  quietHours: QuietHours;
  maxVisible: number;
};

export type NotificationItem = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  bugId: string;
  title: string;
  kind: NotificationKind;
  owner: string;
  creator: string;
  severity: string;
  priority: string;
  created: string;
  detectedAt: string;
  state: NotificationItemState;
};

export type NotificationStateSnapshot = {
  items: NotificationItem[];
  settings: NotificationSettings;
  running: boolean;
  lastPollAt: string | null;
  lastError: string | null;
};

export type IslandLayout = {
  expanded: boolean;
  width: number;
  height: number;
  count: number;
};

export type NotificationHandleResult = {
  ok: boolean;
  owner: string;
  status: string;
  assigned: boolean;
  transitioned: boolean;
};

export type NotificationAcceptPreview = {
  item: NotificationItem;
  me: string;
  currentOwner: string;
  currentStatus: string;
  assigned: boolean;
  transitioned: boolean;
  nextStatus: string;
  dscTokenPresent: boolean;
  bodies: {
    inlineUpdate: Record<string, unknown>;
    kanbanTransition: Record<string, unknown>;
    workflowTransition: Record<string, unknown>;
  };
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  scope: "mine",
  includeNew: true,
  includeTransferred: true,
  includeReopened: true,
  pollIntervalSecs: 30,
  quietHours: { enabled: false, start: "22:00", end: "09:00" },
  maxVisible: 3,
};

export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  new: "新缺陷",
  transferred: "转派给我",
  reopened: "重新打开",
};

export const notificationApi = {
  settingsGet: () =>
    featureCommand<{ settings: NotificationSettings }>("notification_settings_get"),
  settingsSet: (settings: Partial<NotificationSettings>) =>
    featureCommand<{ settings: NotificationSettings }>("notification_settings_set", settings),
  state: () => featureCommand<NotificationStateSnapshot>("notification_state_get"),
  handle: (notificationId: string) =>
    featureCommand<NotificationHandleResult>("notification_handle", { notificationId }),
  view: (notificationId: string) =>
    featureCommand<{ ok: boolean; item: NotificationItem }>("notification_view", {
      notificationId,
    }),
  ignore: (notificationId: string) =>
    featureCommand<{ ok: boolean; item: NotificationItem }>("notification_ignore", {
      notificationId,
    }),
  simulate: (payload: { title?: string; bugId?: string; kind?: NotificationKind } = {}) =>
    featureCommand<{ ok: boolean; item: NotificationItem }>("notification_simulate", payload),
  preview: (notificationId: string) =>
    featureCommand<NotificationAcceptPreview>("notification_accept_preview", { notificationId }),
  history: () => featureCommand<{ items: NotificationItem[] }>("notification_history"),
  /** Expands the island into cards (or collapses it back to the capsule). */
  expandIsland: (expanded: boolean) =>
    featureCommand<{ ok: boolean; expanded: boolean; count: number }>(
      "notification_island_expand",
      { expanded },
    ),
  openMain: () => featureCommand<{ ok: boolean }>("notification_open_main"),
  /** Starts an OS window drag; the Rust side persists the final position. */
  startDrag: () => featureCommand<{ ok: boolean }>("notification_start_drag"),
};

/** Subscribes to the pending list pushed by the Rust window manager. */
export const onNotificationShow = (
  callback: (payload: { items: NotificationItem[]; quiet: boolean }) => void,
): Promise<UnlistenFn> =>
  listen<{ items: NotificationItem[]; quiet?: boolean }>(
    "notification://show",
    (event) => {
      callback({
        items: event.payload?.items ?? [],
        quiet: Boolean(event.payload?.quiet),
      });
    },
  );

/** The island reports its own window size so the content can match it. */
export const onIslandLayout = (
  callback: (layout: IslandLayout) => void,
): Promise<UnlistenFn> =>
  listen<IslandLayout>("island://layout", (event) => callback(event.payload));

export const pendingItems = (items: NotificationItem[]): NotificationItem[] =>
  items.filter((item) => item.state === "pending");

/** "2026-11-10 09:30:00" -> "11-10 09:30". */
export const formatNotificationTime = (raw: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(raw.trim());
  if (!match) return raw;
  const [, , month, day, hour, minute] = match;
  return `${month}-${day} ${hour}:${minute}`;
};

export const formatPollTime = (iso: string | null): string => {
  if (!iso) return "尚未轮询";
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return iso;
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
};
