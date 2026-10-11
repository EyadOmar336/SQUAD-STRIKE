import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

// In-memory data store for standalone/ephemeral operation when DATABASE_URL is not set
const globalForMem = globalThis as typeof globalThis & {
  __strike_memory_rooms?: Map<string, any>;
  __strike_memory_players?: Map<string, any>;
  __strike_memory_scores?: Map<string, any>;
  __arenaNextJsPostgresqlPool?: Pool;
};

if (!globalForMem.__strike_memory_rooms) {
  globalForMem.__strike_memory_rooms = new Map([
    [
      "public-valley",
      {
        id: "public-valley",
        code: "VALLEY",
        name: "Valley Vanguard",
        map: "valley",
        mode: "ffa",
        capacity: 8,
        isPrivate: false,
        permanent: true,
        createdAt: new Date(),
      },
    ],
    [
      "public-desert",
      {
        id: "public-desert",
        code: "DUST01",
        name: "Desert Drifters",
        map: "desert",
        mode: "ffa",
        capacity: 8,
        isPrivate: false,
        permanent: true,
        createdAt: new Date(),
      },
    ],
    [
      "public-harbor",
      {
        id: "public-harbor",
        code: "HARBOR",
        name: "Night Shift",
        map: "harbor",
        mode: "ffa",
        capacity: 8,
        isPrivate: false,
        permanent: true,
        createdAt: new Date(),
      },
    ],
  ]);
}
if (!globalForMem.__strike_memory_players) {
  globalForMem.__strike_memory_players = new Map();
}
if (!globalForMem.__strike_memory_scores) {
  globalForMem.__strike_memory_scores = new Map();
}

const memRooms = globalForMem.__strike_memory_rooms;
const memPlayers = globalForMem.__strike_memory_players;
const memScores = globalForMem.__strike_memory_scores;

function extractSqlParams(node: any): any[] {
  const params: any[] = [];
  function walk(n: any) {
    if (n === null || n === undefined) return;
    if (typeof n === "string" || typeof n === "number" || typeof n === "boolean" || n instanceof Date) {
      if (typeof n === "string" && ["", " = ", " AND ", " OR ", " > ", " < ", ", "].includes(n)) return;
      params.push(n);
      return;
    }
    if (typeof n === "object") {
      if ("value" in n && !n.queryChunks && ("encoder" in n || !Array.isArray(n.value))) {
        walk(n.value);
      }
      if (Array.isArray(n.queryChunks)) {
        for (const chunk of n.queryChunks) {
          walk(chunk);
        }
      }
    }
  }
  walk(node);
  return params;
}

function getTableKey(table: any): "rooms" | "players" | "scores" | "unknown" {
  if (!table) return "unknown";
  const name =
    (typeof table === "object" && table !== null
      ? (table as any)[Symbol.for("drizzle:Name")] ||
        (table as any)._?.name ||
        (table as any).name
      : "") || "";
  if (name.includes("room")) return "rooms";
  if (name.includes("player")) return "players";
  if (name.includes("score")) return "scores";
  return "unknown";
}

