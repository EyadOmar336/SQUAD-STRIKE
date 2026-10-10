import type { RoomSession } from "@/lib/game-types";

/**
 * Squad voice chat over WebRTC.
 *
 * - Signaling (SDP offers/answers + ICE candidates) travels through the room's
 *   voice endpoint, which relays messages between players of the same room.
 * - Audio is peer-to-peer: each pair of players gets its own RTCPeerConnection.
 * - Remote voices play through dedicated <audio> elements, completely separate
 *   from the game's CombatAudio sounds, so game audio is never replaced or muted.
 * - A tiny Web Audio analyser measures levels for the "who is speaking" indicator
 *   only; it never routes voice through the game audio graph.
 */

export type VoiceStatus = "idle" | "requesting" | "live" | "muted" | "denied" | "unavailable" | "error";
export type VoicePeerState = "new" | "connecting" | "connected" | "failed";
export type VoicePeerInfo = { id: string; name: string; state: VoicePeerState; speaking: boolean };
export type VoiceSnapshot = { status: VoiceStatus; muted: boolean; localSpeaking: boolean; connected: number; peers: VoicePeerInfo[] };

type SignalKind = "offer" | "answer" | "candidate" | "bye";
type OutboundSignal = { to: string; kind: SignalKind; payload?: unknown };
type InboundSignal = { from: string; kind: string; payload?: ({ sdp?: RTCSessionDescriptionInit } & Partial<RTCIceCandidateInit>) | null };
type RosterPeer = { id: string; name: string };

type PeerLink = {
  id: string;
  name: string;
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  stream: MediaStream | null;
  source: MediaStreamAudioSourceNode | null;
  analyser: AnalyserNode | null;
  pending: RTCIceCandidateInit[];
  state: VoicePeerState;
  speaking: boolean;
  bornAt: number;
  lastSeen: number;
};

const POLL_MS = 1100;
const LEVEL_MS = 100;
const SPEAK_ON = 0.03;
const SPEAK_OFF = 0.012;
const SPEAK_HOLD_MS = 380;
const LINK_STALL_MS = 14000;
const LINK_ABSENT_MS = 15000;

