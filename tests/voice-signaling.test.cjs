const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "../src/lib/voice-signaling.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleExports = {};
new Function("exports", compiled)(moduleExports);
const { isAuthorizedVoiceMember, isValidVoiceSignalPayload } = moduleExports;

const now = Date.now();
const member = { token: "room-session-token", roomId: "room-1", updatedAt: new Date(now) };

test("voice signaling authorization binds the session to a fresh room member", () => {
  assert.equal(isAuthorizedVoiceMember(member, "room-session-token", "room-1", now), true);
  assert.equal(isAuthorizedVoiceMember(member, "other-token", "room-1", now), false);
  assert.equal(isAuthorizedVoiceMember(member, "room-session-token", "room-2", now), false);
  assert.equal(isAuthorizedVoiceMember({ ...member, updatedAt: new Date(now - 46000) }, "room-session-token", "room-1", now), false);
  assert.equal(isAuthorizedVoiceMember(undefined, "room-session-token", "room-1", now), false);
});

test("offers and answers require matching, bounded SDP descriptions", () => {
  assert.equal(isValidVoiceSignalPayload("offer", { type: "offer", sdp: "v=0" }), true);
  assert.equal(isValidVoiceSignalPayload("answer", { type: "offer", sdp: "v=0" }), false);
  assert.equal(isValidVoiceSignalPayload("answer", { type: "answer", sdp: "" }), false);
  assert.equal(isValidVoiceSignalPayload("offer", { type: "offer", sdp: "x".repeat(16001) }), false);
  assert.equal(isValidVoiceSignalPayload("offer", { type: "offer", sdp: "v=0", extra: true }), false);
  assert.equal(isValidVoiceSignalPayload("offer", null), false);
});

test("ICE candidates require valid bounded candidate metadata", () => {
  assert.equal(isValidVoiceSignalPayload("ice", { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 }), true);
  assert.equal(isValidVoiceSignalPayload("ice", { candidate: "", sdpMid: null, sdpMLineIndex: null }), true);
  assert.equal(isValidVoiceSignalPayload("ice", { candidate: "candidate:1" }), true);
  assert.equal(isValidVoiceSignalPayload("ice", { candidate: "x".repeat(4097), sdpMid: null, sdpMLineIndex: null }), false);
  assert.equal(isValidVoiceSignalPayload("ice", { candidate: "candidate:1", sdpMid: 2, sdpMLineIndex: -1 }), false);
});
