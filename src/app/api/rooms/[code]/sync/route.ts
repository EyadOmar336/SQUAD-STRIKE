import { db } from "@/db";
import { rooms, players } from "@/db/schema";
import { and, eq, gt, ne, sql } from "drizzle-orm";
import { errorResponse, publicPlayer } from "@/lib/rooms";

const finite = (n: unknown, min: number, max: number, fallback = 0) => typeof n === "number" && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await params;
    const body = await request.json();
    if (typeof body.token !== "string") return errorResponse("Session required.", 401);
    const [room] = await db.select().from(rooms).where(eq(rooms.code, code.toUpperCase()));
    if (!room) return errorResponse("Room no longer exists.", 404);
    const [me] = await db.select().from(players).where(and(eq(players.token, body.token), eq(players.roomId, room.id)));
    if (!me) return errorResponse("Please rejoin the room.", 401);
    const position = body.position ? { x: finite(body.position.x, -115, 115), y: finite(body.position.y, 0, 7, 1.7), z: finite(body.position.z, -115, 115), yaw: finite(body.position.yaw, -100000, 100000) } : me.position;
    await db.update(players).set({ position, updatedAt: new Date(), playing: body.playing === true, shots: finite(body.shots, 0, 1000000, me.shots), ...(body.restart === true ? { hp: 100, score: 0, kills: 0, grenades: 3 } : {}) }).where(eq(players.id, me.id));
    const hitId = typeof body.hit === "string" ? body.hit : null;
    if (hitId && hitId !== me.id && me.hp > 0 && (!me.lastShotAt || Date.now() - me.lastShotAt.getTime() > 150)) {
      await db.transaction(async (tx) => {
        const [target] = await tx.select().from(players).where(and(eq(players.id, hitId), eq(players.roomId, room.id), gt(players.hp, 0), gt(players.updatedAt, new Date(Date.now() - 5000)))).for("update");
        if (!target) return;
        const dx = target.position.x - position.x; const dz = target.position.z - position.z;
        const distance = Math.hypot(dx, dz);
        const alignment = distance > 0 ? (-Math.sin(position.yaw) * dx - Math.cos(position.yaw) * dz) / distance : 1;
        if (distance > 100 || alignment < 0.84) return;
        const hp = Math.max(0, target.hp - 34);
        await tx.update(players).set({ hp }).where(eq(players.id, target.id));
        await tx.update(players).set({ lastShotAt: new Date(), ...(hp === 0 ? { score: sql`${players.score} + 100`, kills: sql`${players.kills} + 1` } : {}) }).where(eq(players.id, me.id));
      });
    }
    if (body.blast && me.hp > 0 && me.grenades > 0) {
      const blast = { x: finite(body.blast.x, -115, 115), y: finite(body.blast.y, 0, 15), z: finite(body.blast.z, -115, 115) };
      if (Math.hypot(blast.x - position.x, blast.z - position.z) < 38) {
        await db.transaction(async (tx) => {
          const [attacker] = await tx.select().from(players).where(eq(players.id, me.id)).for("update");
          if (!attacker || attacker.grenades <= 0 || (attacker.lastGrenadeAt && Date.now() - attacker.lastGrenadeAt.getTime() < 800)) return;
          const targets = await tx.select().from(players).where(and(eq(players.roomId, room.id), ne(players.id, me.id), eq(players.playing, true), gt(players.hp, 0), gt(players.updatedAt, new Date(Date.now() - 5000)))).for("update");
          let eliminations = 0;
          for (const target of targets) {
            const distance = Math.hypot(target.position.x - blast.x, target.position.y - blast.y, target.position.z - blast.z);
            if (distance > 10) continue;
            const hp = Math.max(0, target.hp - (distance < 5 ? 100 : 60));
            await tx.update(players).set({ hp }).where(eq(players.id, target.id));
            if (hp === 0) eliminations++;
          }
          await tx.update(players).set({ grenades: attacker.grenades - 1, lastGrenadeAt: new Date(), score: sql`${players.score} + ${eliminations * 100}`, kills: sql`${players.kills} + ${eliminations}` }).where(eq(players.id, me.id));
        });
      }
    }
    const [self] = await db.select(publicPlayer).from(players).where(eq(players.id, me.id));
    const peers = await db.select(publicPlayer).from(players).where(and(eq(players.roomId, room.id), ne(players.id, me.id), gt(players.updatedAt, new Date(Date.now() - 15000))));
    return Response.json({ self, peers, serverTime: Date.now() });
  } catch (error) { console.error("Room sync:", error); return errorResponse("Connection interrupted.", 503); }
}
