import { POST as s3UploadRoute } from "next-s3-upload/route";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";
import { getClientIp } from "@/lib/client-ip";
import { enforceRateLimit } from "@/lib/rate-limit";

const uploadRequestSchema = z.object({
  filename: z
    .string()
    .min(1)
    .max(255)
    .refine((name) => name.toLowerCase().endsWith(".csv")),
  filetype: z.literal("text/csv"),
  _nextS3: z.object({ strategy: z.literal("presigned") }),
});

const sanitizeFilename = (filename: string) =>
  filename
    .slice(0, -".csv".length)
    .replace(/[^0-9a-zA-Z._-]/g, "-")
    .slice(0, 100) + ".csv";

export async function POST(req: NextRequest) {
  const parsed = uploadRequestSchema.safeParse(
    await req
      .clone()
      .json()
      .catch(() => null)
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid upload" }, { status: 400 });
  }

  const limited = await enforceRateLimit("upload", getClientIp(req.headers));
  if (limited) return limited;

  const key = `next-s3-uploads/${randomUUID()}/${sanitizeFilename(
    parsed.data.filename
  )}`;
  return s3UploadRoute.configure({ key: () => key })(req);
}
