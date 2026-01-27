import { NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { togetherAISDKClient } from "@/lib/clients";
import { generateQuestionsPrompt } from "@/lib/prompts";

const questionSchema = z.object({
  id: z.string(),
  text: z
    .string()
    .describe("A question that can be asked about the provided CSV columns."),
});

export async function POST(req: Request) {
  try {
    const { columns } = await req.json();

    if (!columns || !Array.isArray(columns) || columns.length === 0) {
      return NextResponse.json(
        { error: 'Invalid input: "columns" array is required.' },
        { status: 400 },
      );
    }

    console.log("Generating questions for columns:", columns);
    console.log("Prompt:", generateQuestionsPrompt({ csvHeaders: columns }));

    const { object: generatedQuestions } = await generateObject({
      model: togetherAISDKClient(
        "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
      ),
      mode: "json",
      output: "array",
      schema: questionSchema,
      maxTokens: 1000,
      maxRetries: 1,
      prompt: generateQuestionsPrompt({ csvHeaders: columns }),
    });

    return NextResponse.json(
      { questions: generatedQuestions.slice(0, 3) },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error generating questions:", error);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 },
    );
  }
}