function createMemoryDb() {
  const memoryDb: any = {
    execute: async () => [{ "?column?": 1 }],
    transaction: async (cb: (tx: any) => Promise<any>) => {
      return await cb(memoryDb);
    },
    select: (fields?: any) => {
      let currentTable: any = null;
      let currentCondition: any = null;
      let currentLimit: number | null = null;

      const builder: any = {
        from: (table: any) => {
          currentTable = table;
          return builder;
        },
        where: (condition: any) => {
          currentCondition = condition;
          return builder;
        },
        orderBy: () => builder,
        limit: (n: number) => {
          currentLimit = n;
          return builder;
        },
        for: () => builder,
        then: (resolve: (val: any) => void, reject?: (err: any) => void) => {
          try {
            const tableKey = getTableKey(currentTable);
            const params = currentCondition ? extractSqlParams(currentCondition) : [];

            if (tableKey === "rooms") {
              const codeOrId = params.find(
                (p) =>
                  typeof p === "string" &&
                  (p.length === 6 || p.startsWith("public-") || /^[0-9a-f-]{36}$/i.test(p))
              );
              if (codeOrId) {
                const found = [...memRooms.values()].find(
                  (r) =>
                    r.code.toUpperCase() === codeOrId.toUpperCase() ||
                    r.id === codeOrId
                );
                return resolve([found].filter(Boolean));
              }

              if (currentCondition) {
                const strParam = params.find(
                  (p) => typeof p === "string" && ![" = ", " AND ", " OR ", ""].includes(p.trim())
                );
                if (strParam) {
                  const found = [...memRooms.values()].find(
                    (r) =>
                      r.code.toUpperCase() === strParam.toUpperCase() ||
                      r.id === strParam
                  );
                  return resolve([found].filter(Boolean));
                }
              }

              const list = [...memRooms.values()]
                .filter((r) => !r.isPrivate)
                .sort((a, b) => {
                  if (a.permanent !== b.permanent) return a.permanent ? -1 : 1;
                  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
                });
              return resolve(currentLimit ? list.slice(0, currentLimit) : list);
            }

            if (tableKey === "players") {
              const isCount = fields && typeof fields === "object" && "value" in fields;
              if (isCount) {
                const roomId = params.find(
                  (p) => typeof p === "string" && (p.startsWith("public-") || memRooms.has(p) || /^[0-9a-f-]{36}$/i.test(p))
                );
                const count = [...memPlayers.values()].filter(
                  (p) =>
                    (!roomId || p.roomId === roomId) &&
                    Date.now() - new Date(p.updatedAt).getTime() < 20000
                ).length;
                return resolve([{ value: count }]);
              }

              // Check if finding player by token (e.g. /sync POST "me")
              const byToken = [...memPlayers.values()].find((p) => params.includes(p.token));
              if (byToken) {
                return resolve([byToken]);
              }

              // Check if finding player by id directly
              const stringParams = params.filter((p) => typeof p === "string");
              const byId = stringParams.find((p) => memPlayers.has(p));
              const roomId = stringParams.find(
                (p) => memRooms.has(p) || p.startsWith("public-")
              );

              if (byId && !roomId) {
                const p = memPlayers.get(byId);
                return resolve([p].filter(Boolean));
              }

              // If roomId is present: could be peers or room members
              if (roomId) {
                // Check if an excluded player id is in stringParams
                const excludeId = stringParams.find((p) => p !== roomId && memPlayers.has(p));
                const activeCutoff = Date.now() - 20000;
                const members = [...memPlayers.values()].filter(
                  (p) =>
                    p.roomId === roomId &&
                    (!excludeId || p.id !== excludeId) &&
                    Date.now() - new Date(p.updatedAt).getTime() < activeCutoff
                );
                return resolve(members);
              }

              if (byId) {
                const p = memPlayers.get(byId);
                return resolve([p].filter(Boolean));
              }

              return resolve([...memPlayers.values()]);
            }

            if (tableKey === "scores") {
              const list = [...memScores.values()].sort(
                (a, b) => (b.score || 0) - (a.score || 0)
              );
              return resolve(currentLimit ? list.slice(0, currentLimit) : list);
            }

            return resolve([]);
          } catch (e) {
            if (reject) reject(e);
            else resolve([]);
          }
        },
      };

      return builder;
    },
    insert: (table: any) => {
      let insertValues: any = null;
      const builder: any = {
        values: (val: any) => {
          insertValues = val;
          return builder;
        },
        returning: () => builder,
        onConflictDoNothing: () => builder,
        then: (resolve: (val: any) => void) => {
          const tableKey = getTableKey(table);
          const items = Array.isArray(insertValues) ? insertValues : [insertValues];
          const results: any[] = [];

          for (const item of items) {
            if (!item) continue;
            if (tableKey === "rooms") {
              const record = {
                capacity: 8,
                mode: "ffa",
                isPrivate: false,
                permanent: false,
                ...item,
                createdAt: item.createdAt || new Date(),
              };
              if (!memRooms.has(record.id)) {
                memRooms.set(record.id, record);
              }
              results.push(memRooms.get(record.id));
            } else if (tableKey === "players") {
              const record = {
                position: { x: 0, y: 1.7, z: 18, yaw: 0 },
                hp: 100,
                score: 0,
                kills: 0,
                shots: 0,
                grenades: 3,
                playing: false,
                ...item,
                updatedAt: item.updatedAt || new Date(),
              };
              memPlayers.set(record.id, record);
              results.push(record);
            } else if (tableKey === "scores") {
              const record = {
                ...item,
                createdAt: item.createdAt || new Date(),
              };
              if (!memScores.has(record.id)) {
                memScores.set(record.id, record);
              }
              results.push(record);
            }
          }
          return resolve(results);
        },
      };
      return builder;
    },
    update: (table: any) => {
      let setValues: any = {};
      let currentCondition: any = null;

      const builder: any = {
        set: (val: any) => {
          setValues = val;
          return builder;
        },
        where: (cond: any) => {
          currentCondition = cond;
          return builder;
        },
        then: (resolve: (val: any) => void) => {
          const tableKey = getTableKey(table);
          if (tableKey === "players") {
            const params = currentCondition ? extractSqlParams(currentCondition) : [];
            const targets = [...memPlayers.values()].filter(
              (p) => params.includes(p.id) || params.includes(p.token)
            );

            for (const target of targets) {
              for (const [key, val] of Object.entries(setValues)) {
                if (val && typeof val === "object" && (val as any).queryChunks) {
                  const bonus =
                    extractSqlParams(val).find((n) => typeof n === "number") ??
                    (key === "score" ? 100 : 1);
                  target[key] = (target[key] || 0) + bonus;
                } else {
                  target[key] = val;
                }
              }
              target.updatedAt = setValues.updatedAt || new Date();
            }
          }
          return resolve({ rowCount: 1 });
        },
      };
      return builder;
    },
    delete: (table: any) => {
      let currentCondition: any = null;
      const builder: any = {
        where: (cond: any) => {
          currentCondition = cond;
          return builder;
        },
        then: (resolve: (val: any) => void) => {
          const tableKey = getTableKey(table);
          if (tableKey === "players") {
            const params = currentCondition ? extractSqlParams(currentCondition) : [];
            for (const [id, p] of memPlayers.entries()) {
              if (params.includes(p.token) || params.includes(p.id)) {
                memPlayers.delete(id);
              }
            }
          }
          return resolve({ rowCount: 1 });
        },
      };
      return builder;
    },
  };

  return memoryDb;
}

