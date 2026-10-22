import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";

const OWNER_COOKIE = "csvtochat_owner";
const OWNER_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export async function getOwnerHash(): Promise<string | null> {
  const token = (await cookies()).get(OWNER_COOKIE)?.value;
  return token ? hashToken(token) : null;
}

// Only callable from server actions and route handlers (sets a cookie).
export async function getOrCreateOwnerHash(): Promise<string> {
  const cookieStore = await cookies();
  let token = cookieStore.get(OWNER_COOKIE)?.value;
  if (!token) {
    token = randomBytes(32).toString("base64url");
    cookieStore.set(OWNER_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: OWNER_COOKIE_MAX_AGE,
    });
  }
  return hashToken(token);
}

// Chats created before ownership was tracked have no owner and stay
// accessible by id.
export function canAccessChat(
  chat: { ownerHash?: string },
  ownerHash: string | null
): boolean {
  if (!chat.ownerHash) return true;
  if (!ownerHash) return false;
  const expected = Buffer.from(chat.ownerHash);
  const actual = Buffer.from(ownerHash);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
