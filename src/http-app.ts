import express from "express";
import type { NextFunction, Request, Response, Router } from "express";
import { fixedWindowRateLimit, httpSecurity } from "./http-security.js";

export interface HttpAppOptions {
  allowedOrigins: readonly string[];
  bearerToken: string;
  jsonLimitBytes: number;
  rateLimitPerMinute: number;
  isReady: () => boolean;
  handleMcpPost: (req: Request, res: Response) => Promise<void>;
  /** Optional authenticated bridge router (mounted at /bridge). */
  bridgeRouter?: Router;
  logError?: (scope: "mcp" | "http" | "bridge") => void;
}

export function createHttpApp(options: HttpAppOptions): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/ready", (_req, res) => options.isReady()
    ? res.status(200).json({ status: "ready" })
    : res.status(503).json({ status: "not_ready" }));
  app.use("/mcp", httpSecurity(options.allowedOrigins, options.bearerToken));
  app.use("/mcp", fixedWindowRateLimit(options.rateLimitPerMinute));
  app.use("/mcp", (req, res, next) => {
    if (req.method === "POST" && !req.is(["application/json", "application/*+json"])) {
      return res.status(415).json({ error: "unsupported_media_type" });
    }
    return next();
  });
  app.use("/mcp", express.json({
    limit: options.jsonLimitBytes,
    strict: true,
    type: ["application/json", "application/*+json"],
  }));
  app.post("/mcp", async (req, res) => {
    if (req.body === undefined || req.body === null || typeof req.body !== "object" || Array.isArray(req.body)) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    try {
      await options.handleMcpPost(req, res);
    } catch {
      options.logError?.("mcp");
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });
  app.all("/mcp", (_req, res) => res.status(405).json({ error: "method_not_allowed" }));
  if (options.bridgeRouter) {
    app.use("/bridge", options.bridgeRouter);
  }
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    options.logError?.("http");
    if (res.headersSent) return next(error);
    return res.status(400).json({ error: "invalid_request" });
  });
  return app;
}
