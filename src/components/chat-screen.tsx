"use client";

import { useChat } from "@ai-sdk/react";
import React, { useEffect, useState, useRef } from "react";
import { Header } from "@/components/header";
import { ChatInput } from "@/components/ChatInput";
import { MemoizedMarkdown } from "./MemoizedMarkdown";
import type { CodeInterpreterResponseData } from "@/lib/coding";
import { type UIMessage } from "ai";
import { ImageFigure } from "./chatTools/ImageFigure";
import { TerminalOutput } from "./chatTools/TerminalOutput";
import { ErrorOutput } from "./chatTools/ErrorOutput";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { useDraftedInput } from "../hooks/useDraftedInput";
import type { DbMessage } from "@/lib/chat-store";
import {
  cn,
  extractCodeFromText,
  formatLLMTimestamp,
  UploadedFile,
} from "@/lib/utils";
import { ErrorBanner } from "./ui/ErrorBanner";
import { ThinkingIndicator } from "./ui/ThinkingIndicator";
import ReasoningAccordion from "./ReasoningAccordion";
import { useLLMModel } from "@/hooks/useLLMModel";
import { CodeRunning } from "./chatTools/CodeRunning";
import { CHAT_MODELS } from "@/lib/models";
import { MAX_ERROR_CHARS } from "@/lib/input-limits";
import { useRouter } from "next/navigation";

export type Message = UIMessage & {
  isThinking?: boolean;
  isUser?: boolean;
  toolCall?: {
    toolInvocation: {
      toolName: string;
      args: string;
      state: string;
      result?: any;
    };
  };
  duration?: number; // Duration in seconds for LLM/coding
  model?: string; // Model used for the message
  isAutoErrorResolution?: boolean; // Added for auto error resolution prompt
};

