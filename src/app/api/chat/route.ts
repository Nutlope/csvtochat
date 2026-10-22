import { togetherAISDKClient } from "@/lib/clients";
import {
  streamText,
  generateId,
  CoreMessage,
  appendResponseMessages,
  wrapLanguageModel,
  extractReasoningMiddleware,
} from "ai";
import { z } from "zod";
import { DbMessage, loadChat, saveNewMessage } from "@/lib/chat-store";
import { canAccessChat, getOwnerHash } from "@/lib/chat-owner";
import { getClientIp } from "@/lib/client-ip";
import {
  chatIdSchema,
  MAX_AUTO_FIXES_IN_A_ROW,
  MAX_CHAT_MESSAGES,
  MAX_ERROR_CHARS,
  userMessageSchema,
} from "@/lib/input-limits";
import { limitMessages } from "@/lib/limits";
import { checkRateLimit, claimOnce, rateLimitErrorMessage } from "@/lib/rate-limit";
import { generateCodePrompt } from "@/lib/prompts";
import { CHAT_MODELS } from "@/lib/models";
import {
  endAndFlushBraintrustSpanAfterResponse,
  logBraintrustEvent,
  serializeBraintrustError,
  startBraintrustSpan,
} from "@/lib/braintrust";

const chatRequestSchema = z.object({
  id: chatIdSchema,
  message: z.string(),
  model: z.string().max(100).optional(),
});

// Builds the automatic error resolution prompt from the stored result of the
// last code execution, or returns null when the chat doesn't end in one.
function getAutoFixPrompt(messages: DbMessage[]): string | null {
  const last = messages.at(-1);
  if (
    last?.role !== "assistant" ||
    last.toolCall?.toolInvocation.toolName !== "runCode"
  ) {
    return null;
  }

  const errorOutput = last.toolCall.toolInvocation.result?.outputs?.find(
    (output) => output.type === "error" || output.type === "stderr"
  );
  if (!errorOutput) return null;

  let autoFixesInARow = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    if (!messages[i].isAutoErrorResolution) break;
    autoFixesInARow++;
  }
  if (autoFixesInARow >= MAX_AUTO_FIXES_IN_A_ROW) return null;

  const errorMessage =
    typeof errorOutput.data === "string" && errorOutput.data
      ? errorOutput.data.slice(0, MAX_ERROR_CHARS)
      : "Unknown error";
  return `The following error occurred when running the code you provided: ${errorMessage}. Please try to fix the code and try again.`;
}

