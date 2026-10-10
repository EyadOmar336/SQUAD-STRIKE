"use client";

export type VoiceMode = "open" | "ptt";
export type VoiceStatus = "uninitialized" | "requesting" | "ready" | "muted" | "denied" | "unsupported";

export type VoiceListener = {
  onStatusChange?: (status: VoiceStatus) => void;
  onVolumeChange?: (level: number) => void;
  onSpeakingChange?: (speaking: boolean) => void;
};

export class SquadVoice {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private animationId: number | null = null;
  private listeners: Set<VoiceListener> = new Set();
  
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

  public async init(): Promise<boolean> {
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      this.status = "unsupported";
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
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

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

      this.updateTrackState();
      this.status = this.muted ? "muted" : "ready";
      this.notifyStatus();
      this.startMeter();
      this.playRadioChirp(true);
      return true;
    } catch (err: unknown) {
      console.warn("[SquadVoice] Microphone access error:", err);
      const name = (err as { name?: string })?.name;
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        this.status = "denied";
        this.errorText = "Microphone permission denied.";
      } else {
        this.status = "unsupported";
        this.errorText = "Could not connect to microphone.";
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
    this.updateTrackState();
    if (this.status === "ready" || this.status === "muted") {
      this.status = muted ? "muted" : "ready";
      this.notifyStatus();
    }
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
    this.isSpeaking = false;
    this.currentLevel = 0;
  }
}