export function ChatScreen({
  uploadedFile,
  id,
  initialMessages,
}: {
  uploadedFile: UploadedFile;
  id?: string;
  initialMessages?: DbMessage[];
}) {
  const router = useRouter();
  const { selectedModelSlug } = useLLMModel();

  const modelContextLength = CHAT_MODELS.find(
    (model) => model.slug === selectedModelSlug
  )?.contextLength;

  const { messages, setMessages, append, stop, status } = useChat({
    id, // use the provided chat ID
    initialMessages: initialMessages || [], // initial messages if provided
    sendExtraMessageFields: true, // send id and createdAt for each message
    experimental_prepareRequestBody({ messages, id }) {
      return {
        message: messages[messages.length - 1].content,
        id,
        model: selectedModelSlug,
      };
    },
    // Fake tool call
    onFinish: async (message) => {
      const code = extractCodeFromText(message.content);

      if (code) {
        // Add a "tool-invocation" message with a "start" state
        setMessages((prev) => {
          return [
            ...prev,
            {
              id: message.id + "_tool_call", // Unique ID for the tool call message
              role: "assistant",
              content: "",
              isThinking: true,
              toolCall: {
                toolInvocation: {
                  toolName: "runCode",
                  args: code,
                  state: "start",
                },
              },
            },
          ];
        });

        setIsCodeRunning(true);
        codeAbortController.current = new AbortController();
        let result;
        try {
          const response = await fetch("/api/coding", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ id, messageId: message.id }),
            signal: codeAbortController.current.signal,
          });

          result = await response.json();
          if (!response.ok) {
            throw new Error(result?.error || "Code execution failed.");
          }
        } catch (error: any) {
          if (error.name === "AbortError") {
            // Fetch was aborted, handle accordingly
            setIsCodeRunning(false);
            // Optionally update the tool call message to show cancellation
            setMessages((prev) =>
              prev.map((msg) => {
                if (msg.id === message.id + "_tool_call") {
                  return {
                    ...msg,
                    isThinking: false,
                    content: "Code execution cancelled.",
                    toolCall: {
                      toolInvocation: {
                        toolName: "runCode",
                        args: code,
                        state: "result",
                        result: { outputs: [] },
                      },
                    },
                  };
                }
                return msg;
              })
            );
            return;
          } else {
            // Handle other errors
            setIsCodeRunning(false);
            setMessages((prev) =>
              prev.map((msg) => {
                if (msg.id === message.id + "_tool_call") {
                  return {
                    ...msg,
                    isThinking: false,
                    content: `Code execution failed: ${error.message}`,
                    toolCall: {
                      toolInvocation: {
                        toolName: "runCode",
                        args: code,
                        state: "result",
                        result: {
                          outputs: [{ type: "error", data: error.message }],
                        },
                      },
                    },
                  };
                }
                return msg;
              })
            );
            return;
          }
        }

        // Check for error in outputs
        const errorOutput = Array.isArray(result.outputs)
          ? result.outputs.find(
              (output: any) =>
                output.type === "error" || output.type === "stderr"
            )
          : undefined;
        const errorOccurred = Boolean(errorOutput);
        const errorMessage = errorOutput
          ? String(errorOutput.data || "Unknown error").slice(
              0,
              MAX_ERROR_CHARS
            )
          : "";

        if (errorOccurred) {
          // Send error back to AI for resolution
          const errorResolutionPrompt = `The following error occurred when running the code you provided: ${errorMessage}. Please try to fix the code and try again.`;

          // Append the error resolution prompt as a user message
          setTimeout(() => {
            append(
              {
                role: "user",
                content: errorResolutionPrompt,
              },
              {
                headers: {
                  "Content-Type": "application/json",
                  "X-Auto-Error-Resolved": "true",
                },
              }
            );
          }, 1000); // slight delay for UX
        }

        // Update the tool call message with the "result" state
        setMessages((prev) => {
          return prev.map((msg) => {
            if (msg.id === message.id + "_tool_call") {
              return {
                ...msg,
                isThinking: false,
                content: errorOccurred
                  ? "Code execution failed."
                  : "Code execution complete.",
                toolCall: {
                  toolInvocation: {
                    toolName: "runCode",
                    args: code,
                    state: "result",
                    result: result,
                  },
                },
              };
            }
            return msg;
          });
        });
        setIsCodeRunning(false);
        codeAbortController.current = null;
      }
    },
  });

  // On mount, check for pendingMessage in localStorage and append it if present
  const didAppendPending = React.useRef(false);
  useEffect(() => {
    if (
      !didAppendPending.current &&
      messages.length === 0 &&
      typeof window !== "undefined"
    ) {
      const pending = localStorage.getItem("pendingMessage");
      if (pending) {
        append({
          role: "user",
          content: pending,
        });
        localStorage.removeItem("pendingMessage");
        didAppendPending.current = true;
      }
    }
  }, [append, messages.length]);

  // Use a unique key for each chat window's draft input
  const [inputValue, setInputValue, clearInputValue] = useDraftedInput(
    id ? `chatInputDraft-${id}` : "chatInputDraft"
  );

  const [isCodeRunning, setIsCodeRunning] = useState(false);
  const codeAbortController = useRef<AbortController | null>(null);
  const { messagesContainerRef, messagesEndRef, isUserAtBottom } =
    useAutoScroll({ status, isCodeRunning });

  // Token counting logic (approximate: 1 token ≈ 4 chars)
  const [tokenInfo, setTokenInfo] = useState({
    tokens: 0,
    percent: 0,
    max: modelContextLength || 0,
  });

  useEffect(() => {
    if (!modelContextLength) return;
    // Only count user/assistant messages (not tool calls)
    const text = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => m.content)
      .join("\n");
    // Approximate token count: 1 token ≈ 3 chars
    const approxTokens = Math.ceil(text.length / 3);
    const percent = Math.min(100, (approxTokens / modelContextLength) * 100);
    setTokenInfo({ tokens: approxTokens, percent, max: modelContextLength });
  }, [messages, modelContextLength]);

  return (
    <div className="min-h-screen bg-white flex flex-col w-full h-screen">
      <Header chatId={id} />

      {/* Context usage bar */}
      <div className="w-full flex flex-col items-center py-2">
        <div className="w-full max-w-[700px] px-4 md:ml-[70px]">
          <div className="flex justify-between text-xs text-slate-500 mb-1">
            <span>Context used</span>
            <span>
              {tokenInfo.tokens} / {tokenInfo.max} tokens (
              {tokenInfo.percent.toFixed(1)}%)
            </span>
          </div>
          <div className="w-full h-2 bg-slate-200 rounded">
            <div
              className="h-2 bg-blue-500 rounded"
              style={{ width: `${tokenInfo.percent}%` }}
            />
          </div>
        </div>
      </div>

      <div className="flex flex-col md:ml-[70px] flex-1">
        {/* Messages */}
        <div
          className="flex-1 overflow-y-auto p-4 gap-4 flex flex-col mx-auto max-w-[700px] w-full"
          ref={messagesContainerRef}
        >
          {messages.map((message, messageIdx) => {
            const currentMessage = message as Message; // Cast to our custom Message interface

            const codeResults =
              currentMessage.toolCall?.toolInvocation.toolName === "runCode"
                ? (currentMessage.toolCall?.toolInvocation
                    .result as CodeInterpreterResponseData)
                : undefined;

            const stdOut = codeResults?.outputs?.find(
              (result: any) => result.type === "stdout"
            );

            const errorCode = codeResults?.outputs?.find(
              (result: any) =>
                result.type === "error" || result.type === "stderr"
            );

            const imagePngBase64 = codeResults?.outputs?.find(
              (result: any) =>
                result.type === "display_data" &&
                result.data &&
                result.data["image/png"]
            );

            const modelTitle = CHAT_MODELS.find(
              (model) => model.model === currentMessage.model
            )?.title;

            const isThisLastMessage = messages.length - 1 === messageIdx;

            const isUserMessage = currentMessage.role === "user";

            const reasoning = currentMessage.parts.find(
              (part) => part.type === "reasoning"
            );

            return (
              <div
                key={currentMessage.id}
                className={cn(
                  "flex justify-end flex-col",
                  isUserMessage ? "items-end" : "items-start"
                )}
              >
                {isUserMessage ? (
                  <>
                    {currentMessage.content.startsWith(
                      "The following error occurred when running the code you provided:"
                    ) ? (
                      <ErrorBanner isWaiting={isThisLastMessage} />
                    ) : (
                      <div
                        className="flex justify-end items-center relative overflow-hidden gap-2.5 px-3 py-2 rounded bg-slate-200 border border-[#cad5e2] max-w-[240px] md:max-w-[50%]"
                        style={{
                          boxShadow: "0px 0px 7px -5px rgba(0,0,0,0.25)",
                        }}
                      >
                        <p className="text-sm text-left text-[#0f172b]">
                          {currentMessage.content}
                        </p>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="w-full">
                    <ReasoningAccordion
                      reasoning={reasoning}
                      isReasoningOver={
                        !!currentMessage.content &&
                        currentMessage.content.length > 0
                      }
                    />

                    <div className="text-slate-800 text-sm prose">
                      <MemoizedMarkdown
                        id={currentMessage.id}
                        content={currentMessage.content}
                      />
                    </div>

                    {currentMessage.isThinking && <CodeRunning />}

                    {currentMessage.toolCall?.toolInvocation.state ===
                      "result" && (
                      <div className="text-slate-800 text-sm leading-relaxed">
                        {errorCode ? (
                          <ErrorOutput data={String(errorCode.data)} />
                        ) : (
                          <>
                            {stdOut && (
                              <TerminalOutput data={String(stdOut.data)} />
                            )}

                            {imagePngBase64 && (
                              <ImageFigure
                                imageData={imagePngBase64.data as any}
                              />
                            )}
                          </>
                        )}
                      </div>
                    )}
                    {/* Timestamp for assistant messages */}
                    {currentMessage.role === "assistant" &&
                      currentMessage.createdAt && (
                        <div className="flex justify-start mt-3">
                          <span className="text-xs text-slate-400">
                            {typeof currentMessage.duration === "number" && (
                              <>
                                <span className="mr-0.5">
                                  {currentMessage.duration.toFixed(2)}s -
                                </span>
                              </>
                            )}
                            {formatLLMTimestamp(currentMessage.createdAt)}{" "}
                            {modelTitle && (
                              <>
                                <span className="mr-0.5">- {modelTitle}</span>
                              </>
                            )}
                          </span>
                        </div>
                      )}
                  </div>
                )}

                {isThisLastMessage && status === "submitted" && (
                  <ThinkingIndicator />
                )}
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        <ChatInput
          value={inputValue}
          onChange={(value) => setInputValue(value)}
          onSend={async () => {
            // Clear input and localStorage immediately on submit
            const newMessage = inputValue;
            clearInputValue();
            await append({
              role: "user",
              content: newMessage,
            });
          }}
          uploadedFile={
            uploadedFile && {
              url: uploadedFile.url,
              csvHeaders: uploadedFile.csvHeaders,
              csvRows: uploadedFile.csvRows,
            }
          }
          onStopLLM={() => {
            if (status === "submitted" || status === "streaming") {
              return stop();
            }
            if (isCodeRunning && codeAbortController.current) {
              codeAbortController.current.abort();
              console.log("Aborted code execution frontend");
              setIsCodeRunning(false);
            }
          }}
          isLLMAnswering={
            status === "submitted" || status === "streaming" || isCodeRunning
          }
        />
      </div>
    </div>
  );
}