function rtcConfiguration(): RTCConfiguration {
  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL;
  return {
    iceServers: [
      { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
      ...(turnUrl ? [{ urls: turnUrl, username: process.env.NEXT_PUBLIC_TURN_USERNAME || undefined, credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL || undefined }] : []),
    ],
  };
}

export class SquadVoice {
  private session: RoomSession;
  private notify: (snapshot: VoiceSnapshot) => void;
  private status: VoiceStatus = "idle";
  private muted = false;
  private localSpeaking = false;
  private localStream: MediaStream | null = null;
  private peers = new Map<string, PeerLink>();
  private outbound: OutboundSignal[] = [];
  private analysis: AudioContext | null = null;
  private localSource: MediaStreamAudioSourceNode | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private levelBuffer = new Uint8Array(1024);
  private speakingState = new Map<string, { active: boolean; silentSince: number }>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private disposed = false;

  constructor(session: RoomSession, notify: (snapshot: VoiceSnapshot) => void) {
    this.session = session;
    this.notify = notify;
    window.addEventListener("pagehide", this.pageHide);
    // Diagnostics handle for field debugging and automated tests.
    (window as unknown as { __squadVoice?: SquadVoice }).__squadVoice = this;
  }

  /** Per-peer WebRTC transport stats (bytes actually carried). */
  async transportStats(): Promise<{ peer: string; state: VoicePeerState; bytesReceived: number; bytesSent: number }[]> {
    const out = [];
    for (const link of this.peers.values()) {
      let bytesReceived = 0, bytesSent = 0;
      try {
        const stats = await link.pc.getStats();
        stats.forEach((report) => {
          if (report.type === "inbound-rtp" && report.kind === "audio") bytesReceived += Number(report.bytesReceived || 0);
          if (report.type === "outbound-rtp" && report.kind === "audio") bytesSent += Number(report.bytesSent || 0);
        });
      } catch { /* Stats unavailable. */ }
      out.push({ peer: link.id, state: link.state, bytesReceived, bytesSent });
    }
    return out;
  }

  snapshot(): VoiceSnapshot {
    return {
      status: this.status,
      muted: this.muted,
      localSpeaking: this.localSpeaking,
      connected: [...this.peers.values()].filter((peer) => peer.state === "connected").length,
      peers: [...this.peers.values()].map((peer) => ({ id: peer.id, name: peer.name, state: peer.state, speaking: peer.speaking })),
    };
  }

  private lastSignature = "";
  private emit() {
    if (this.disposed) return;
    const snapshot = this.snapshot();
    const signature = `${snapshot.status}|${snapshot.muted}|${snapshot.localSpeaking}|${snapshot.peers.map((peer) => `${peer.id}:${peer.state}:${peer.speaking ? 1 : 0}`).join(",")}`;
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.notify(snapshot);
  }

  private ensureAnalysis() {
    if (this.analysis) return this.analysis;
    try {
      const AudioCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) return null;
      this.analysis = new AudioCtor();
    } catch { this.analysis = null; }
    return this.analysis;
  }

  private watchLevel(stream: MediaStream): { source: MediaStreamAudioSourceNode | null; analyser: AnalyserNode | null } {
    const context = this.ensureAnalysis();
    if (!context) return { source: null, analyser: null };
    try {
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.15;
      source.connect(analyser);
      if (context.state === "suspended") context.resume().catch(() => {});
      return { source, analyser };
    } catch { return { source: null, analyser: null }; }
  }

  private level(analyser: AnalyserNode | null): number {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(this.levelBuffer);
    let sum = 0;
    for (let i = 0; i < this.levelBuffer.length; i++) { const value = (this.levelBuffer[i] - 128) / 128; sum += value * value; }
    return Math.sqrt(sum / this.levelBuffer.length);
  }

  /** Enable the microphone and join the room's voice mesh. */
  async enable(): Promise<void> {
    if (this.disposed || this.status === "requesting" || this.status === "live" || this.status === "muted") return;
    if (!navigator.mediaDevices?.getUserMedia) { this.status = "unavailable"; this.emit(); return; }
    this.status = "requesting"; this.emit();
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (error) {
      const name = (error as DOMException)?.name || "";
      this.status = name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotFoundError" || name === "OverconstrainedError" ? "unavailable" : "error";
      this.emit();
      return;
    }
    if (this.disposed) { this.stopLocal(); return; }
    this.muted = false;
    this.status = "live";
    const watched = this.watchLevel(this.localStream);
    this.localSource = watched.source; this.localAnalyser = watched.analyser;
    // Track ending (OS-level mic revoke) drops us back to idle cleanly.
    for (const track of this.localStream.getAudioTracks()) track.addEventListener("ended", () => this.disable());
    this.pollTimer = setInterval(this.tick, POLL_MS);
    this.levelTimer = setInterval(this.readLevels, LEVEL_MS);
    this.emit();
    void this.tick();
  }

  setMuted(muted: boolean) {
    if (!this.localStream || (this.status !== "live" && this.status !== "muted")) return;
    this.muted = muted;
    for (const track of this.localStream.getAudioTracks()) track.enabled = !muted;
    if (muted) this.localSpeaking = false;
    this.status = muted ? "muted" : "live";
    this.emit();
  }

  /** Turn voice off: say goodbye to peers, release the microphone. */
  disable() {
    if (this.status === "idle") return;
    this.sendSignals([...this.peers.keys()].map((to) => ({ to, kind: "bye" as const })), true);
    for (const peer of this.peers.values()) this.teardownLink(peer);
    this.peers.clear();
    this.speakingState.clear();
    this.stopLocal();
    this.status = "idle";
    this.muted = false;
    this.localSpeaking = false;
    this.emit();
  }

  dispose() {
    if (this.disposed) return;
    this.disable();
    this.disposed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.pollTimer = this.levelTimer = null;
    try { this.analysis?.close().catch(() => {}); } catch { /* Already closed. */ }
    this.analysis = null;
    window.removeEventListener("pagehide", this.pageHide);
  }

  private pageHide = () => {
    if (this.status === "live" || this.status === "muted") {
      this.sendSignals([...this.peers.keys()].map((to) => ({ to, kind: "bye" as const })), true);
    }
  };

  private stopLocal() {
    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    this.localStream = null;
    try { this.localSource?.disconnect(); } catch { /* Detached. */ }
    this.localSource = null; this.localAnalyser = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.pollTimer = this.levelTimer = null;
    this.outbound = [];
  }

  private sendSignals(signals: OutboundSignal[], keepalive = false) {
    if (signals.length === 0) return;
    if (keepalive) {
      // Best-effort on teardown: never awaited, survives page exit with keepalive.
      fetch(`/api/rooms/${this.session.room.code}/voice`, {
        method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true,
        body: JSON.stringify({ token: this.session.token, signals }),
      }).catch(() => {});
      return;
    }
    this.outbound.push(...signals);
  }

  private tick = async () => {
    if (this.disposed || this.polling || (this.status !== "live" && this.status !== "muted")) return;
    this.polling = true;
    try {
      const signals = this.outbound.splice(0, this.outbound.length);
      const response = await fetch(`/api/rooms/${this.session.room.code}/voice`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: this.session.token, signals }),
      });
      if (!response.ok) throw new Error("Voice channel unavailable");
      const data: { peers: RosterPeer[]; signals: InboundSignal[] } = await response.json();
      if (this.disposed) return;
      this.reconcile(data.peers);
      for (const signal of data.signals) { try { await this.handleSignal(signal); } catch { /* Skip broken signal. */ } }
      this.emit();
    } catch { /* Transient network error: retry on the next tick. */ }
    finally { this.polling = false; }
  };

  private reconcile(roster: RosterPeer[]) {
    const now = Date.now();
    const present = new Map(roster.map((peer) => [peer.id, peer]));
    for (const link of [...this.peers.values()]) {
      if (present.has(link.id)) link.lastSeen = now;
      const stalled = link.state !== "connected" && now - link.bornAt > LINK_STALL_MS;
      const absent = !present.has(link.id) && now - link.lastSeen > LINK_ABSENT_MS;
      if (stalled || absent) {
        this.teardownLink(link);
        this.peers.delete(link.id);
      }
    }
    // Create links (and offers, for the deterministic caller) for new voice peers.
    for (const peer of roster) if (!this.peers.has(peer.id)) this.createLink(peer, now);
  }

  private createLink(peer: RosterPeer, now: number) {
    const pc = new RTCPeerConnection(rtcConfiguration());
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.hidden = true;
    audio.dataset.voiceAudio = "true";
    audio.dataset.peer = peer.id;
    audio.style.display = "none";
    document.body.appendChild(audio);
    const link: PeerLink = {
      id: peer.id, name: peer.name, pc, audio, stream: null, source: null, analyser: null,
      pending: [], state: "new", speaking: false, bornAt: now, lastSeen: now,
    };
    this.peers.set(peer.id, link);
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      if (this.localStream) pc.addTrack(track, this.localStream);
    }
    pc.onicecandidate = (event) => { if (event.candidate) this.sendSignals([{ to: link.id, kind: "candidate", payload: event.candidate.toJSON() }]); };
    const settle = () => {
      const states = [pc.connectionState, pc.iceConnectionState];
      if (states.includes("connected") || states.includes("completed")) link.state = "connected";
      else if (states.includes("failed") || states.includes("closed")) link.state = "failed";
      else link.state = "connecting";
      this.emit();
    };
    pc.onconnectionstatechange = settle;
    pc.oniceconnectionstatechange = settle;
    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      link.stream = stream;
      // Receiving media is the strongest proof the call is up.
      link.state = "connected";
      const watched = this.watchLevel(stream);
      link.source = watched.source; link.analyser = watched.analyser;
      audio.srcObject = stream;
      audio.play().catch(() => {});
      this.emit();
    };
    // Deterministic caller: the player with the smaller id creates the offer,
    // which prevents both sides from offering at the same time (glare).
    if (this.session.playerId < link.id) void this.negotiate(link);
  }

  private async negotiate(link: PeerLink) {
    try {
      const offer = await link.pc.createOffer();
      if (link.pc.signalingState !== "stable") return;
      await link.pc.setLocalDescription(offer);
      if (link.pc.localDescription) this.sendSignals([{ to: link.id, kind: "offer", payload: { sdp: link.pc.localDescription } }]);
    } catch { link.state = "failed"; this.emit(); }
  }

  private async handleSignal(signal: InboundSignal) {
    const link = this.peers.get(signal.from);
    if (!link) return;
    if (signal.kind === "bye") { this.teardownLink(link); this.peers.delete(link.id); this.emit(); return; }
    if (signal.kind === "offer") {
      const sdp = signal.payload?.sdp;
      if (!sdp) return;
      if (link.pc.signalingState === "have-local-offer") {
        // Should not happen with deterministic callers; accept the remote offer politely.
        try { await link.pc.setLocalDescription({ type: "rollback" }); } catch { /* Continue. */ }
      }
      await link.pc.setRemoteDescription(sdp);
      await this.flushPending(link);
      const answer = await link.pc.createAnswer();
      await link.pc.setLocalDescription(answer);
      if (link.pc.localDescription) this.sendSignals([{ to: link.id, kind: "answer", payload: { sdp: link.pc.localDescription } }]);
      return;
    }
    if (signal.kind === "answer") {
      const sdp = signal.payload?.sdp;
      if (!sdp || link.pc.signalingState !== "have-local-offer") return;
      await link.pc.setRemoteDescription(sdp);
      await this.flushPending(link);
      return;
    }
    if (signal.kind === "candidate") {
      // The payload is a full RTCIceCandidateInit ({ candidate: "candidate:...", ... }).
      const init = signal.payload as RTCIceCandidateInit | undefined;
      if (!init?.candidate) return;
      if (link.pc.remoteDescription) { try { await link.pc.addIceCandidate(init); } catch { /* Skip unusable candidate. */ } }
      else link.pending.push(init);
    }
  }

  private async flushPending(link: PeerLink) {
    const pending = link.pending.splice(0, link.pending.length);
    for (const candidate of pending) { try { await link.pc.addIceCandidate(candidate); } catch { /* Skip. */ } }
  }

  private teardownLink(link: PeerLink) {
    try {
      link.pc.onicecandidate = null; link.pc.ontrack = null;
      link.pc.onconnectionstatechange = null; link.pc.oniceconnectionstatechange = null;
      link.pc.close();
    } catch { /* Already closed. */ }
    try { link.source?.disconnect(); } catch { /* Detached. */ }
    link.audio.srcObject = null;
    link.audio.remove();
    link.speaking = false;
    this.speakingState.delete(link.id);
  }

  private readLevels = () => {
    if (this.status !== "live" && this.status !== "muted") return;
    const now = performance.now();
    let changed = false;
    const localSpeaking = this.updateSpeaking("local", this.muted ? 0 : this.level(this.localAnalyser), now);
    if (localSpeaking !== this.localSpeaking) { this.localSpeaking = localSpeaking; changed = true; }
    for (const link of this.peers.values()) {
      const speaking = this.updateSpeaking(link.id, this.level(link.analyser), now);
      if (speaking !== link.speaking) { link.speaking = speaking; changed = true; }
    }
    if (changed) this.emit();
  }

  /** Hysteresis + hold so the indicator is steady instead of flickering. */
  private updateSpeaking(key: string, level: number, now: number): boolean {
    let entry = this.speakingState.get(key);
    if (!entry) { entry = { active: false, silentSince: 0 }; this.speakingState.set(key, entry); }
    if (level >= SPEAK_ON) { entry.active = true; entry.silentSince = 0; }
    else if (entry.active && level < SPEAK_OFF) {
      if (!entry.silentSince) entry.silentSince = now;
      if (now - entry.silentSince > SPEAK_HOLD_MS) { entry.active = false; entry.silentSince = 0; }
    }
    return entry.active;
  }
}
