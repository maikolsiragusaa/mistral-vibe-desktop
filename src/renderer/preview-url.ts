/** Local web-preview URL allowlist.
 *
 * Only loopback HTTP origins the user explicitly approves can be framed.
 * Framing additionally uses sandbox="allow-scripts" without
 * allow-same-origin, so framed content never reaches the preload or IPC.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function previewUrlProblem(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "Enter a local URL to preview.";
  if (value.length > 2048) return "This URL is too long.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter a complete URL such as http://localhost:3000/.";
  }
  if (url.protocol !== "http:") return "Only http:// loopback origins can be previewed.";
  if (url.username || url.password) return "URLs with credentials cannot be previewed.";
  // Node keeps IPv6 brackets in hostname ("[::1]"); strip them to compare.
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (!LOOPBACK_HOSTS.has(host))
    return "Only localhost, 127.0.0.1 or ::1 can be previewed.";
  return null;
}

export function isAllowedPreviewUrl(raw: string): boolean {
  return previewUrlProblem(raw) === null;
}
