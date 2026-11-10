/**
 * ANSI/VT escape stripping for log rendering. The raw log file keeps the exact
 * PTY bytes; this is only applied when showing it as text.
 */
const ANSI_ESCAPE =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(input: string): string {
  return input
    .replace(ANSI_ESCAPE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}
