import { getRemainingMessages } from "@/lib/limits";
import { getClientIp } from "@/lib/client-ip";

export async function GET(request: Request) {
  // Use IP address as a simple user fingerprint
  const ip = getClientIp(request.headers);

  try {
    const result = await getRemainingMessages(ip);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Failed to load message limits:", error);
    return new Response(JSON.stringify({ error: "Internal server error." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
