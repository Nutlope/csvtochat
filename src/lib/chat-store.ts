import { randomUUID } from "crypto";
import { Message as AIMsg, generateText } from "ai";
import { redis, togetherAISDKClient } from "./clients"; // Import your redis client
import { generateTitlePrompt } from "./prompts";
import {
  endAndFlushBraintrustSpanAfterResponse,
  logBraintrustEvent,
  serializeBraintrustError,
  startBraintrustSpan,
} from "./braintrust";
const CHAT_KEY_PREFIX = "chat:";
const TITLE_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash";

// Extend the Message type to include duration for Redis persistence
export type DbMessage = AIMsg & {
  duration?: number;
  model?: string; // which model was used to generate this message
  isAutoErrorResolution?: boolean; // if true then this message is an automatic error resolution prompt
  toolCall?: {
    toolInvocation: {
      toolName: string;
      state: string;
      result?: {
        outputs?: { type: string; data: unknown }[];
      };
    };
  };
};

type ChatData = {
  messages: DbMessage[];
  csvFileUrl: string | null;
  csvHeaders: string[] | null;
  csvRows: { [key: string]: string }[] | null;
  title: string | null; // inferring the title of the chat based on csvHeaders and first user messages
  createdAt?: Date;
  ownerHash?: string;
  // ...future fields
};

export async function createChat({
  userQuestion,
  csvHeaders,
  csvRows,
  csvFileUrl,
  ownerHash,
}: {
  userQuestion: string;
  csvHeaders: string[];
  csvRows: { [key: string]: string }[];
  csvFileUrl: string;
  ownerHash: string;
}): Promise<string> {
  const id = randomUUID();

  // use userQuestion to generate a title for the chat
  const startedAt = performance.now();
  const span = startBraintrustSpan({
    name: "csvtochat.generate-title",
    type: "llm",
    event: {
      metadata: {
        model: TITLE_MODEL,
        operation: "chat-title",
        columnCount: csvHeaders.length,
        inputCharacters: userQuestion.length,
      },
    },
  });
  let title: string;

  try {
    const result = await generateText({
      model: togetherAISDKClient(TITLE_MODEL),
      prompt: generateTitlePrompt({ csvHeaders, userQuestion }),
      maxTokens: 100,
      providerOptions: { togetherai: { reasoning: { enabled: false } } },
    });
    title = result.text;

    logBraintrustEvent(span, {
      output: { titleCharacters: title.length },
      metadata: { success: true, finishReason: result.finishReason },
      metrics: {
        duration_ms: performance.now() - startedAt,
        prompt_tokens: result.usage.promptTokens,
        completion_tokens: result.usage.completionTokens,
        tokens: result.usage.totalTokens,
      },
    });
  } catch (error) {
    logBraintrustEvent(span, {
      error: serializeBraintrustError(error),
      metadata: { success: false },
      metrics: { duration_ms: performance.now() - startedAt },
    });
    throw error;
  } finally {
    endAndFlushBraintrustSpanAfterResponse(span);
  }

  const initial: ChatData = {
    messages: [],
    csvHeaders,
    csvRows,
    csvFileUrl,
    title,
    createdAt: new Date(),
    ownerHash,
  };
  await redis.set(`${CHAT_KEY_PREFIX}${id}`, JSON.stringify(initial));
  return id;
}

export async function loadChat(id: string): Promise<ChatData | null> {
  const value = await redis.get(`${CHAT_KEY_PREFIX}${id}`);
  if (!value) return null;
  try {
    return typeof value === "string" ? JSON.parse(value) : (value as ChatData);
  } catch {
    return null;
  }
}

export async function saveNewMessage({
  id,
  message,
}: {
  id: string;
  message: DbMessage;
}): Promise<void> {
  const chat = await loadChat(id);
  if (!chat) return;
  const updatedMessages = [...(chat.messages || []), message];
  await redis.set(
    `${CHAT_KEY_PREFIX}${id}`,
    JSON.stringify({
      ...chat,
      messages: updatedMessages,
    })
  );
}
