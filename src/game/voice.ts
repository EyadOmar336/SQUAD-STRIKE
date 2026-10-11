"use client";

export type VoiceMode = "open" | "ptt";
export type VoiceStatus = "uninitialized" | "requesting" | "ready" | "muted" | "denied" | "unsupported";

export type VoiceListener = {
  onStatusChange?: (status: VoiceStatus) => void;
  onVolumeChange?: (level: number) => void;
  onSpeakingChange?: (speaking: boolean) => void;
  onErrorChange?: (message: string) => void;
};

type VoiceSignalType = "offer" | "answer" | "ice";
type VoiceSignalMessage = { id: number; senderId: string; kind: VoiceSignalType; payload: RTCSessionDescriptionInit | RTCIceCandidateInit };
type PeerConnectionState = {
  connection: RTCPeerConnection;
  audio: HTMLAudioElement | null;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingRemoteAnswer: boolean;
  polite: boolean;
  localDescriptionSent: boolean;
  pendingLocalCandidates: RTCIceCandidateInit[];
  pendingRemoteCandidates: RTCIceCandidateInit[];
};

export class SquadVoice {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private animationId: number | null = null;
  private listeners: Set<VoiceListener> = new Set();
  private peerConnections = new Map<string, PeerConnectionState>();
  private roomSession: { code: string; token: string; playerId: string } | null = null;
  private signalCursor = 0;
  private signalTimer: number | null = null;
  private signalAbort: AbortController | null = null;
  private signalingPollActive = false;
  private iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
  private disposed = false;
  private readonly retryAudio = () => { void this.resumePlayback(); };
  
  public status: VoiceStatus = "uninitialized";
  public mode: VoiceMode = "open";
  public muted: boolean = false;
  public pttActive: boolean = false;
  public isSpeaking: boolean = false;
  public currentLevel: number = 0;
  public errorText: string = "";

  constructor(mode: VoiceMode = "open", defaultMuted: boolean = false) {
    this.mode = mode;
    this.muted = defaultMuted;
  }

  public subscribe(listener: VoiceListener): () => void {
    this.listeners.add(listener);
    listener.onStatusChange?.(this.status);
    listener.onSpeakingChange?.(this.isSpeaking);
    listener.onVolumeChange?.(this.currentLevel);
    listener.onErrorChange?.(this.errorText);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyStatus() {
    for (const l of this.listeners) l.onStatusChange?.(this.status);
  }

  private notifyVolume(level: number) {
    for (const l of this.listeners) l.onVolumeChange?.(level);
  }

  private notifySpeaking(speaking: boolean) {
    for (const l of this.listeners) l.onSpeakingChange?.(speaking);
  }

  private setError(message: string) {
    if (this.errorText === message) return;
    this.errorText = message;
    for (const listener of this.listeners) listener.onErrorChange?.(message);
  }

  public async init(): Promise<boolean> {
    if (this.disposed) return false;
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      this.status = "unsupported";
      this.setError(typeof window !== "undefined" && window.isSecureContext
        ? "This browser does not support microphone access."
        : "Voice chat requires a secure HTTPS connection.");
      this.notifyStatus();
      return false;
    }

    if (this.stream && this.stream.active) {
      this.status = this.muted ? "muted" : "ready";
      this.notifyStatus();
      return true;
    }

    this.status = "requesting";
    this.notifyStatus();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (this.disposed) {
        for (const track of stream.getTracks()) track.stop();
        return false;
      }
      this.stream = stream;

      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass) {
        this.audioContext = new AudioContextClass();
        const source = this.audioContext.createMediaStreamSource(this.stream);
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 256;
        this.analyser.smoothingTimeConstant = 0.4;
        source.connect(this.analyser);
      }

