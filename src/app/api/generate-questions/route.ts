import { NextResponse } from "next/server";
import { z } from "zod";
import { togetherClient } from "@/lib/clients";
import { generateQuestionsPrompt } from "@/lib/prompts";
import {
  endAndFlushBraintrustSpanAfterResponse,
  logBraintrustEvent,
  serializeBraintrustError,
  startBraintrustSpan,
} from "@/lib/braintrust";

const QUESTION_GENERATION_MODEL = "deepseek-ai/DeepSeek-V4-Flash-0731";

const questionSchema = z.object({
  id: z.string(),
  text: z
    .string()
    .describe("A question that can be asked about the provided CSV columns."),
});
const questionsSchema = z.object({
  questions: z.array(questionSchema).length(3),
});
const questionsJsonSchema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string" },
        },
        required: ["id", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
} as const;

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

    const generation = await togetherClient.chat.completions.create(
      {
        model: QUESTION_GENERATION_MODEL,
        messages: [
          {
            role: "user",
            content: generateQuestionsPrompt({ csvHeaders: columns }),
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "questions",
            schema: questionsJsonSchema,
          },
        },
        reasoning: { enabled: false },
        stream: false,
        max_tokens: 500,
        temperature: 0,
      } as Parameters<typeof togetherClient.chat.completions.create>[0] & {
        reasoning: { enabled: boolean };
        response_format: {
          type: "json_schema";
          json_schema: {
            name: string;
            schema: typeof questionsJsonSchema;
          };
        };
      },
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!("choices" in generation)) {
      throw new Error("Question generation unexpectedly returned a stream");
    }
    const content = generation.choices[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("Question generation returned no content");
    }
    const { questions: generatedQuestions } = questionsSchema.parse(
      JSON.parse(content),
    );
    const finishReason = generation.choices[0]?.finish_reason;
    const usage = generation.usage;
    const metrics: Record<string, number> = {
      duration_ms: performance.now() - startedAt,
    };
    if (usage?.prompt_tokens !== undefined) {
      metrics.prompt_tokens = usage.prompt_tokens;
    }
    if (usage?.completion_tokens !== undefined) {
      metrics.completion_tokens = usage.completion_tokens;
    }
    if (usage?.total_tokens !== undefined) {
      metrics.tokens = usage.total_tokens;
    }

    logBraintrustEvent(span, {
      output: { questionCount: generatedQuestions.length },
      metadata: { success: true, finishReason },
      metrics,
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
