import { db } from "@/db";
import { scores } from "@/db/schema";
import { desc } from "drizzle-orm";
import { cleanName, errorResponse } from "@/lib/rooms";

export const dynamic = "force-dynamic";
export async function GET() {
  try { return Response.json({ scores: await db.select().from(scores).orderBy(desc(scores.score)).limit(20) }); }
  catch { return errorResponse("Global rankings are temporarily unavailable.", 503); }
}
export async function POST(request: Request) {
  try {
    const data = await request.json();
    if (typeof data.id !== "string" || !/^[0-9a-f-]{36}$/i.test(data.id) || !Number.isInteger(data.score) || data.score < 0 || data.score > 150000 || !Number.isInteger(data.kills) || data.kills < 0 || data.kills > 1000 || !Number.isInteger(data.duration) || data.duration < 0 || data.duration > 185 || !["valley", "desert", "harbor"].includes(data.map)) return errorResponse("Invalid match result.");
    await db.insert(scores).values({ id: data.id, name: cleanName(data.name), score: data.score, kills: data.kills, map: data.map, duration: data.duration }).onConflictDoNothing();
    return Response.json({ saved: true });
  } catch { return errorResponse("Score saved locally. Global sync unavailable.", 503); }
}
