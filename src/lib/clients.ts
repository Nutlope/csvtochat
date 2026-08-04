import Together from "together-ai";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { Redis } from "@upstash/redis";

export const togetherClient = new Together({
  apiKey: process.env.TOGETHER_API_KEY,
});

export const togetherAISDKClient = createTogetherAI({
  apiKey: process.env.TOGETHER_API_KEY,
});

export const codeInterpreter = togetherClient.codeInterpreter;

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});
