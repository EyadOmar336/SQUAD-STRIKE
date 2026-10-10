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
// Voice chat schema bootstrap: deployments upgrade in place without a migration step.
let voiceSchemaReady: Promise<void> | null = null;
export function ensureVoiceSchema() {
  voiceSchemaReady ??= (async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS strike_voice_signals (
      id text PRIMARY KEY,
      room_id text NOT NULL REFERENCES strike_rooms(id) ON DELETE CASCADE,
      from_player text NOT NULL,
      to_player text NOT NULL,
      kind text NOT NULL,
      payload jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS strike_voice_signals_to_idx ON strike_voice_signals (to_player, created_at)`);
    await db.execute(sql`ALTER TABLE strike_players ADD COLUMN IF NOT EXISTS voice_at timestamptz`);
  })().catch((error) => { voiceSchemaReady = null; throw error; });
  return voiceSchemaReady;
}
export async function roomView(room: typeof rooms.$inferSelect) {
  const [count] = await db.select({ value: sql<number>`count(*)::int` }).from(players).where(and(eq(players.roomId, room.id), gt(players.updatedAt, new Date(Date.now() - 20000))));
  return { ...room, playerCount: count?.value ?? 0 };
}
export const publicPlayer = { id: players.id, name: players.name, position: players.position, hp: players.hp, score: players.score, kills: players.kills, shots: players.shots, playing: players.playing };
export function cleanName(input: unknown, fallback = "OPERATOR") { return typeof input === "string" ? input.trim().replace(/[<>\u0000-\u001f]/g, "").slice(0, 24) || fallback : fallback; }
export function errorResponse(message: string, status = 400) { return Response.json({ error: message }, { status }); }
