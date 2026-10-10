import { db } from "@/db";
import { rooms, players, voiceSignals } from "@/db/schema";
import { and, eq, gt, lt, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { ensureVoiceSchema, errorResponse } from "@/lib/rooms";

// WebRTC signaling relay for in-room voice chat.
// Clients poll this endpoint to publish SDP offers/answers + ICE candidates and
// consume the ones addressed to them. Voice presence = polling within the last seconds.
const SIGNAL_KINDS = new Set(["offer", "answer", "candidate", "bye"]);
const MAX_SIGNALS_PER_POLL = 64;
const MAX_PAYLOAD_BYTES = 16000;
const SIGNAL_TTL_MS = 90000;
const VOICE_PRESENCE_MS = 9000;

type OutboundSignal = { to?: unknown; kind?: unknown; payload?: unknown };

function payloadSize(payload: unknown) {
  try { return JSON.stringify(payload ?? null).length; } catch { return MAX_PAYLOAD_BYTES; }
}

export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await params;
    const body = await request.json();
    if (typeof body.token !== "string") return errorResponse("Session required.", 401);
    await ensureVoiceSchema();
    const [room] = await db.select().from(rooms).where(eq(rooms.code, code.toUpperCase()));
    if (!room) return errorResponse("Room no longer exists.", 404);
    const [me] = await db.select().from(players).where(and(eq(players.token, body.token), eq(players.roomId, room.id)));
    if (!me) return errorResponse("Please rejoin the room.", 401);

    const outbound: OutboundSignal[] = Array.isArray(body.signals) ? body.signals.slice(0, MAX_SIGNALS_PER_POLL) : [];
    if (outbound.length > 0) {
      const rows = outbound
        .filter((signal) => SIGNAL_KINDS.has(String(signal?.kind)) && typeof signal?.to === "string" && signal.to !== me.id && payloadSize(signal?.payload) <= MAX_PAYLOAD_BYTES)
        .map((signal) => ({ id: randomUUID(), roomId: room.id, fromPlayer: me.id, toPlayer: signal.to as string, kind: String(signal.kind), payload: signal.payload ?? null }));
      if (rows.length > 0) await db.insert(voiceSignals).values(rows);
    }

    // Mark voice presence, expire stale signaling rows, then consume everything addressed to me.
    await db.update(players).set({ voiceAt: new Date() }).where(eq(players.id, me.id));
    await db.delete(voiceSignals).where(lt(voiceSignals.createdAt, new Date(Date.now() - SIGNAL_TTL_MS)));
    const mine = await db.delete(voiceSignals).where(and(eq(voiceSignals.roomId, room.id), eq(voiceSignals.toPlayer, me.id))).returning();
    mine.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const peers = await db.select({ id: players.id, name: players.name }).from(players)
      .where(and(eq(players.roomId, room.id), ne(players.id, me.id), gt(players.voiceAt, new Date(Date.now() - VOICE_PRESENCE_MS))));

    return Response.json({
      peers,
      signals: mine.map((signal) => ({ from: signal.fromPlayer, kind: signal.kind, payload: signal.payload })),
      serverTime: Date.now(),
    });
  } catch (error) { console.error("Voice signaling:", error); return errorResponse("Voice channel interrupted.", 503); }
}
