import { pgTable, text, integer, boolean, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const rooms = pgTable("strike_rooms", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  map: text("map").notNull().default("valley"),
  mode: text("mode").notNull().default("ffa"),
  capacity: integer("capacity").notNull().default(8),
  isPrivate: boolean("is_private").notNull().default(false),
  permanent: boolean("permanent").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const players = pgTable("strike_players", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  roomId: text("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  position: jsonb("position").$type<{ x: number; y: number; z: number; yaw: number }>().notNull().default({ x: 0, y: 1.7, z: 18, yaw: 0 }),
  hp: integer("hp").notNull().default(100),
  score: integer("score").notNull().default(0),
  kills: integer("kills").notNull().default(0),
  shots: integer("shots").notNull().default(0),
  grenades: integer("grenades").notNull().default(3),
  lastGrenadeAt: timestamp("last_grenade_at", { withTimezone: true }),
  playing: boolean("playing").notNull().default(false),
  lastShotAt: timestamp("last_shot_at", { withTimezone: true }),
  // Last time this player polled the voice signaling channel (voice chat presence).
  voiceAt: timestamp("voice_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("strike_players_room_idx").on(t.roomId, t.updatedAt)]);

// WebRTC signaling relay: SDP offers/answers and ICE candidates between room members.
export const voiceSignals = pgTable("strike_voice_signals", {
  id: text("id").primaryKey(),
  roomId: text("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
  fromPlayer: text("from_player").notNull(),
  toPlayer: text("to_player").notNull(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").$type<unknown>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("strike_voice_signals_to_idx").on(t.toPlayer, t.createdAt)]);

export const scores = pgTable("strike_scores", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  score: integer("score").notNull(),
  kills: integer("kills").notNull(),
  map: text("map").notNull(),
  duration: integer("duration").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
