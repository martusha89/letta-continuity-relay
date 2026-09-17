import express from "express";
import type { NextFunction, Request, Response } from "express";
import { bearerMatches, fixedWindowRateLimit } from "../http-security.js";
import { publicBridgeError } from "../public-error.js";
import type { BridgeConfig } from "../config.js";
import type { BridgeEventQueue } from "./queue.js";
import type { BridgeSendAction } from "./types.js";

export interface BridgeSendHandlers {
  send: (action: Extract<BridgeSendAction, { kind: "send" }>) => Promise<{ messageId: string; channelId: string }>;
  react: (action: Extract<BridgeSendAction, { kind: "react" }>) => Promise<void>;
  typing: (action: Extract<BridgeSendAction, { kind: "typing" }>) => Promise<void>;
}

export interface BridgeRouterOptions {
  bridge: BridgeConfig;
  queue: BridgeEventQueue;
  sendHandlers: BridgeSendHandlers;
  log?: (scope: string) => void;
}

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Authenticated bridge endpoints, separate from /mcp:
 *   GET  /bridge/events?after=<seq>&wait=1  — long-poll events
 *   POST /bridge/ack                         — acknowledge up to a sequence
 *   POST /bridge/send                         — MessageChannel actions (send/react)
 *
 * Auth uses a DEDICATED bearer token (never the MCP token). No CORS headers
 * are emitted: the listener is a non-browser client. Errors are sanitized and
 * never include body text, tokens, user content, or secrets.
 */
export function createBridgeRouter(options: BridgeRouterOptions): express.Router {
  const { bridge, queue, sendHandlers } = options;
  const log = options.log ?? (() => {});
  const router = express.Router();

  // Exact bearer auth with the dedicated bridge token.
  router.use((req: Request, res: Response, next: NextFunction): void => {
    if (!bearerMatches(req.get("authorization"), bridge.bearerToken!)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });

  // Dedicated rate limit for bridge endpoints (long polls hold a request but
  // only count once per poll).
  router.use(fixedWindowRateLimit(bridge.rateLimitPerMinute));

  // JSON body parsing with an explicit limit; only for POST endpoints.
  router.use((req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "POST") return next();
    if (!req.is(["application/json", "application/*+json"])) {
      res.status(415).json({ error: "unsupported_media_type" });
      return;
    }
    next();
  });
  router.use(express.json({ limit: bridge.jsonLimitBytes, strict: true, type: ["application/json", "application/*+json"] }));

  router.get("/events", async (req: Request, res: Response): Promise<void> => {
    const afterRaw = typeof req.query.after === "string" ? req.query.after : "0";
    if (!/^\d+$/.test(afterRaw)) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const after = Number(afterRaw);
    // The service owns an in-memory queue. If it restarts while the listener
    // retains an older cursor, sequence numbers rewind. Reset the cursor
    // explicitly instead of trapping the listener in a permanent 400 loop.
    const reset = after > queue.lastSeq;
    const effectiveAfter = reset ? 0 : after;
    const wait = req.query.wait === "1" || req.query.wait === "true";
    let events: Awaited<ReturnType<BridgeEventQueue["waitSince"]>>;
    try {
      events = wait
        ? await queue.waitSince(effectiveAfter, bridge.pollTimeoutMs)
        : queue.since(effectiveAfter);
    } catch {
      log("bridge events poll failed");
      res.status(500).json({ error: "internal_error" });
      return;
    }
    res.status(200).json({ events, lastSeq: queue.lastSeq, dropped: queue.dropped, reset });
  });

  router.post("/ack", (req: Request, res: Response): void => {
    const body = req.body;
    if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const seq = (body as { seq?: unknown }).seq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq > queue.lastSeq) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const removed = queue.ack(seq);
    res.status(200).json({ acked: seq, removed, lastSeq: queue.lastSeq, size: queue.size });
  });

  router.post("/send", async (req: Request, res: Response): Promise<void> => {
    const body = req.body;
    if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const action = parseSendAction(body as Record<string, unknown>);
    if (!action) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      if (action.kind === "send") {
        const result = await sendHandlers.send(action);
        res.status(200).json({ ok: true, kind: "send", messageId: result.messageId, channelId: result.channelId });
      } else if (action.kind === "react") {
        await sendHandlers.react(action);
        res.status(200).json({ ok: true, kind: "react" });
      } else {
        await sendHandlers.typing(action);
        res.status(200).json({ ok: true, kind: "typing" });
      }
    } catch (error) {
      const message = publicBridgeError(error);
      log(`bridge send rejected: ${message}`);
      res.status(422).json({ error: "send_failed", message });
    }
  });

  router.use((_req: Request, res: Response): void => {
    res.status(404).json({ error: "not_found" });
  });

  return router;
}

/**
 * Validate a /bridge/send body. Only `send` and `react` are supported; the
 * listener can extend this later. Upload-file is intentionally omitted until
 * it can be done safely with existing source restrictions.
 */
export function parseSendAction(body: Record<string, unknown>): BridgeSendAction | null {
  const kind = body.kind;
  if (kind === "send") {
    const channel = body.channel;
    const text = body.text;
    if (typeof channel !== "string" || !SNOWFLAKE.test(channel)) return null;
    if (typeof text !== "string" || text.length === 0) return null;
    const replyToMessageId = body.replyToMessageId;
    if (replyToMessageId !== undefined && (typeof replyToMessageId !== "string" || !SNOWFLAKE.test(replyToMessageId))) return null;
    return replyToMessageId !== undefined
      ? { kind: "send", channel, text, replyToMessageId }
      : { kind: "send", channel, text };
  }
  if (kind === "react") {
    const channel = body.channel;
    const messageId = body.messageId;
    const emoji = body.emoji;
    if (typeof channel !== "string" || !SNOWFLAKE.test(channel)) return null;
    if (typeof messageId !== "string" || !SNOWFLAKE.test(messageId)) return null;
    if (typeof emoji !== "string" || emoji.length === 0 || emoji.length > 64) return null;
    return { kind: "react", channel, messageId, emoji };
  }
  if (kind === "typing") {
    const channel = body.channel;
    if (typeof channel !== "string" || !SNOWFLAKE.test(channel)) return null;
    return { kind: "typing", channel };
  }
  return null;
}
