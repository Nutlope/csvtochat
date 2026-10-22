import { z } from "zod";

export const MAX_MESSAGE_CHARS = 4_000;
export const MAX_CHAT_MESSAGES = 200;
export const MAX_AUTO_FIXES_IN_A_ROW = 3;
export const MAX_CODE_CHARS = 20_000;
export const MAX_ERROR_CHARS = 3_500;
export const MAX_COLUMNS = 300;
export const MAX_COLUMN_CHARS = 200;
export const MAX_COLUMNS_TOTAL_CHARS = 12_000;
export const MAX_SAMPLE_ROWS = 10;
export const MAX_CELL_CHARS = 500;
export const MAX_HISTORY_IDS = 100;

export const chatIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/);

export const csvHeadersSchema = z
  .array(z.string().max(MAX_COLUMN_CHARS))
  .min(1)
  .max(MAX_COLUMNS)
  .refine(
    (headers) => headers.join("").length <= MAX_COLUMNS_TOTAL_CHARS,
    "Too many column characters"
  );

export const csvRowsSchema = z
  .array(z.record(z.string(), z.unknown()))
  .min(1)
  .max(MAX_SAMPLE_ROWS);

export function normalizeCsvRows(
  headers: string[],
  rows: Record<string, unknown>[]
): { [key: string]: string }[] {
  return rows.map((row) =>
    Object.fromEntries(
      headers.map((header) => [
        header,
        typeof row[header] === "string"
          ? (row[header] as string).slice(0, MAX_CELL_CHARS)
          : "",
      ])
    )
  );
}

export const userMessageSchema = z.string().trim().min(1).max(MAX_MESSAGE_CHARS);

export function isAllowedCsvFileUrl(
  value: string,
  env: Record<string, string | undefined> = process.env
): boolean {
  const bucket = env.S3_UPLOAD_BUCKET;
  const region = env.S3_UPLOAD_REGION;
  if (!bucket || !region) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.host === `${bucket}.s3.${region}.amazonaws.com` &&
    url.pathname.startsWith("/next-s3-uploads/") &&
    !url.search &&
    !url.hash
  );
}
