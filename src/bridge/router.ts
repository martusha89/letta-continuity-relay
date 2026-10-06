import express from "express";
import type { NextFunction, Request, Response } from "express";
import { bearerMatches, fixedWindowRateLimit } from "../http-security.js";
import { publicBridgeError } from "../public-error.js";
import { normalizeDestinationAlias, type BridgeConfig } from "../config.js";
import type { BridgeEventQueue } from "./queue.js";
import type { BridgeSendAction } from "./types.js";
import { PROACTIVE_RAW_ROUTE_KEYS } from "./types.js";

export interface BridgeSendHandlers {
  send: (action: Extract<BridgeSendAction, { kind: "send" }>) => Promise<{ messageId: string; channelId: string }>;
  sendDm: (action: Extract<BridgeSendAction, { kind: "send_dm" }>) => Promise<{ messageId: string; channelId: string }>;
  proactiveSend: (action: Extract<BridgeSendAction, { kind: "proactive_send" }>) => Promise<{ messageId: string; channelId: string; destination: string; requestId: string }>;
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

  // Long polls and outbound actions use separate counters. A pending event can
  // make /events return immediately, and those polls must never consume the
  // allowance needed for the eventual ACK or an intentional outbound send.
  const eventRateLimit = fixedWindowRateLimit(bridge.rateLimitPerMinute);
  const actionRateLimit = fixedWindowRateLimit(bridge.rateLimitPerMinute);

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

  router.get("/events", eventRateLimit, async (req: Request, res: Response): Promise<void> => {
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

  router.post("/ack", actionRateLimit, (req: Request, res: Response): void => {
    const body = req.body;
    if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const seq = (body as { seq?: unknown }).seq;
    const exact = (body as { exact?: unknown }).exact;
    const messageId = (body as { messageId?: unknown }).messageId;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq > queue.lastSeq) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    if (exact !== undefined && typeof exact !== "boolean") {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    if (exact === true && (typeof messageId !== "string" || messageId.length === 0)) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const removed = exact ? queue.ackOne(seq, messageId as string) : queue.ack(seq);
    if (exact === true && removed !== 1) {
      res.status(409).json({
        error: "ack_conflict",
        acked: seq,
        exact: true,
        messageId,
        removed,
        lastSeq: queue.lastSeq,
        size: queue.size,
      });
      return;
    }
    res.status(200).json({
      acked: seq,
      exact: exact === true,
      ...(exact === true ? { messageId } : {}),
      removed,
      lastSeq: queue.lastSeq,
      size: queue.size,
    });
  });

  router.post("/send", actionRateLimit, async (req: Request, res: Response): Promise<void> => {
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
      if (action.kind === "send" || action.kind === "send_dm") {
        const result = action.kind === "send"
          ? await sendHandlers.send(action)
          : await sendHandlers.sendDm(action);
        res.status(200).json({ ok: true, kind: action.kind, messageId: result.messageId, channelId: result.channelId });
      } else if (action.kind === "proactive_send") {
        const result = await sendHandlers.proactiveSend(action);
        res.status(200).json({
          ok: true,
          kind: "proactive_send",
          requestId: result.requestId,
          destination: result.destination,
          messageId: result.messageId,
        });
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
 * Validate a /bridge/send body. `send`, `send_dm`, `react`, and `typing` take
 * exact snowflakes; `proactive_send` takes only named aliases and strictly
 * rejects raw-route keys. Upload-file is intentionally omitted until it can be
 * done safely with existing source restrictions.
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
  if (kind === "send_dm") {
    const userId = body.userId;
    const text = body.text;
    if (typeof userId !== "string" || !SNOWFLAKE.test(userId)) return null;
    if (typeof text !== "string" || text.length === 0) return null;
    const replyToMessageId = body.replyToMessageId;
    if (replyToMessageId !== undefined && (typeof replyToMessageId !== "string" || !SNOWFLAKE.test(replyToMessageId))) return null;
    return replyToMessageId !== undefined
      ? { kind: "send_dm", userId, text, replyToMessageId }
      : { kind: "send_dm", userId, text };
  }
  if (kind === "proactive_send") {
    const destination = body.destination;
    const text = body.text;
    const requestId = body.requestId;
    if (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) return null;
    if (typeof destination !== "string") return null;
    const normalizedDestination = normalizeDestinationAlias(destination);
    if (!normalizedDestination) return null;
    if (typeof text !== "string" || text.length === 0) return null;
    const allowedKeys = new Set(["kind", "requestId", "destination", "text", "mentions"]);
    if (Object.keys(body).some(key => !allowedKeys.has(key))) return null;
    // Strictly reject raw-route keys: proactive sends may never carry raw
    // channel/user/role IDs, reply targets, or mention overrides.
    for (const key of PROACTIVE_RAW_ROUTE_KEYS) {
      if (body[key] !== undefined) return null;
    }
    const mentions = body.mentions;
    if (mentions !== undefined) {
      if (!Array.isArray(mentions) || mentions.some(m => typeof m !== "string" || m.length === 0)) return null;
      const normalized = mentions.map(m => normalizeDestinationAlias(m));
      if (normalized.some(m => !m)) return null;
      if (new Set(normalized).size !== normalized.length) return null;
      return { kind: "proactive_send", requestId, destination: normalizedDestination, text, mentions: normalized as string[] };
    }
    return { kind: "proactive_send", requestId, destination: normalizedDestination, text };
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
