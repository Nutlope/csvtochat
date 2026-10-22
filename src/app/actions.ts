"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { createChat as createChatRecord } from "@/lib/chat-store";
import { getOrCreateOwnerHash } from "@/lib/chat-owner";
import { getClientIp } from "@/lib/client-ip";
import {
  csvHeadersSchema,
  csvRowsSchema,
  isAllowedCsvFileUrl,
  normalizeCsvRows,
  userMessageSchema,
} from "@/lib/input-limits";
import { checkRateLimit, rateLimitErrorMessage } from "@/lib/rate-limit";

const createChatSchema = z.object({
  userQuestion: userMessageSchema,
  csvHeaders: csvHeadersSchema,
  csvRows: csvRowsSchema,
  csvFileUrl: z.string().max(2_048).refine((url) => isAllowedCsvFileUrl(url)),
});

export async function createChat(
  input: z.input<typeof createChatSchema>
): Promise<{ id: string } | { error: string }> {
  const parsed = createChatSchema.safeParse(input);
  if (!parsed.success) {
    return { error: "Invalid chat input." };
  }

  const rateLimit = await checkRateLimit(
    "createChat",
    getClientIp(await headers())
  );
  if (rateLimit !== "ok") {
    return { error: rateLimitErrorMessage(rateLimit) };
  }

  const { userQuestion, csvHeaders, csvRows, csvFileUrl } = parsed.data;

  try {
    const id = await createChatRecord({
      userQuestion,
      csvHeaders,
      csvRows: normalizeCsvRows(csvHeaders, csvRows),
      csvFileUrl,
      ownerHash: await getOrCreateOwnerHash(),
    });
    return { id };
  } catch (error) {
    console.error("Failed to create chat:", error);
    return { error: "Failed to create chat. Please try again." };
  }
}
