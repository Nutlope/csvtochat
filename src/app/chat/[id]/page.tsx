import { loadChat } from "@/lib/chat-store";
import { canAccessChat, getOwnerHash } from "@/lib/chat-owner";
import { isAllowedCsvFileUrl } from "@/lib/input-limits";
import { ChatScreen } from "@/components/chat-screen";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { APP_NAME } from "@/lib/utils";

async function loadAccessibleChat(id: string) {
  const chat = await loadChat(id);
  if (!chat || !canAccessChat(chat, await getOwnerHash())) return null;
  return chat;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const chat = await loadAccessibleChat(id);
  if (!chat) {
    return {
      title: `Chat not found | ${APP_NAME}`,
      description: "No chat found for this ID.",
    };
  }
  return {
    title:
      `${chat.title} | ${APP_NAME}` ||
      `Chat "${
        chat.messages.find((msg) => msg.role === "user")?.content
      }" | ${APP_NAME}`,
    description: chat.csvHeaders
      ? `Chat about CSV columns: ${chat.csvHeaders.join(", ")}`
      : "Chat with your CSV using Together.ai",
    openGraph: {
      images: ["https://csvtochat.com/og.jpg"],
    },
  };
}

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const chat = await loadAccessibleChat(id);
  if (!chat) notFound();

  return (
    <ChatScreen
      id={id}
      initialMessages={chat.messages}
      uploadedFile={{
        url:
          chat.csvFileUrl && isAllowedCsvFileUrl(chat.csvFileUrl)
            ? chat.csvFileUrl
            : "",
        csvHeaders: chat.csvHeaders || [],
        csvRows: chat.csvRows || [],
      }}
    />
  );
}
