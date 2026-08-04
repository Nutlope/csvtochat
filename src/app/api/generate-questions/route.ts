import { NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { togetherAISDKClient } from "@/lib/clients";
import { generateQuestionsPrompt } from "@/lib/prompts";
import {
  endAndFlushBraintrustSpanAfterResponse,
  logBraintrustEvent,
  serializeBraintrustError,
  startBraintrustSpan,
} from "@/lib/braintrust";

const QUESTION_GENERATION_MODEL =
  "meta-llama/Llama-3.3-70B-Instruct-Turbo";

const questionSchema = z.object({
  id: z.string(),
  text: z
    .string()
    .describe("A question that can be asked about the provided CSV columns."),
});
const questionsSchema = z.object({
  questions: z.array(questionSchema).length(3),
});

export async function POST(req: Request) {
  let span: ReturnType<typeof startBraintrustSpan> = undefined;
  let startedAt: number | undefined;

  try {
    const { columns } = await req.json();

    if (!columns || !Array.isArray(columns) || columns.length === 0) {
      return NextResponse.json(
        { error: 'Invalid input: "columns" array is required.' },
        { status: 400 },
      );
    }

    startedAt = performance.now();
    span = startBraintrustSpan({
      name: "csvtochat.generate-questions",
      type: "llm",
      event: {
        metadata: {
          model: QUESTION_GENERATION_MODEL,
          route: "/api/generate-questions",
          columnCount: columns.length,
        },
      },
    });

    const generation = await generateObject({
      model: togetherAISDKClient(QUESTION_GENERATION_MODEL),
      mode: "json",
      output: "object",
      schema: questionsSchema,
      temperature: 0,
      maxTokens: 500,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(8_000),
      prompt: generateQuestionsPrompt({ csvHeaders: columns }),
    });
    const { questions: generatedQuestions } = questionsSchema.parse(
      generation.object,
    );
    const { finishReason, usage } = generation;

    logBraintrustEvent(span, {
      output: { questionCount: generatedQuestions.length },
      metadata: { success: true, finishReason },
      metrics: {
        duration_ms: performance.now() - startedAt,
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        tokens: usage.totalTokens,
      },
    });

    return NextResponse.json(
      { questions: generatedQuestions.slice(0, 3) },
      { status: 200 },
    );
  } catch (error) {
    if (startedAt !== undefined) {
      logBraintrustEvent(span, {
        error: serializeBraintrustError(error),
        metadata: { success: false },
        metrics: { duration_ms: performance.now() - startedAt },
      });
    }
    console.error("Error generating questions:", error);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 },
    );
  } finally {
    endAndFlushBraintrustSpanAfterResponse(span);
  }
}
