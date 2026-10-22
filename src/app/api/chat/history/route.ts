import { loadChat } from "@/lib/chat-store";
import { canAccessChat, getOwnerHash } from "@/lib/chat-owner";
import { getClientIp } from "@/lib/client-ip";
import { chatIdSchema, MAX_HISTORY_IDS } from "@/lib/input-limits";
import { enforceRateLimit } from "@/lib/rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const historyRequestSchema = z.object({
  ids: z.array(z.string()).max(MAX_HISTORY_IDS * 10),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = historyRequestSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "ids must be an array" },
        { status: 400 }
      );
    }

    const limited = await enforceRateLimit("history", getClientIp(req.headers));
    if (limited) return limited;

    const ownerHash = await getOwnerHash();
    const ids = [
      ...new Set(
        parsed.data.ids.filter((id) => chatIdSchema.safeParse(id).success)
      ),
    ].slice(-MAX_HISTORY_IDS);

    const results = await Promise.all(
      ids.map(async (id: string) => {
        const chat = await loadChat(id);
        if (!chat || !canAccessChat(chat, ownerHash)) {
          return null;
        } else if (chat.title) {
          return {
            id,
            title: chat.title,
            createdAt: chat.createdAt || new Date(),
          };
        } else {
          // fallback: use first user message as title
          const userMsg = chat.messages.find((msg) => msg.role === "user");
          return { id, title: userMsg?.content || id };
        }
      })
    );

    return NextResponse.json(
      results.filter(Boolean).sort((a, b) => {
        if (!b?.createdAt || !a?.createdAt) return 0;
        return (
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
      })
    );
  } catch (e) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
