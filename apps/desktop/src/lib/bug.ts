/** Ownership helpers shared by the list and the detail panel. */

/** TAPD stores user fields as `nick;nick;` (older data may use `|` or `,`). */
export const ownerNames = (value: string | null | undefined): string[] => {
  if (!value) return [];
  return value
    .split(/[;|,，、]/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
};

/**
 * Whether the signed-in user may operate on a bug.
 *
 * Unassigned bugs (and a missing identity) stay operable so the UI never locks
 * the user out when TAPD's profile call is unavailable; a bug owned by someone
 * else requires claiming first.
 */
export const isMyBug = (
  owner: string | null | undefined,
  me: string | null | undefined,
): boolean => {
  const myName = me?.trim();
  if (!myName) return true;

  const names = ownerNames(owner);
  if (names.length === 0) return false;
  return names.includes(myName);
};

/** The first owner, for compact labels and the claim hint. */
export const primaryOwner = (owner: string | null | undefined): string =>
  ownerNames(owner)[0] ?? "";

/** TAPD titles come from testers and usually carry full-width punctuation. */
const TITLE_PUNCTUATION: Record<string, string> = {
  "【": "[",
  "】": "]",
  "「": '"',
  "」": '"',
  "『": "'",
  "』": "'",
  "（": "(",
  "）": ")",
  "《": "<",
  "》": ">",
  "，": ",",
  "。": ".",
  "：": ":",
  "；": ";",
  "、": ",",
  "？": "?",
  "！": "!",
  "—": "-",
  "～": "~",
  "％": "%",
  "　": " ",
};

/**
 * Render a bug title with ASCII punctuation so it matches the rest of the UI.
 *
 * Bracketed ranges are kept apart from the surrounding text (`[x]y` → `[x] y`,
 * `a[x]` → `a [x]`), while a bracket at the very start of the title stays flush.
 * Only the title is rewritten; descriptions, comments and exported Markdown keep
 * the original text.
 */
export const bugTitle = (value: string | null | undefined): string =>
  (value ?? "")
    .replace(/…+/g, "...")
    .replace(/[【】「」『』（）《》，。：；、？！—～％　]/g, (char) => TITLE_PUNCTUATION[char])
    .replace(/(?<=[^\s[({])(?=[[({])/gu, " ")
    .replace(/(?<=[\]})])(?=[^\s.,;:!?)\]}>])/gu, " ");