let realPool: Pool | null = null;
let realDb: any = null;

if (databaseUrl) {
  try {
    realPool =
      globalForMem.__arenaNextJsPostgresqlPool ??
      new Pool({
        connectionString: databaseUrl,
      });

    if (process.env.NODE_ENV !== "production") {
      globalForMem.__arenaNextJsPostgresqlPool = realPool;
    }

    realDb = drizzle(realPool);
  } catch (err) {
    console.warn("[AI Studio] PostgreSQL initialization failed, using in-memory store:", err);
  }
}

export const pool =
  realPool ??
  (({
    query: async () => ({ rows: [] }),
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
    end: async () => {},
    on: () => {},
  } as unknown as Pool));

export interface StrikeDatabase {
  execute(query: any): Promise<any>;
  transaction<T>(cb: (tx: StrikeDatabase) => Promise<T>): Promise<T>;
  select(fields?: any): any;
  insert(table: any): any;
  update(table: any): any;
  delete(table: any): any;
}

const memoryDb: StrikeDatabase = createMemoryDb();

// Export db: use real Drizzle if DATABASE_URL is configured, otherwise seamless in-memory DB
export const db: StrikeDatabase = (realDb ?? memoryDb) as StrikeDatabase;
export const hasPersistentDatabase = realDb !== null;
