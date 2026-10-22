import { Ratelimit } from "@upstash/ratelimit";
import { redis } from "@/lib/clients";

// 50 messages per day
const ratelimit = new Ratelimit({
  redis: redis,
  limiter: Ratelimit.fixedWindow(50, "1 d"),
  analytics: true,
});

export const getRemainingMessages = async (userFingerPrint: string) => {
  const result = await ratelimit.getRemaining(userFingerPrint);
  return {
    remaining: result.remaining,
    reset: result.reset,
  };
};

export const limitMessages = async (userFingerPrint: string) => {
  const result = await ratelimit.limit(userFingerPrint);

  if (!result.success || result.reason === "timeout") {
    throw new Error("Too many messages");
  }

  return result;
};
