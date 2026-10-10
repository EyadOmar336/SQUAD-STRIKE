import { db } from "@/db";
import { rooms, players } from "@/db/schema";
import { and, eq, gt } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { cleanName, errorResponse, publicPlayer, roomView } from "@/lib/rooms";

type Context = { params: Promise<{ code: string }> };
export async function GET(_request: Request, { params }: Context) {
  try {
    const { code } = await params;
    const [room] = await db.select().from(rooms).where(eq(rooms.code, code.toUpperCase()));
    if (!room) return errorResponse("Room not found. Double-check your invite code.", 404);
    const members = await db.select(publicPlayer).from(players).where(and(eq(players.roomId, room.id), gt(players.updatedAt, new Date(Date.now() - 20000))));
    return Response.json({ room: await roomView(room), players: members });
  } catch { return errorResponse("Connection interrupted. Please try again.", 503); }
}
export async function POST(request: Request, { params }: Context) {
  try {
    const { code } = await params;
    const body = await request.json();
    return await db.transaction(async (tx) => {
      const [room] = await tx.select().from(rooms).where(eq(rooms.code, code.toUpperCase())).for("update");
      if (!room) return errorResponse("Room not found. Double-check your invite code.", 404);
      const members = await tx.select({ id: players.id }).from(players).where(and(eq(players.roomId, room.id), gt(players.updatedAt, new Date(Date.now() - 20000))));
      if (members.length >= room.capacity) return errorResponse("This room is full. Try another battlefield.", 409);
      const token = randomUUID(); const playerId = randomUUID();
      const angle = members.length * 2.4;
      await tx.insert(players).values({ id: playerId, token, roomId: room.id, name: cleanName(body.name), position: { x: Math.sin(angle) * 15, y: 1.7, z: Math.cos(angle) * 18, yaw: angle } });
      return Response.json({ room: { ...room, playerCount: members.length + 1 }, token, playerId });
    });
  } catch { return errorResponse("Could not join this room. Please try again.", 503); }
}
export async function DELETE(request: Request, { params }: Context) {
  try {
    const { code } = await params;
    const { token } = await request.json();
    if (typeof token !== "string") return errorResponse("Missing session.", 401);
    const [room] = await db.select().from(rooms).where(eq(rooms.code, code.toUpperCase()));
    if (room) await db.delete(players).where(and(eq(players.token, token), eq(players.roomId, room.id)));
    return Response.json({ ok: true });
  } catch { return errorResponse("Could not leave room.", 503); }
}
