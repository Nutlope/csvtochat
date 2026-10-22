import { runPython } from "@/lib/coding";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";
import { DbMessage, loadChat, saveNewMessage } from "@/lib/chat-store";
import { canAccessChat, getOwnerHash } from "@/lib/chat-owner";
import { getClientIp } from "@/lib/client-ip";
import { chatIdSchema, MAX_CODE_CHARS } from "@/lib/input-limits";
import { claimOnce, enforceRateLimit } from "@/lib/rate-limit";
import { extractCodeFromText } from "@/lib/utils";

const codingRequestSchema = z.object({
  id: chatIdSchema,
  messageId: z.string().min(1).max(128),
});

// The assistant message is persisted when the LLM stream finishes, which can
// land slightly after the client receives the end of the stream.
const MESSAGE_WAIT_ATTEMPTS = 10;
const MESSAGE_WAIT_MS = 500;

async function findLatestAssistantMessage(
  id: string,
  messageId: string
): Promise<DbMessage | null> {
  for (let attempt = 0; attempt < MESSAGE_WAIT_ATTEMPTS; attempt++) {
    const chat = await loadChat(id);
    if (!chat) return null;

    const latest = chat.messages.at(-1);
    if (latest?.id === messageId) {
      return latest.role === "assistant" && !latest.toolCall ? latest : null;
    }
    if (chat.messages.some((msg) => msg.id === messageId)) return null;

    await new Promise((resolve) => setTimeout(resolve, MESSAGE_WAIT_MS));
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const parsed = codingRequestSchema.safeParse(
      await req.json().catch(() => null)
    );
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    const { id, messageId } = parsed.data;

    const limited = await enforceRateLimit("coding", getClientIp(req.headers));
    if (limited) return limited;

    const chat = await loadChat(id);
    if (!chat) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }
    if (!canAccessChat(chat, await getOwnerHash())) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const message = await findLatestAssistantMessage(id, messageId);
    const code = message ? extractCodeFromText(message.content) : null;
    if (!code) {
      return NextResponse.json(
        { error: "No code to execute for this message" },
        { status: 400 }
      );
    }
    if (code.length > MAX_CODE_CHARS) {
      return NextResponse.json({ error: "Code is too long" }, { status: 400 });
    }

    if (!(await claimOnce(`coding:${id}:${messageId}`))) {
      return NextResponse.json(
        { error: "Code for this message was already executed" },
        { status: 409 }
      );
    }

    // Start timing
    const start = Date.now();

    // Timeout logic: 60 seconds
    const TIMEOUT_MS = 60000;
    let timeoutHandle: NodeJS.Timeout | undefined = undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error("Code execution timed out after 60 seconds."));
      }, TIMEOUT_MS);
    });

    let result;
    try {
      result = await Promise.race([runPython(code), timeoutPromise]);
    } catch (err: any) {
      if (err.message && err.message.includes("timed out")) {
        return NextResponse.json(
          { error: "Code execution timed out after 60 seconds." },
          { status: 504 }
        );
      }
      throw err;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    const end = Date.now();
    const duration = (end - start) / 1000;

    if (req.signal.aborted) {
      console.log("Request aborted already from the client");
      // TODO persist on db that the code execution was aborted?
      return new Response("Request aborted", { status: 200 });
    }

    // Persist the code execution output as an assistant message in the chat history
    const toolCallMessage: DbMessage = {
      id: randomUUID(),
      role: "assistant",
      content: "Code execution complete.",
      createdAt: new Date(),
      duration,
      toolCall: {
        toolInvocation: {
          toolName: "runCode",
          // args: code, // maybe we don't save code also here cause it's already in the previous llm message
          state: "result",
          result: result,
        },
      },
    };
    await saveNewMessage({ id, message: toolCallMessage });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Code execution failed:", error);
    return NextResponse.json(
      { error: "Code execution failed." },
      { status: 500 }
    );
  }
}
