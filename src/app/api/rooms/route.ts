import { db } from "@/db";
import { rooms, players } from "@/db/schema";
import { and, eq, gt, or, desc } from "drizzle-orm";
import { randomUUID, randomBytes } from "node:crypto";
import { cleanName, ensureRooms, errorResponse, roomView } from "@/lib/rooms";

export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await ensureRooms();
    const list = await db.select().from(rooms).where(and(eq(rooms.isPrivate, false), or(eq(rooms.permanent, true), gt(rooms.createdAt, new Date(Date.now() - 86400000))))).orderBy(desc(rooms.permanent), rooms.createdAt).limit(40);
    return Response.json({ rooms: await Promise.all(list.map(roomView)) });
  } catch (error) { console.error("Rooms:", error); return errorResponse("Room service is reconnecting. Solo quick play is still available.", 503); }
}
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const map = ["valley", "desert", "harbor"].includes(body.map) ? body.map : "valley";
    const id = randomUUID();
    const code = randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
    const token = randomUUID();
    const playerId = randomUUID();
    const [room] = await db.insert(rooms).values({ id, code, name: cleanName(body.name, "My squad"), map, mode: "ffa", capacity: [2, 4, 8].includes(Number(body.capacity)) ? Number(body.capacity) : 8, isPrivate: body.isPrivate === true }).returning();
    await db.insert(players).values({ id: playerId, token, roomId: id, name: cleanName(body.playerName) });
    return Response.json({ room: await roomView(room), token, playerId }, { status: 201 });
  } catch (error) { console.error("Create room:", error); return errorResponse("Could not create a room. Please try again.", 503); }
}