export async function POST(req: Request) {
  const parsed = chatRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return new Response("Invalid request.", { status: 400 });
  }
  const { id, model } = parsed.data;

  const ip = getClientIp(req.headers);
  const burstLimit = await checkRateLimit("chat", ip);
  if (burstLimit !== "ok") {
    return new Response(rateLimitErrorMessage(burstLimit), {
      status: burstLimit === "limited" ? 429 : 503,
    });
  }

  const chat = await loadChat(id);
  if (!chat) {
    return new Response("Chat not found.", { status: 404 });
  }
  if (!canAccessChat(chat, await getOwnerHash())) {
    return new Response("Forbidden.", { status: 403 });
  }
  if (chat.messages.length >= MAX_CHAT_MESSAGES) {
    return new Response(
      "This chat has reached its message limit. Please start a new chat.",
      { status: 400 }
    );
  }

  let autoFixPrompt =
    req.headers.get("X-Auto-Error-Resolved") === "true"
      ? getAutoFixPrompt(chat.messages)
      : null;
  if (
    autoFixPrompt &&
    !(await claimOnce(`autofix:${id}:${chat.messages.at(-1)?.id}`))
  ) {
    autoFixPrompt = null;
  }

  let message: string;
  if (autoFixPrompt) {
    const autoFixLimit = await checkRateLimit("autoFix", ip);
    if (autoFixLimit !== "ok") {
      return new Response(rateLimitErrorMessage(autoFixLimit), {
        status: autoFixLimit === "limited" ? 429 : 503,
      });
    }
    message = autoFixPrompt;
  } else {
    const userMessage = userMessageSchema.safeParse(parsed.data.message);
    if (!userMessage.success) {
      return new Response("Invalid message.", { status: 400 });
    }
    message = userMessage.data;

    try {
      await limitMessages(ip);
    } catch (err) {
      return new Response("Too many messages. Daily limit reached.", {
        status: 429,
      });
    }
  }

  const newUserMessage: DbMessage = {
    id: generateId(),
    role: "user",
    content: message,
    createdAt: new Date(),
    isAutoErrorResolution: autoFixPrompt !== null,
  };

  // Save the new user message
  await saveNewMessage({ id, message: newUserMessage });

  const messagesToSave: DbMessage[] = [
    ...(chat?.messages || []),
    newUserMessage,
  ];

  const coreMessagesForStream = messagesToSave
    .filter((msg) => msg.role === "user" || msg.role === "assistant")
    .map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

  // Start timing
  const start = Date.now();

  // Determine which model to use

  const defaultModel = CHAT_MODELS.find((m) => m.isDefault)?.model;

  const selectedModelSlug = typeof model === "string" ? model : undefined;

  const selectedModel =
    (selectedModelSlug &&
      CHAT_MODELS.find((m) => m.slug === selectedModelSlug)?.model) ||
    defaultModel;

  if (!selectedModel) {
    throw new Error("Invalid model selected.");
  }

  const span = startBraintrustSpan({
    name: "csvtochat.chat",
    type: "llm",
    event: {
      metadata: {
        model: selectedModel,
        route: "/api/chat",
        messageCount: coreMessagesForStream.length,
        inputCharacters: typeof message === "string" ? message.length : 0,
        columnCount: chat?.csvHeaders?.length ?? 0,
        rowCount: chat?.csvRows?.length ?? 0,
      },
    },
  });
  let traceEnded = false;
  const finishTrace = (
    event: Parameters<typeof logBraintrustEvent>[1],
  ) => {
    if (traceEnded) return;
    traceEnded = true;
    req.signal.removeEventListener("abort", handleAbort);
    logBraintrustEvent(span, event);
    endAndFlushBraintrustSpanAfterResponse(span);
  };
  const handleAbort = () => {
    finishTrace({
      metadata: { success: false, aborted: true },
      metrics: { duration_ms: Date.now() - start },
    });
  };
  req.signal.addEventListener("abort", handleAbort, { once: true });

  try {
    // Create a new model instance based on selectedModel
    const modelInstance = wrapLanguageModel({
      model: togetherAISDKClient(selectedModel),
      middleware: extractReasoningMiddleware({ tagName: "think" }),
    });

    // TODO: handling context length here cause coreMessagesForStream could be too long for the currently selected model?

    const stream = streamText({
      model: modelInstance,
      system: generateCodePrompt({
        csvFileUrl: chat?.csvFileUrl || "",
        csvHeaders: chat?.csvHeaders || [],
        csvRows: chat?.csvRows || [],
      }),
      messages: coreMessagesForStream.filter(
        (msg) => msg.role !== "system"
      ) as CoreMessage[],
      onError: ({ error }) => {
        finishTrace({
          error: serializeBraintrustError(error),
          metadata: { success: false, phase: "stream" },
          metrics: { duration_ms: Date.now() - start },
        });
        console.error("Error:", error);
      },
      async onFinish({ response, text, finishReason, usage }) {
        // End timing
        const end = Date.now();
        const duration = (end - start) / 1000;

        try {
          if (response.messages.length === 1) {
            const responseMessages = appendResponseMessages({
              messages: messagesToSave,
              responseMessages: response.messages,
            });

            const responseMessage = responseMessages.at(-1);

            if (responseMessage) {
              await saveNewMessage({
                id,
                message: {
                  ...responseMessage,
                  duration,
                  model: selectedModel,
                },
              });
            }
          }

          finishTrace({
            output: { outputCharacters: text.length },
            metadata: { success: true, finishReason },
            metrics: {
              duration_ms: end - start,
              prompt_tokens: usage.promptTokens,
              completion_tokens: usage.completionTokens,
              tokens: usage.totalTokens,
            },
          });
        } catch (error) {
          finishTrace({
            error: serializeBraintrustError(error),
            metadata: { success: false, phase: "persistence" },
            metrics: { duration_ms: Date.now() - start },
          });
          throw error;
        }
      },
    });

    return stream.toDataStreamResponse({
      sendReasoning: true,
    });
  } catch (err) {
    finishTrace({
      error: serializeBraintrustError(err),
      metadata: { success: false, phase: "request" },
      metrics: { duration_ms: Date.now() - start },
    });
    console.error(err);
    return new Response("Error generating response", { status: 500 });
  }
}
