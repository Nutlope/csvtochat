import { Ratelimit, type Duration } from "@upstash/ratelimit";
import { redis } from "@/lib/clients";

type RateLimitRule = { limit: number; window: Duration };

// Per-IP limits for every paid or write entry point. All of them fail closed.
export const RATE_LIMITS = {
  // POST /api/chat (all requests, including automatic error resolution).
  // The 50/day user quota lives in lib/limits.ts.
  chat: [{ limit: 10, window: "1 m" }],
  // Automatic error resolution requests skip the user quota but not this one.
  autoFix: [{ limit: 100, window: "1 d" }],
  // POST /api/coding (paid Code Interpreter)
  coding: [
    { limit: 10, window: "1 m" },
    { limit: 150, window: "1 d" },
  ],
  // createChat server action (paid title generation)
  createChat: [
    { limit: 5, window: "1 m" },
    { limit: 50, window: "1 d" },
  ],
  // POST /api/generate-questions (paid)
  generateQuestions: [
    { limit: 10, window: "1 m" },
    { limit: 60, window: "1 d" },
  ],
  // POST /api/s3-upload
  upload: [
    { limit: 5, window: "1 m" },
    { limit: 50, window: "1 d" },
  ],
  // POST /api/chat/history
  history: [{ limit: 30, window: "1 m" }],
} satisfies Record<string, RateLimitRule[]>;

export type RateLimitBucket = keyof typeof RATE_LIMITS;

export const RATE_LIMITED_MESSAGE =
  "Too many requests. Please wait a few minutes and try again.";
export const RATE_LIMIT_UNAVAILABLE_MESSAGE =
  "Service temporarily unavailable. Please try again shortly.";

const limiters = new Map<string, Ratelimit>();

function getLimiter(bucket: RateLimitBucket, rule: RateLimitRule) {
  const prefix = `ratelimit:${bucket}:${rule.window.replace(/\s/g, "")}`;
  let limiter = limiters.get(prefix);
  if (!limiter) {
    limiter = new Ratelimit({
      redis,
      prefix,
      limiter: Ratelimit.fixedWindow(rule.limit, rule.window),
    });
    limiters.set(prefix, limiter);
  }
  return limiter;
}

export type RateLimitResult = "ok" | "limited" | "unavailable";

export async function checkRateLimit(
  bucket: RateLimitBucket,
  clientKey: string
): Promise<RateLimitResult> {
  try {
    for (const rule of RATE_LIMITS[bucket]) {
      const result = await getLimiter(bucket, rule).limit(clientKey);
      if (result.reason === "timeout") return "unavailable";
      if (!result.success) return "limited";
    }
    return "ok";
  } catch (error) {
    console.error(`Rate limiter unavailable for ${bucket}:`, error);
    return "unavailable";
  }
}

export function rateLimitErrorMessage(
  result: Exclude<RateLimitResult, "ok">
) {
  return result === "limited"
    ? RATE_LIMITED_MESSAGE
    : RATE_LIMIT_UNAVAILABLE_MESSAGE;
}

export function rateLimitErrorResponse(
  result: Exclude<RateLimitResult, "ok">
) {
  return Response.json(
    { error: rateLimitErrorMessage(result) },
    { status: result === "limited" ? 429 : 503 }
  );
}

// Returns an error response when the request must be rejected, otherwise null.
export async function enforceRateLimit(
  bucket: RateLimitBucket,
  clientKey: string
): Promise<Response | null> {
  const result = await checkRateLimit(bucket, clientKey);
  return result === "ok" ? null : rateLimitErrorResponse(result);
}

// One-shot claims (e.g. "execute this message's code once"). Fails closed: a
// store error is treated as "already claimed".
export async function claimOnce(
  key: string,
  ttlSeconds = 60 * 60 * 24 * 30
): Promise<boolean> {
  try {
    const result = await redis.set(`claim:${key}`, "1", {
      nx: true,
      ex: ttlSeconds,
    });
    return result === "OK";
  } catch (error) {
    console.error("Claim failed:", error);
    return false;
  }
}
