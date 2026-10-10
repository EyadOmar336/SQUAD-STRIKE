export type MapId = "valley" | "desert" | "harbor";
export type GameSettings = { sound: boolean; volume: number; sensitivity: number; quality: "auto" | "high" | "low" };
export type Room = { id: string; code: string; name: string; map: MapId; mode: string; capacity: number; isPrivate: boolean; playerCount: number; permanent: boolean };
export type Peer = { id: string; name: string; position: { x: number; y: number; z: number; yaw: number }; hp: number; score: number; kills: number; shots: number; playing: boolean };
export type RoomSession = { room: Room; token: string; playerId: string };
export type GameConfig = { map: MapId; name: string; settings: GameSettings; session?: RoomSession };
export type GameResult = { id: string; name: string; score: number; kills: number; map: MapId; duration: number; won: boolean; date: string };
export type HudData = { hp: number; ammo: number; score: number; kills: number; time: number; wave: number; reloading: boolean; grenades: number; combo: number; peers: number; fps: number; network: string };
export const MAPS: { id: MapId; name: string; image: string; region: string; description: string; accent: string }[] = [
  { id: "valley", name: "Verdant Valley", image: "/images/verdant-valley.jpg", region: "ALPINE FRONTIER", description: "Pine forests. Fortified outposts. Endless possibilities.", accent: "#bce979" },
  { id: "desert", name: "Dust Basin", image: "/images/dust-basin.jpg", region: "SOUTHERN BADLANDS", description: "Keep your cool in a sun-scorched canyon outpost.", accent: "#e2b782" },
  { id: "harbor", name: "Iron Harbor", image: "/images/iron-harbor.jpg", region: "NORTH COAST", description: "Tight corners. Shipping lanes. Nowhere to hide.", accent: "#90b7d2" },
];
export const DEFAULT_SETTINGS: GameSettings = { sound: true, volume: 0.45, sensitivity: 1, quality: "auto" };
export function readLocalScores(): GameResult[] {
  try { const data = JSON.parse(localStorage.getItem("squadstrike-scores") || "[]"); return Array.isArray(data) ? data.filter((s) => s && typeof s.score === "number").slice(0, 20) : []; } catch { return []; }
}
