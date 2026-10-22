"use client";

import React, { Suspense, useState, useCallback } from "react";
import { Header } from "@/components/header";
import { UploadArea } from "@/components/upload-area";
import { HeroSection } from "@/components/hero-section";
import { QuestionSuggestionCard } from "@/components/question-suggestion-card";
import { extractCsvData } from "@/lib/csvUtils";
import { createChat } from "@/app/actions";
import { usePresignedUpload } from "next-s3-upload";
import { PromptInput } from "@/components/PromptInput";
import { toast } from "sonner";
import { useLLMModel } from "@/hooks/useLLMModel";
import { redirect } from "next/navigation";
import Loading from "./chat/[id]/loading";

export interface SuggestedQuestion {
  id: string;
  text: string;
}

function CSVToChatClient({
  setIsLoading,
}: {
  setIsLoading: (load: boolean) => void;
}) {
  const { uploadToS3 } = usePresignedUpload();
  const { selectedModelSlug } = useLLMModel();
  const [localFile, setLocalFile] = useState<File | null>(null);
  const [suggestedQuestions, setSuggestedQuestions] = useState<
    SuggestedQuestion[]
  >([]);
  const [inputValue, setInputValue] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<{ [key: string]: string }[]>([]);
  const [uploadedFileUrl, setUploadedFileUrl] = useState<string | null>(null);

  const handleFileUpload = useCallback(async (file: File | null) => {
    if (file && file.type === "text/csv") {
      setLocalFile(file);
      setIsProcessing(true);

      try {
        const { headers, sampleRows } = await extractCsvData(file);

        if (headers.length === 0 || sampleRows.length === 0) {
          alert("Please upload a CSV with headers.");
          setLocalFile(null);
          setIsProcessing(false);
          return;
        }

        setCsvRows(sampleRows);
        setCsvHeaders(headers);

        const uploadPromise = uploadToS3(file);

        const response = await fetch("/api/generate-questions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ columns: headers }),
        });

        const uploadedFile = await uploadPromise;

        setUploadedFileUrl(uploadedFile.url);

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        setSuggestedQuestions(data.questions);
      } catch (error) {
        console.error("Failed to process CSV file:", error);
      } finally {
        setIsProcessing(false);
      }
    }
  }, []);

  const handleSuggestionClick = (question: string) => {
    handleSendMessage(question);
  };

  const handleSendMessage = async (messageText?: string) => {
    const text = messageText || inputValue.trim();
    if (!text) return;

    if (!uploadedFileUrl) {
      toast.warning("Please upload a CSV file first.");
      return;
    }

    if (csvHeaders.length === 0) {
      toast.warning("Please upload a CSV with headers.");
      return;
    }

    if (csvRows.length === 0) {
      toast.warning("Please upload a CSV with data.");
      return;
    }

    localStorage.setItem("pendingMessage", text);

    setIsLoading(true);

    const result = await createChat({
      userQuestion: text, // it's not stored in db here just used for chat title!
      csvHeaders: csvHeaders,
      csvFileUrl: uploadedFileUrl,
      csvRows: csvRows,
    });
    if ("error" in result) {
      localStorage.removeItem("pendingMessage");
      setIsLoading(false);
      toast.error(result.error);
      return;
    }
    redirect(`/chat/${result.id}?model=${selectedModelSlug}`);
  };

  return (
    <>
      <UploadArea onFileChange={handleFileUpload} uploadedFile={localFile} />
      {/* Large Input Area */}
      {localFile && (
        <div className="w-full max-w-sm md:max-w-2xl mx-auto">
          <PromptInput
            value={inputValue}
            onChange={setInputValue}
            onSend={() => {
              handleSendMessage(inputValue);
            }}
            uploadedFile={{
              name: localFile.name,
              csvHeaders: csvHeaders,
              csvRows: csvRows,
            }}
            textAreaClassName="h-[88px] md:h-[100px]"
            isLLMAnswering={false}
            onStopLLM={() => {}}
          />
        </div>
      )}
      {/* Processing State */}
      {isProcessing && (
        <div className="w-full max-w-sm my-8 md:max-w-2xl">
          <p className="text-slate-500 text-sm mb-4 animate-pulse">
            <span className="font-medium">Generating suggestions</span>{" "}
            <span className="text-slate-400">...</span>
          </p>
          <div className="flex flex-col gap-3">
            {Array(3)
              .fill(null)
              .map((_, idx) => (
                <QuestionSuggestionCard key={idx} question={""} isLoading />
              ))}
          </div>
        </div>
      )}
      {/* Suggestions */}
      {suggestedQuestions.length > 0 && !isProcessing && (
        <div className="w-full max-w-sm my-8 md:max-w-2xl">
          <p className="text-slate-500 text-sm mb-4">
            <span className="font-medium">Suggestions</span>{" "}
            <span className="text-slate-400">based on your uploaded CSV:</span>
          </p>
          <div className="flex flex-col gap-3">
            {suggestedQuestions.map((suggestion) => (
              <QuestionSuggestionCard
                key={suggestion.id}
                question={suggestion.text}
                onClick={() => handleSuggestionClick(suggestion.text)}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export default function CSVToChat() {
  const [isLoading, setIsLoading] = useState(false);

  if (isLoading) {
    return <Loading />;
  }

  return (
    <div className="min-h-screen bg-white">
      <Header />
      <div className="flex flex-col items-center px-4 md:px-6 max-w-[655px] mx-auto">
        <div className="flex flex-col items-center md:items-start pt-16 md:pt-[132px] pb-8 mx-auto w-full">
          <HeroSection />
        </div>
        <Suspense fallback={<div>Loading...</div>}>
          <CSVToChatClient setIsLoading={setIsLoading} />
        </Suspense>
      </div>
    </div>
  );
}
