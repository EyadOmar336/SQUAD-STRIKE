export class CombatAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private ambient: AudioBufferSourceNode | null = null;
  private enabled: boolean;
  private volume: number;
  private paused = false;
  constructor(enabled: boolean, volume: number) { this.enabled = enabled; this.volume = volume; }
  unlock() {
    try {
      if (!this.context) {
        const Audio = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!Audio) return;
        this.context = new Audio();
        this.master = this.context.createGain(); this.master.gain.value = this.enabled ? this.volume : 0; this.master.connect(this.context.destination);
        this.noise = this.context.createBuffer(1, this.context.sampleRate * 2, this.context.sampleRate);
        const data = this.noise.getChannelData(0); for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        this.ambient = this.context.createBufferSource(); this.ambient.buffer = this.noise; this.ambient.loop = true;
        const filter = this.context.createBiquadFilter(); filter.type = "lowpass"; filter.frequency.value = 450;
        const gain = this.context.createGain(); gain.gain.value = 0.026;
        this.ambient.connect(filter); filter.connect(gain); gain.connect(this.master); this.ambient.start();
      }
      if (this.context.state === "suspended") this.context.resume().catch(() => {});
    } catch { /* Browsers without Web Audio remain fully playable. */ }
  }
  setEnabled(enabled: boolean) { this.enabled = enabled; this.applyVolume(); if (enabled) this.unlock(); }
  pause(paused: boolean) { this.paused = paused; this.applyVolume(); }
  private applyVolume() { if (this.master && this.context) this.master.gain.setTargetAtTime(this.enabled && !this.paused ? this.volume : 0, this.context.currentTime, 0.025); }
  private tone(from: number, to: number, duration: number, volume: number, type: OscillatorType = "sine", delay = 0) {
    if (!this.context || !this.master || !this.enabled) return;
    const now = this.context.currentTime + delay; const osc = this.context.createOscillator(); const gain = this.context.createGain();
    osc.type = type; osc.frequency.setValueAtTime(from, now); osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), now + duration);
    gain.gain.setValueAtTime(volume, now); gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(gain); gain.connect(this.master); osc.start(now); osc.stop(now + duration + 0.01);
  }
  private burst(duration: number, frequency: number, volume: number, type: BiquadFilterType = "lowpass") {
    if (!this.context || !this.master || !this.noise || !this.enabled) return;
    const now = this.context.currentTime; const source = this.context.createBufferSource(); source.buffer = this.noise;
    const filter = this.context.createBiquadFilter(); filter.type = type; filter.frequency.value = frequency;
    const gain = this.context.createGain(); gain.gain.setValueAtTime(volume, now); gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    source.connect(filter); filter.connect(gain); gain.connect(this.master); source.start(now, Math.random()); source.stop(now + duration + 0.01);
  }
  shot() { this.burst(0.105, 3800, 0.55, "bandpass"); this.tone(145, 38, 0.095, 0.45, "triangle"); this.tone(1200, 190, 0.026, 0.065, "square"); }
  distantShot() { this.burst(0.095, 800, 0.14); this.tone(90, 30, 0.1, 0.08, "triangle"); }
  hit() { this.tone(980, 620, 0.06, 0.17, "sine"); }
  kill() { this.tone(570, 680, 0.1, 0.15); this.tone(900, 1250, 0.16, 0.13, "sine", 0.08); }
  reload() { this.burst(0.08, 4500, 0.15, "highpass"); this.tone(190, 100, 0.075, 0.08, "square"); }
  step() { this.burst(0.055, 450, 0.12); }
  jump() { this.burst(0.11, 850, 0.11); }
  hurt() { this.burst(0.16, 700, 0.2); this.tone(105, 36, 0.18, 0.22, "triangle"); }
  explosion() { this.burst(0.7, 700, 0.7); this.tone(115, 20, 0.65, 0.65, "triangle"); }
  empty() { this.tone(200, 110, 0.03, 0.08, "square"); }
  finish(won: boolean) { if (won) { this.tone(440, 440, 0.25, 0.18); this.tone(554, 554, 0.3, 0.18, "sine", 0.2); this.tone(659, 880, 0.7, 0.16, "sine", 0.4); } else { this.tone(260, 90, 0.9, 0.18, "triangle"); } }
  dispose() { try { this.ambient?.stop(); this.context?.close().catch(() => {}); } catch { /* Already closed. */ } this.context = null; }
}
