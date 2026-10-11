import { and, eq, gt } from "drizzle-orm";
import { db, hasPersistentDatabase, pool } from "@/db";
import { players, rooms } from "@/db/schema";
import { errorResponse } from "@/lib/rooms";
import { isAuthorizedVoiceMember, isValidVoiceSignalPayload, isVoiceSignalType } from "@/lib/voice-signaling";

export const dynamic = "force-dynamic";

const activeSince = () => new Date(Date.now() - 45000);
let schemaReady: Promise<void> | null = null;
let lastCleanupAt = 0;

async function ensureVoiceSignalTable() {
  if (!hasPersistentDatabase) throw new Error("Persistent voice signaling requires PostgreSQL.");
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS strike_voice_signals (
        id BIGSERIAL PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES strike_rooms(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL REFERENCES strike_players(id) ON DELETE CASCADE,
        recipient_id TEXT NOT NULL REFERENCES strike_players(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('offer', 'answer', 'ice')),
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      )`);
      await pool.query("CREATE INDEX IF NOT EXISTS strike_voice_signals_recipient_idx ON strike_voice_signals (room_id, recipient_id, id)");
      await pool.query("CREATE INDEX IF NOT EXISTS strike_voice_signals_expiry_idx ON strike_voice_signals (expires_at)");
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
  if (Date.now() - lastCleanupAt > 60000) {
    lastCleanupAt = Date.now();
    await pool.query("DELETE FROM strike_voice_signals WHERE expires_at <= now()").catch(() => {
      lastCleanupAt = 0;
    });
  }
}

const configuredIceServers = () => {
  const servers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
  const urls = process.env.TURN_URL;
  if (urls) {
    servers.push({
      urls: urls.split(",").map((url) => url.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  return servers;
};

export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await params;
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > 24000) return errorResponse("Voice request is too large.", 413);
    let body: unknown;
    try { body = JSON.parse(rawBody); } catch { return errorResponse("Invalid JSON body."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return errorResponse("Invalid voice request.");
    const input = body as Record<string, unknown>;
    if (typeof input.token !== "string" || input.token.length > 128) return errorResponse("Session required.", 401);

    const [room] = await db.select().from(rooms).where(eq(rooms.code, code.toUpperCase()));
    if (!room) return errorResponse("Room no longer exists.", 404);
    const [sender] = await db.select().from(players).where(eq(players.token, input.token));
    if (!isAuthorizedVoiceMember(sender, input.token, room.id)) {
      return errorResponse("Please rejoin the room.", 401);
    }

    if (input.action === "poll") {
      if (!Number.isSafeInteger(input.cursor) || Number(input.cursor) < 0) return errorResponse("Invalid signaling cursor.");
      if (!hasPersistentDatabase) return errorResponse("Voice chat requires PostgreSQL configuration.", 503);
      await ensureVoiceSignalTable();
      const [messages, peers] = await Promise.all([
        pool.query(
          `SELECT id, sender_id AS "senderId", kind, payload
           FROM strike_voice_signals
           WHERE room_id = $1 AND recipient_id = $2 AND id > $3 AND expires_at > now()
           ORDER BY id ASC LIMIT 100`,
          [room.id, sender.id, input.cursor],
        ),
        db.select({ id: players.id }).from(players).where(and(
          eq(players.roomId, room.id),
          gt(players.updatedAt, activeSince()),
        )),
      ]);
      const activePeers = peers as Array<{ id: string }>;
      return Response.json({
        peers: activePeers.filter((peer) => peer.id !== sender.id).map((peer) => peer.id),
        messages: messages.rows.map((message: { id: string | number }) => ({ ...message, id: Number(message.id) })),
        iceServers: configuredIceServers(),
      });
    }

    if (input.action !== "send") return errorResponse("Invalid signaling action.");
    if (typeof input.recipientId !== "string" || input.recipientId.length > 80 || input.recipientId === sender.id) {
      return errorResponse("Invalid signaling recipient.");
    }
    if (!isVoiceSignalType(input.type) || !isValidVoiceSignalPayload(input.type, input.payload)) {
      return errorResponse("Invalid WebRTC signaling payload.");
    }
    const [recipient] = await db.select({ id: players.id }).from(players).where(and(
      eq(players.id, input.recipientId),
      eq(players.roomId, room.id),
      gt(players.updatedAt, activeSince()),
    ));
    if (!recipient) return errorResponse("Recipient is not an active member of this room.", 403);

    if (!hasPersistentDatabase) return errorResponse("Voice chat requires PostgreSQL configuration.", 503);
    await ensureVoiceSignalTable();
    await pool.query(
      `INSERT INTO strike_voice_signals (room_id, sender_id, recipient_id, kind, payload, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now() + interval '3 minutes')`,
      [room.id, sender.id, recipient.id, input.type, JSON.stringify(input.payload)],
    );
    return Response.json({ ok: true }, { status: 202 });
  } catch (error) {
    console.error("Voice signaling:", error);
    return errorResponse("Voice signaling is temporarily unavailable.", 503);
  }
}
