/**
 * Sanitize errors for public responses (HTTP bridge endpoints and MCP tool
 * failures). Never expose raw error messages that may contain user content,
 * tokens, or internal details.
 */
export function publicBridgeError(error: unknown): string {
  if (!(error instanceof Error)) return "Request failed";
  if (error.name === "PolicyError") return error.message;
  const safeExact = new Set([
    "Channel not found",
    "Channel not found or not allowed",
    "Channel is not in the selected server",
    "Channel is not sendable",
    "Channel name is ambiguous; use its ID",
    "Server name is ambiguous; use its ID",
    "Server not found or not allowed",
    "Bot user not ready",
    "Discord client not initialized",
  ]);
  if (safeExact.has(error.message)) return error.message;
  if (/^Message exceeds configured \d+ character limit$/.test(error.message)) return error.message;
  return "Discord operation failed";
}