      this.status = this.muted ? "muted" : "ready";
      this.updateTrackState();
      this.updatePeerTracks();
      this.setError("");
      this.notifyStatus();
      this.startMeter();
      this.playRadioChirp(true);
      return true;
    } catch (err: unknown) {
      console.warn("[SquadVoice] Microphone access error:", err);
      if (this.stream) {
        for (const track of this.stream.getTracks()) track.stop();
        this.stream = null;
      }
      if (this.audioContext) {
        void this.audioContext.close().catch(() => {});
        this.audioContext = null;
      }
      const name = (err as { name?: string })?.name;
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        this.status = "denied";
        this.setError("Microphone permission was denied. Allow microphone access in your browser settings.");
      } else {
        this.status = "unsupported";
        this.setError("Could not connect to the microphone. Check your device and browser permissions.");
      }
      this.notifyStatus();
      return false;
    }
  }

  public toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  public setMuted(muted: boolean) {
    this.muted = muted;
    if (this.status === "ready" || this.status === "muted") {
      this.status = muted ? "muted" : "ready";
      this.notifyStatus();
    }
    this.updateTrackState();
    this.playRadioChirp(!muted);
  }

  public setMode(mode: VoiceMode) {
    this.mode = mode;
    this.updateTrackState();
  }

  public setPtt(active: boolean) {
    if (this.pttActive === active) return;
    this.pttActive = active;
    this.updateTrackState();
    this.playRadioChirp(active);
  }

  public isTransmitting(): boolean {
    if (this.muted) return false;
    if (this.status !== "ready") return false;
    if (this.mode === "ptt") return this.pttActive;
    return true;
  }

  public connectRoom(code: string, token: string, playerId: string) {
    if (this.roomSession?.code === code && this.roomSession.token === token && this.roomSession.playerId === playerId) return;
    this.disconnectRoom();
    this.roomSession = { code, token, playerId };
    this.signalAbort = new AbortController();
    void this.pollRoom();
    this.signalTimer = window.setInterval(() => { void this.pollRoom(); }, 1000);
  }

  private async pollRoom() {
    const session = this.roomSession;
    const abort = this.signalAbort;
    if (!session || !abort || abort.signal.aborted || this.signalingPollActive) return;
    this.signalingPollActive = true;
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(session.code)}/voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abort.signal,
        body: JSON.stringify({ action: "poll", token: session.token, cursor: this.signalCursor }),
      });
      const data = await response.json() as { error?: string; peers?: string[]; messages?: VoiceSignalMessage[]; iceServers?: RTCIceServer[] };
      if (!response.ok) throw new Error(data.error || "Voice signaling is unavailable.");
      if (this.roomSession !== session || abort.signal.aborted) return;
      if (this.errorText.startsWith("Voice signaling")) this.setError("");
      if (Array.isArray(data.iceServers) && data.iceServers.length) this.iceServers = data.iceServers;
      const peers = Array.isArray(data.peers) ? data.peers.filter((id): id is string => typeof id === "string" && id !== session.playerId) : [];
      this.reconcilePeers(peers);
      for (const message of Array.isArray(data.messages) ? data.messages : []) {
        if (Number.isSafeInteger(message.id)) this.signalCursor = Math.max(this.signalCursor, message.id);
        if (message && typeof message.senderId === "string") await this.handleSignal(message);
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        const detail = error instanceof Error ? error.message : "Connection interrupted.";
        this.setError(`Voice signaling: ${detail}`);
      }
    } finally {
      this.signalingPollActive = false;
    }
  }

  private reconcilePeers(peerIds: string[]) {
    const current = new Set(peerIds);
    for (const [id, state] of this.peerConnections) {
      if (!current.has(id)) {
        state.connection.close();
        this.removeRemoteAudio(state.audio);
        this.peerConnections.delete(id);
      }
    }
    for (const id of current) {
      if (!this.peerConnections.has(id)) this.createPeer(id);
    }
  }

  private createPeer(peerId: string) {
    const session = this.roomSession;
    if (!session) return;
    const connection = new RTCPeerConnection({ iceServers: this.iceServers });
    const state: PeerConnectionState = {
      connection,
      audio: null,
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      polite: session.playerId.localeCompare(peerId) > 0,
      localDescriptionSent: false,
      pendingLocalCandidates: [],
      pendingRemoteCandidates: [],
    };
    this.peerConnections.set(peerId, state);
    if (this.stream) {
      for (const track of this.stream.getAudioTracks()) connection.addTrack(track, this.stream);
    } else {
      connection.addTransceiver("audio", { direction: "recvonly" });
    }
    connection.onicecandidate = (event) => {
      if (!event.candidate) return;
      const candidate = event.candidate.toJSON();
      if (!state.localDescriptionSent) state.pendingLocalCandidates.push(candidate);
      else void this.sendSignal(peerId, "ice", candidate);
    };
    connection.ontrack = (event) => this.attachRemoteAudio(state, event);
    connection.onnegotiationneeded = async () => {
      try {
        state.makingOffer = true;
        state.localDescriptionSent = false;
        await connection.setLocalDescription();
        const local = connection.localDescription;
        if (local && (local.type === "offer" || local.type === "answer")) {
          state.localDescriptionSent = await this.sendSignal(peerId, local.type, { type: local.type, sdp: local.sdp || "" });
          if (state.localDescriptionSent) await this.sendPendingCandidates(peerId, state);
        }
      } catch (error) {
        if (connection.signalingState !== "closed") console.warn("[SquadVoice] Negotiation failed:", error);
      } finally {
        state.makingOffer = false;
      }
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "failed") {
        try { connection.restartIce(); } catch { /* The next presence update can create a fresh peer. */ }
      }
    };
  }

  private updatePeerTracks() {
    if (!this.stream) return;
    for (const state of this.peerConnections.values()) {
      const connection = state.connection;
      for (const track of this.stream.getAudioTracks()) {
        const transceiver = connection.getTransceivers().find((item) => item.receiver.track.kind === track.kind);
        if (transceiver) {
          transceiver.direction = "sendrecv";
          void transceiver.sender.replaceTrack(track);
        } else {
          connection.addTrack(track, this.stream);
        }
      }
    }
  }

  private async sendPendingCandidates(peerId: string, state: PeerConnectionState) {
    const candidates = state.pendingLocalCandidates.splice(0);
    for (const candidate of candidates) {
      if (!(await this.sendSignal(peerId, "ice", candidate))) {
        state.pendingLocalCandidates.unshift(candidate, ...candidates.slice(candidates.indexOf(candidate) + 1));
        state.localDescriptionSent = false;
        return;
      }
    }
  }

  private attachRemoteAudio(state: PeerConnectionState, event: RTCTrackEvent) {
    if (state.audio) return;
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "");
    audio.setAttribute("aria-label", "Squad voice chat");
    audio.style.position = "fixed";
    audio.style.width = "1px";
    audio.style.height = "1px";
    audio.style.opacity = "0.01";
    audio.style.pointerEvents = "none";
    audio.srcObject = event.streams[0] || new MediaStream([event.track]);
    state.audio = audio;
    document.body.append(audio);
    window.addEventListener("pointerdown", this.retryAudio);
    void this.playRemoteAudio(audio);
  }

  private removeRemoteAudio(audio: HTMLAudioElement | null) {
    if (!audio) return;
    audio.pause();
    audio.srcObject = null;
    audio.remove();
  }

  private async playRemoteAudio(audio: HTMLAudioElement) {
    try {
      await audio.play();
      if (this.errorText.startsWith("Remote audio")) this.setError("");
    } catch {
      this.setError("Remote audio is blocked. Tap the screen to enable squad voice playback.");
    }
  }

  public async resumePlayback() {
    if (this.audioContext?.state === "suspended") {
      try { await this.audioContext.resume(); } catch { /* Playback may still work without the meter context. */ }
    }
    for (const state of this.peerConnections.values()) {
      if (state.audio) await this.playRemoteAudio(state.audio);
    }
  }

  private async handleSignal(message: VoiceSignalMessage) {
    const state = this.peerConnections.get(message.senderId);
    if (!state || !["offer", "answer", "ice"].includes(message.kind)) return;
    const connection = state.connection;
    try {
      if (message.kind === "ice") {
        if (state.ignoreOffer) return;
        const candidate = message.payload as RTCIceCandidateInit;
        if (!connection.remoteDescription) state.pendingRemoteCandidates.push(candidate);
        else await connection.addIceCandidate(candidate);
        return;
      }
      const description = message.payload as RTCSessionDescriptionInit;
      const readyForOffer = !state.makingOffer && (connection.signalingState === "stable" || state.settingRemoteAnswer);
      const offerCollision = description.type === "offer" && !readyForOffer;
      state.ignoreOffer = !state.polite && offerCollision;
      if (state.ignoreOffer) return;
      state.settingRemoteAnswer = description.type === "answer";
      if (offerCollision && state.polite) await connection.setLocalDescription({ type: "rollback" });
      await connection.setRemoteDescription(description);
      state.settingRemoteAnswer = false;
      for (const candidate of state.pendingRemoteCandidates.splice(0)) {
        await connection.addIceCandidate(candidate);
      }
      if (description.type === "offer") {
        state.localDescriptionSent = false;
        await connection.setLocalDescription(await connection.createAnswer());
        const local = connection.localDescription;
        if (local) {
          state.localDescriptionSent = await this.sendSignal(message.senderId, "answer", { type: "answer", sdp: local.sdp || "" });
          if (state.localDescriptionSent) await this.sendPendingCandidates(message.senderId, state);
        }
      }
    } catch (error) {
      state.settingRemoteAnswer = false;
      if (!state.ignoreOffer) console.warn("[SquadVoice] Could not apply signaling message:", error);
    }
  }

  private async sendSignal(recipientId: string, type: VoiceSignalType, payload: RTCSessionDescriptionInit | RTCIceCandidateInit): Promise<boolean> {
    const session = this.roomSession;
    const abort = this.signalAbort;
    if (!session || !abort || abort.signal.aborted) return false;
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(session.code)}/voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abort.signal,
        body: JSON.stringify({ action: "send", token: session.token, recipientId, type, payload }),
      });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error || "Could not send voice signal.");
      }
      return true;
    } catch (error) {
      if (!abort.signal.aborted) this.setError(`Voice signaling: ${error instanceof Error ? error.message : "Connection interrupted."}`);
      return false;
    }
  }

  private disconnectRoom() {
    if (this.signalTimer !== null) window.clearInterval(this.signalTimer);
    this.signalTimer = null;
    this.signalAbort?.abort();
    this.signalAbort = null;
    for (const state of this.peerConnections.values()) {
      state.connection.close();
      this.removeRemoteAudio(state.audio);
    }
    this.peerConnections.clear();
    window.removeEventListener("pointerdown", this.retryAudio);
    this.roomSession = null;
    this.signalCursor = 0;
    this.signalingPollActive = false;
  }

  private updateTrackState() {
    if (!this.stream) return;
    const active = this.isTransmitting();
    for (const track of this.stream.getAudioTracks()) {
      track.enabled = active;
    }
    if (!active) {
      this.isSpeaking = false;
      this.notifySpeaking(false);
      this.currentLevel = 0;
      this.notifyVolume(0);
    }
  }

  private startMeter() {
    if (this.animationId !== null) return;
    const buffer = new Uint8Array(this.analyser ? this.analyser.frequencyBinCount : 0);

    const loop = () => {
      if (!this.analyser || !this.isTransmitting()) {
        this.currentLevel = 0;
        this.notifyVolume(0);
        if (this.isSpeaking) {
          this.isSpeaking = false;
          this.notifySpeaking(false);
        }
        this.animationId = requestAnimationFrame(loop);
        return;
      }

      this.analyser.getByteFrequencyData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) {
        sum += buffer[i];
      }
      const avg = sum / (buffer.length || 1);
      const normalized = Math.min(1, avg / 128); // 0 to 1
      this.currentLevel = normalized;
      this.notifyVolume(normalized);

      const speaking = normalized > 0.08;
      if (speaking !== this.isSpeaking) {
        this.isSpeaking = speaking;
        this.notifySpeaking(speaking);
      }

      this.animationId = requestAnimationFrame(loop);
    };

    this.animationId = requestAnimationFrame(loop);
  }

  private playRadioChirp(on: boolean) {
    if (!this.audioContext || this.audioContext.state === "suspended") return;
    try {
      const now = this.audioContext.currentTime;
      const osc = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();

      osc.type = "sine";
      if (on) {
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(1320, now + 0.04);
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
        osc.connect(gain);
        gain.connect(this.audioContext.destination);
        osc.start(now);
        osc.stop(now + 0.05);
      } else {
        osc.frequency.setValueAtTime(1100, now);
        osc.frequency.exponentialRampToValueAtTime(550, now + 0.04);
        gain.gain.setValueAtTime(0.04, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
        osc.connect(gain);
        gain.connect(this.audioContext.destination);
        osc.start(now);
        osc.stop(now + 0.05);
      }
    } catch {
      // AudioContext unavailable or disposed
    }
  }

  public dispose() {
    this.disposed = true;
    this.disconnectRoom();
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.audioContext) {
      try {
        this.audioContext.close().catch(() => {});
      } catch {}
      this.audioContext = null;
    }
    this.listeners.clear();
    this.status = "uninitialized";
    this.setError("");
    this.isSpeaking = false;
    this.currentLevel = 0;
  }
}
