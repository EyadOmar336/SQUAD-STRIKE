export type VoiceSignalType = "offer" | "answer" | "ice";

export type VoiceSignalPayload = RTCSessionDescriptionInit | RTCIceCandidateInit;

export function isVoiceSignalType(value: unknown): value is VoiceSignalType {
  return value === "offer" || value === "answer" || value === "ice";
}

export function isAuthorizedVoiceMember(
  player: { token: unknown; roomId: unknown; updatedAt: Date | string } | null | undefined,
  token: string,
  roomId: string,
  now = Date.now(),
): boolean {
  if (!player || player.token !== token || player.roomId !== roomId) return false;
  const updatedAt = new Date(player.updatedAt).getTime();
  return Number.isFinite(updatedAt) && now - updatedAt <= 45000;
}

export function isValidVoiceSignalPayload(
  type: VoiceSignalType,
  payload: unknown,
): payload is VoiceSignalPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;

  const value = payload as Record<string, unknown>;
  if (type === "offer" || type === "answer") {
    return Object.keys(value).every((key) => key === "type" || key === "sdp") &&
      value.type === type && typeof value.sdp === "string" && value.sdp.length > 0 && value.sdp.length <= 16000;
  }

  return (
    Object.keys(value).every((key) => ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"].includes(key)) &&
    typeof value.candidate === "string" &&
    value.candidate.length <= 4096 &&
    (value.sdpMid === undefined || value.sdpMid === null || typeof value.sdpMid === "string") &&
    (typeof value.sdpMid !== "string" || value.sdpMid.length <= 256) &&
    (value.sdpMLineIndex === undefined || value.sdpMLineIndex === null ||
      (Number.isInteger(value.sdpMLineIndex) &&
        Number(value.sdpMLineIndex) >= 0 &&
        Number(value.sdpMLineIndex) <= 65535)) &&
    (value.usernameFragment === undefined ||
      (typeof value.usernameFragment === "string" && value.usernameFragment.length <= 256))
  );
}
