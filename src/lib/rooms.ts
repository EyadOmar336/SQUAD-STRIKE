import { db } from "@/db";
import { rooms, players } from "@/db/schema";
import { and, eq, gt, sql } from "drizzle-orm";

export async function ensureRooms() {
  await db.insert(rooms).values([
    { id: "public-valley", code: "VALLEY", name: "Valley Vanguard", map: "valley", permanent: true },
    { id: "public-desert", code: "DUST01", name: "Desert Drifters", map: "desert", permanent: true },
    { id: "public-harbor", code: "HARBOR", name: "Night Shift", map: "harbor", permanent: true },
  ]).onConflictDoNothing();
}
export async function roomView(room: typeof rooms.$inferSelect) {
  const [count] = await db.select({ value: sql<number>`count(*)::int` }).from(players).where(and(eq(players.roomId, room.id), gt(players.updatedAt, new Date(Date.now() - 20000))));
  return { ...room, playerCount: count?.value ?? 0 };
}
export const publicPlayer = { id: players.id, name: players.name, position: players.position, hp: players.hp, score: players.score, kills: players.kills, shots: players.shots, playing: players.playing };
export function cleanName(input: unknown, fallback = "OPERATOR") { return typeof input === "string" ? input.trim().replace(/[<>\u0000-\u001f]/g, "").slice(0, 24) || fallback : fallback; }
export function errorResponse(message: string, status = 400) { return Response.json({ error: message }, { status }); }
