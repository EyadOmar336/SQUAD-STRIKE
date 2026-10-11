"use client";

import { useCallback, useEffect, useRef, useState, type RefObject, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowRight, ArrowUp, Bomb, ChevronLeft, Copy, Crosshair, Heart, Home, Maximize, Mic, MicOff, Pause, Play, Radio, RotateCcw, Shield, ShieldCheck, Signal, SlidersHorizontal, Skull, Swords, Target, Trophy, Users, Volume2, VolumeX, Zap } from "lucide-react";
import type { ArenaEngine } from "@/game/engine";
import { SquadVoice, type VoiceMode, type VoiceStatus } from "@/game/voice";
import { MAPS, readLocalScores, type GameConfig, type GameResult, type HudData } from "@/lib/game-types";
import "./battle.css";

const initialHud: HudData = { hp: 100, ammo: 30, score: 0, kills: 0, time: 180, wave: 1, reloading: false, grenades: 3, combo: 0, peers: 1, fps: 60, network: "SOLO" };
type Props = { config: GameConfig; ar: boolean; onResult: (result: GameResult) => void; onExit: () => void };
/** UI-only input adapter: the engine's movement and combat rules stay unchanged. */
function Joystick({ engine, label }: { engine: RefObject<ArenaEngine | null>; label: string }) {
  const zone = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; radius: number } | null>(null);

  const reset = useCallback(() => {
    const active = drag.current;
    drag.current = null;
    engine.current?.moveTouch(0, 0);
    if (zone.current) {
      zone.current.dataset.active = "false";
      if (active && zone.current.hasPointerCapture(active.id)) zone.current.releasePointerCapture(active.id);
    }
    if (base.current) {
      for (const name of ["--stick-x", "--stick-y", "--knob-x", "--knob-y"]) base.current.style.removeProperty(name);
    }
  }, [engine]);

  useEffect(() => {
    const onHidden = () => { if (document.hidden) reset(); };
    window.addEventListener("blur", reset);
    window.addEventListener("resize", reset);
    screen.orientation?.addEventListener("change", reset);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      reset();
      window.removeEventListener("blur", reset);
      window.removeEventListener("resize", reset);
      screen.orientation?.removeEventListener("change", reset);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [reset]);

  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault(); event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const diameter = base.current?.clientWidth || 112;
    const half = diameter / 2;
    const x = Math.max(half, Math.min(rect.width - half, event.clientX - rect.left));
    const y = Math.max(half, Math.min(rect.height - half, event.clientY - rect.top));
    base.current?.style.setProperty("--stick-x", `${x}px`);
    base.current?.style.setProperty("--stick-y", `${y}px`);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, radius: diameter * 0.36 };
    event.currentTarget.dataset.active = "true";
    event.currentTarget.setPointerCapture(event.pointerId);
    engine.current?.engage();
    engine.current?.moveTouch(0, 0);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.id !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    const dx = event.clientX - active.x, dy = event.clientY - active.y;
    const distance = Math.hypot(dx, dy);
    const travel = Math.min(distance, active.radius);
    const x = distance > 0 ? dx / distance : 0, y = distance > 0 ? dy / distance : 0;
    // A radial dead zone removes thumb jitter without making diagonals stick.
    const strength = Math.max(0, (travel / active.radius - 0.09) / 0.91);
    base.current?.style.setProperty("--knob-x", `${x * travel}px`);
    base.current?.style.setProperty("--knob-y", `${y * travel}px`);
    engine.current?.moveTouch(x * strength, y * strength);
  };
  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === event.pointerId) reset();
  };

  return <div ref={zone} className="touch-joystick" role="application" aria-label="Movement joystick" data-active="false"
    onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
    <div ref={base} className="joystick-base"><div className="joystick-grid"/><span className="joystick-knob"/></div>
    <span className="joystick-label">{label}</span>
  </div>;
}

export default function Battle({ config, ar, onResult, onExit }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const minimap = useRef<HTMLCanvasElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const engine = useRef<ArenaEngine | null>(null);
  const onResultRef = useRef(onResult); onResultRef.current = onResult;
  const [ready, setReady] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const [paused, setPaused] = useState(false);
  const [result, setResult] = useState<GameResult | null>(null);
  const [hud, setHud] = useState<HudData>(initialHud);
  const [error, setError] = useState("");
  const [sound, setSound] = useState(config.settings.sound);
  const [aiming, setAiming] = useState(false);
  const [touchDevice, setTouchDevice] = useState(false);
  const [hit, setHit] = useState(0);
  const [damage, setDamage] = useState(0);
  const [kill, setKill] = useState<{ id: number; text: string; points: number } | null>(null);
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);
  const [records, setRecords] = useState<GameResult[]>([]);
  const lookPointer = useRef<{ id: number; x: number; y: number; target: HTMLElement } | null>(null);
  const firePointer = useRef<{ id: number; x: number; y: number; target: HTMLElement } | null>(null);
  const [touchSensitivity, setTouchSensitivity] = useState(0.9);
  const touchSensitivityRef = useRef(0.9);
  const voiceRef = useRef<SquadVoice | null>(null);
  const [micStatus, setMicStatus] = useState<VoiceStatus>("uninitialized");
  const [voiceError, setVoiceError] = useState("");
  const [micMuted, setMicMuted] = useState(config.settings.micMuted ?? false);
  const [micMode, setMicMode] = useState<VoiceMode>(config.settings.micMode || "open");
  const [micTransmitting, setMicTransmitting] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micSpeaking, setMicSpeaking] = useState(false);
  const pttPointerActive = useRef(false);

  const resetTouch = useCallback(() => {
    for (const pointer of [lookPointer, firePointer]) {
      const active = pointer.current; pointer.current = null;
      if (active) {
        active.target.dataset.held = "false";
        if (active.target.hasPointerCapture(active.id)) active.target.releasePointerCapture(active.id);
      }
    }
    engine.current?.fire(false);
    engine.current?.moveTouch(0, 0);
    engine.current?.aim(false);
    setAiming(false);
  }, []);

  const tr = useCallback((en: string, arabic: string) => ar ? arabic : en, [ar]);

  useEffect(() => {
    const voice = new SquadVoice(config.settings.micMode || "open", config.settings.micMuted ?? false);
    voiceRef.current = voice;

    const unsub = voice.subscribe({
      onStatusChange: (st) => setMicStatus(st),
      onErrorChange: (message) => setVoiceError(message),
      onSpeakingChange: (spk) => {
        setMicSpeaking(spk);
        setMicTransmitting(voice.isTransmitting() && spk);
      },
      onVolumeChange: (lvl) => {
        setMicLevel(lvl);
        setMicTransmitting(voice.isTransmitting() && lvl > 0.08);
      },
    });

    if (config.session) {
      voice.connectRoom(config.session.room.code, config.session.token, config.session.playerId);
    }
    if (config.settings.micEnabled !== false) {
      voice.init().then((ok) => {
        if (ok) {
          setNotice({ id: performance.now(), text: tr("SQUAD COMMS ACTIVE · PRESS 'V' TO TALK", "الميكروفون مفعّل · اضغط V للتحدث") });
        }
      });
    }

    return () => {
      unsub();
      voice.dispose();
      voiceRef.current = null;
    };
  }, [config.settings.micEnabled, config.settings.micMode, config.settings.micMuted, config.session, tr]);

  const toggleMic = useCallback(async () => {
    await voiceRef.current?.resumePlayback();
    if (!voiceRef.current || micStatus === "uninitialized" || micStatus === "denied") {
      const voice = voiceRef.current || new SquadVoice(micMode, false);
      voiceRef.current = voice;
      const ok = await voice.init();
      if (ok) {
        voice.setMuted(false);
        setMicMuted(false);
        setNotice({ id: performance.now(), text: tr("MICROPHONE CONNECTED", "تم تفعيل الميكروفون") });
      } else {
        setNotice({ id: performance.now(), text: tr("MIC PERMISSION REQUIRED", "يرجى السماح بالوصول للميكروفون") });
      }
      return;
    }
    const next = voiceRef.current.toggleMute();
    setMicMuted(next);
    setNotice({ id: performance.now(), text: next ? tr("MIC MUTED", "تم كتم الميكروفون") : tr("MIC ACTIVE", "الميكروفون مفعّل") });
  }, [micStatus, micMode, tr]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === "KeyV" && !e.repeat) {
        voiceRef.current?.setPtt(true);
        setMicTransmitting(voiceRef.current?.isTransmitting() ?? false);
      } else if (e.code === "KeyM" && !e.repeat) {
        toggleMic();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "KeyV") {
        voiceRef.current?.setPtt(false);
        setMicTransmitting(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [toggleMic]);

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem("squadstrike-touch-sensitivity") || 0.9);
      if (Number.isFinite(saved)) {
        const value = Math.max(0.45, Math.min(1.6, saved));
        setTouchSensitivity(value); touchSensitivityRef.current = value;
      }
    } catch { /* Touch controls also work when storage is disabled. */ }
    const onHidden = () => { if (document.hidden) resetTouch(); };
    window.addEventListener("resize", resetTouch);
    window.addEventListener("blur", resetTouch);
    screen.orientation?.addEventListener("change", resetTouch);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("resize", resetTouch);
      window.removeEventListener("blur", resetTouch);
      screen.orientation?.removeEventListener("change", resetTouch);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [resetTouch]);
  const map = MAPS.find(m => m.id === config.map)!;

  useEffect(() => {
    let cancelled = false; let instance: ArenaEngine | null = null;
    const overflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    setTouchDevice(matchMedia("(pointer: coarse)").matches);
    import("@/game/engine").then(({ ArenaEngine }) => {
      if (cancelled || !host.current || !minimap.current) return;
      try {
        instance = new ArenaEngine(host.current, minimap.current, config, {
          hud: data => { if (!cancelled) setHud(data); },
          pause: value => { if (!cancelled) { setPaused(value); setAiming(false); } },
          engage: () => { if (!cancelled) setEngaged(true); },
          finish: match => { if (!cancelled) { onResultRef.current(match); setResult(match); setPaused(false); setRecords(readLocalScores()); } },
          feedback: (type, text, points) => {
            if (cancelled) return;
            if (type === "hit") setHit(n => n + 1);
            else if (type === "damage") setDamage(n => n + 1);
            else if (type === "kill") setKill({ id: performance.now(), text, points: points || 100 });
            else setNotice({ id: performance.now(), text });
          },
        });
        engine.current = instance; setReady(true);
      } catch (e) { console.error("Renderer initialization:", e); setError("This device couldn’t start WebGL. Enable hardware acceleration or try a current version of Chrome, Edge, Firefox, or Safari."); }
    }).catch(() => { if (!cancelled) setError("The battlefield could not load. Check your connection and try again."); });
    return () => { cancelled = true; instance?.dispose(); engine.current = null; document.body.style.overflow = overflow; };
  }, [config]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), 4500); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { if (!kill) return; const timer = setTimeout(() => setKill(null), 1900); return () => clearTimeout(timer); }, [kill]);
  useEffect(() => {
    if (!result) return;
    const handle = (event: KeyboardEvent) => { if (event.code === "Enter") { event.preventDefault(); setResult(null); setKill(null); setNotice(null); engine.current?.restart(); } };
    window.addEventListener("keydown", handle); return () => window.removeEventListener("keydown", handle);
  }, [result]);
  function restart() { resetTouch(); setResult(null); setPaused(false); setKill(null); setNotice(null); setAiming(false); engine.current?.restart(); }
  function toggleSound() { const next = !sound; setSound(next); engine.current?.toggleSound(next); }
  async function fullscreen() { try { if (document.fullscreenElement) await document.exitFullscreen(); else await shell.current?.requestFullscreen(); } catch { setNotice({ id: performance.now(), text: tr("FULLSCREEN IS UNAVAILABLE IN THIS BROWSER", "ملء الشاشة غير متاح في هذا المتصفح") }); } }
  async function copyCode() { try { await navigator.clipboard.writeText(`${location.origin}${location.pathname}?room=${config.session?.room.code}`); setNotice({ id: performance.now(), text: tr("SQUAD INVITE COPIED", "تم نسخ دعوة الفريق") }); } catch { setNotice({ id: performance.now(), text: `ROOM CODE: ${config.session?.room.code}` }); } }
  const clock = `${Math.floor(Math.ceil(hud.time) / 60).toString().padStart(2, "0")}:${(Math.ceil(hud.time) % 60).toString().padStart(2, "0")}`;
  const blocked = paused || !!result;
  useEffect(() => { if (blocked) resetTouch(); }, [blocked, resetTouch]);

  function adjustTouchSensitivity(value: number) {
    setTouchSensitivity(value); touchSensitivityRef.current = value;
    try { localStorage.setItem("squadstrike-touch-sensitivity", String(value)); } catch { /* Optional storage. */ }
  }
  function dragToLook(event: ReactPointerEvent<HTMLElement>, pointer: typeof lookPointer) {
    const active = pointer.current;
    if (!active || active.id !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    const dx = Math.max(-75, Math.min(75, event.clientX - active.x));
    const dy = Math.max(-75, Math.min(75, event.clientY - active.y));
    active.x = event.clientX; active.y = event.clientY;
    engine.current?.look(dx * touchSensitivityRef.current, dy * touchSensitivityRef.current * 0.85);
  }
  function beginLook(event: ReactPointerEvent<HTMLDivElement>) {
    if (lookPointer.current || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault(); event.stopPropagation();
    lookPointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, target: event.currentTarget };
    event.currentTarget.setPointerCapture(event.pointerId);
    engine.current?.engage();
  }
  function beginFire(event: ReactPointerEvent<HTMLButtonElement>) {
    if (firePointer.current || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault(); event.stopPropagation();
    firePointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, target: event.currentTarget };
    event.currentTarget.dataset.held = "true";
    event.currentTarget.setPointerCapture(event.pointerId);
    engine.current?.fire(true);
  }
  function endGesture(event: ReactPointerEvent<HTMLElement>, pointer: typeof lookPointer, firing = false) {
    const active = pointer.current;
    if (!active || active.id !== event.pointerId) return;
    pointer.current = null;
    active.target.dataset.held = "false";
    if (active.target.hasPointerCapture(active.id)) active.target.releasePointerCapture(active.id);
    if (firing) engine.current?.fire(false);
  }

  return <div ref={shell} className={`battle-shell ${touchDevice ? "is-touch" : ""} ${aiming ? "is-aiming" : ""} ${ar ? "battle-arabic" : ""}`} dir="ltr">
    <div ref={host} className="battle-canvas"/>
    <div className="game-vignette"/>
    {damage > 0 && !blocked && <div key={`damage-${damage}`} className="damage-vignette"/>}
    {hud.hp < 30 && !blocked && <div className="critical-vignette"/>}

    <div className="battle-hud" aria-hidden={blocked} inert={blocked}>
      <header className="hud-top">
        <div className="hud-operation" data-hud="room">
          <span className="operation-icon"><ShieldCheck size={21}/></span>
          <div className="hud-operation-text">
            <span className="operation-type">{config.session ? tr("LIVE MULTIPLAYER", "قتال جماعي مباشر") : tr("SOLO OPERATION", "عملية فردية")}</span>
            <h1 title={config.session?.room.name || map.name}><bdi>{config.session?.room.name || map.name}</bdi></h1>
            <span className="hud-room-meta"><bdi>{config.session ? map.name : config.name}</bdi>{config.session && <span className="hud-room-code">#{config.session.room.code}</span>}</span>
          </div>
        </div>
        <div className="hud-match" data-hud="timer">
          <span className="match-mode">{config.session && hud.peers > 1 ? tr("FREE FOR ALL", "قتال حر") : `${tr("WAVE", "الموجة")} ${String(hud.wave).padStart(2, "0")}`}</span>
          <span className={`match-clock ${hud.time < 30 ? "urgent" : ""}`}>{clock}</span><span className="match-clock-line"/>
        </div>
        <div className="hud-tools" data-hud="tools">
          <div className="hud-tool-buttons">
            <button
              className={`hud-icon mic-button ${micMuted ? "is-muted" : micTransmitting ? "is-transmitting" : "is-active"}`}
              aria-label={micMuted ? "Unmute microphone" : "Mute microphone"}
              title={voiceError || (micMuted ? tr("Microphone muted (V to push-to-talk)", "الميكروفون مكتوم (V للتحدث)") : tr("Microphone on (V to push-to-talk)", "الميكروفون مفعّل (V للتحدث)"))}
              onClick={() => { if (micMode !== "ptt") void toggleMic(); }}
              onPointerDown={async event => {
                if (micMode === "ptt") {
                  event.preventDefault();
                  const button = event.currentTarget;
                  const pointerId = event.pointerId;
                  button.setPointerCapture(pointerId);
                  pttPointerActive.current = true;
                  let voice = voiceRef.current;
                  if (!voice || micStatus === "uninitialized" || micStatus === "denied") {
                    voice = voice || new SquadVoice(micMode, false);
                    voiceRef.current = voice;
                    if (!(await voice.init()) || !pttPointerActive.current) return;
                  }
                  voice.setPtt(true);
                  setMicTransmitting(voice.isTransmitting());
                }
              }}
              onPointerUp={event => {
                if (micMode === "ptt") {
                  event.preventDefault();
                  pttPointerActive.current = false;
                  voiceRef.current?.setPtt(false);
                  setMicTransmitting(false);
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                }
              }}
              onPointerCancel={() => {
                if (micMode === "ptt") {
                  pttPointerActive.current = false;
                  voiceRef.current?.setPtt(false);
                  setMicTransmitting(false);
                }
              }}
            >
              {micMuted ? <MicOff size={18}/> : <Mic size={18}/>}
            </button>
            <button className="hud-icon" aria-label={sound ? "Mute sound" : "Enable sound"} title={tr("Sound", "الصوت")} onClick={toggleSound}>{sound ? <Volume2 size={18}/> : <VolumeX size={18}/>}</button>
            <button className="hud-icon fullscreen-button" aria-label="Toggle fullscreen" title={tr("Fullscreen", "ملء الشاشة")} onClick={fullscreen}><Maximize size={18}/></button>
            <button className="hud-icon pause-button" aria-label="Pause game" title={tr("Pause", "إيقاف مؤقت")} onClick={() => { resetTouch(); engine.current?.setPaused(true); }}><Pause size={19}/></button>
          </div>
          <span className="game-connection"><Signal size={12}/><span>{hud.network === "SOLO" ? "LOCAL" : hud.network}</span><small>{hud.fps} FPS</small></span>
        </div>
        <div className="minimap-panel" data-hud="radar">
          <div className="minimap-frame"><canvas ref={minimap} width={160} height={160} aria-label="Tactical radar"/><span className="radar-sweep"/></div>
          <div className="minimap-caption"><Radio size={10}/><span>{tr("RECON", "الرادار")}</span><span className="status-dot"/></div>
        </div>
        <div className="hud-score" data-hud="score">
          <span className="score-label">{tr("SCORE", "النقاط")}</span><b>{String(hud.score).padStart(4, "0")}</b>
          <small className="score-eliminations" aria-label={`${hud.kills} eliminations`}><Crosshair size={13}/><span>{hud.kills} <span className="stat-description">{tr("ELIMS", "إقصاء")}</span></span></small>
          <small className="score-players"><Users size={13}/><span>{config.session ? `${hud.peers} / ${config.session.room.capacity}` : tr("SOLO", "فردي")}</span></small>
        </div>
      </header>
      <div className="compass" aria-hidden="true"><span>W</span><i/><span>NW</span><i/><strong>N</strong><i/><span>NE</span><i/><span>E</span><span className="compass-pointer"/></div>
      {!blocked && (micTransmitting || micSpeaking) && (
        <div className="squad-radio-hud">
          <div className="radio-pulse"/>
          <Radio size={13}/>
          <span>{tr("SQUAD RADIO · TRANSMITTING", "الراديو الميداني · جارٍ البث")}</span>
          <div className="radio-waves">
            <span style={{ height: `${Math.max(4, Math.round(micLevel * 18))}px` }}/>
            <span style={{ height: `${Math.max(6, Math.round(micLevel * 24))}px` }}/>
            <span style={{ height: `${Math.max(4, Math.round(micLevel * 18))}px` }}/>
            <span style={{ height: `${Math.max(2, Math.round(micLevel * 12))}px` }}/>
          </div>
        </div>
      )}
      {!blocked && <div className={`crosshair ${hud.reloading ? "reloading" : ""}`}><i/><i/><i/><i/><span/>{hit > 0 && <div key={`hit-${hit}`} className="hit-marker"><i/><i/><i/><i/></div>}</div>}
      {kill && !blocked && <div key={kill.id} className="kill-confirmation"><div><Crosshair size={15}/><b>+{kill.points}</b><span>XP</span></div><span>{kill.text}</span>{hud.combo > 1 && <small>{hud.combo}× {tr("COMBO", "متتالية")}</small>}</div>}
      {(voiceError || notice) && !blocked && <div className="field-notice" key={voiceError || notice?.id} role="status"><Radio size={13}/><span>{voiceError || notice?.text}</span></div>}
      <div className="hud-bottom">
        <section className={`health-panel resource-panel ${hud.hp < 30 ? "low-health" : ""}`} data-hud="health" aria-label={`${tr("Health", "الصحة")} ${hud.hp} / 100`}>
          <div className="resource-heading"><Heart size={16}/><span>{tr("HEALTH", "الصحة")}</span></div>
          <div className="health-reading"><strong>{hud.hp}</strong><span>/ 100</span></div>
          <div className="health-track" role="meter" aria-label={tr("Health", "الصحة")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={hud.hp}><span style={{ width: `${hud.hp}%` }}/></div>
        </section>
        {/* The current engine has no armor resource. Show an honest equipment state, not fabricated HP. */}
        <section className="armor-panel resource-panel" data-hud="armor" aria-label={tr("Armor: unavailable in this game mode", "الدرع: غير متاح في هذا النمط")} title={tr("This game mode does not provide a separate armor value.", "هذا النمط لا يوفر قيمة مستقلة للدرع.")}>
          <div className="resource-heading"><Shield size={16}/><span>{tr("ARMOR", "الدرع")}</span></div>
          <strong aria-hidden="true">—</strong><small>{tr("UNAVAILABLE", "غير متاح")}</small>
        </section>
        <div className="desktop-controls"><span><kbd>W A S D</kbd>{tr("MOVE", "تحرك")}</span><span><kbd>V</kbd>{tr("VOICE PTT", "مايك")}</span><span><kbd>M</kbd>{tr("MUTE", "كتم")}</span><span><kbd>R</kbd>{tr("RELOAD", "لقّم")}</span><span><kbd>G</kbd>{tr("FRAG", "قنبلة")}</span><span><kbd>SPACE</kbd>{tr("JUMP", "اقفز")}</span><span><kbd>ESC</kbd>{tr("PAUSE", "توقف")}</span></div>
        <section className={`ammo-panel resource-panel ${hud.reloading ? "is-reloading" : ""}`} data-hud="ammo" aria-label={`${tr("Ammunition", "الذخيرة")} ${hud.ammo}`}>
          <div className="weapon-label"><span>M4A1</span><span>{hud.reloading ? tr("RELOADING", "تلقيم") : tr("AUTO", "تلقائي")}</span></div>
          <div className="ammo-count"><strong className={hud.ammo < 8 ? "low-ammo" : ""}>{String(hud.ammo).padStart(2, "0")}</strong><span>/ ∞</span></div>
          <span className="grenade-count"><Bomb size={13}/><b>{hud.grenades}</b><span>{tr("FRAGS", "قنابل")}</span></span>
          {hud.reloading && <div className="reload-progress" aria-label={tr("Reloading", "جارٍ التلقيم")}><span/></div>}
        </section>
      </div>
    </div>

    {touchDevice && ready && !blocked && <div className="touch-controls" onContextMenu={event => event.preventDefault()}>
      <div className="touch-look-zone" aria-label="Swipe to look around" onPointerDown={beginLook} onPointerMove={event => dragToLook(event, lookPointer)}
        onPointerUp={event => endGesture(event, lookPointer)} onPointerCancel={event => endGesture(event, lookPointer)} onLostPointerCapture={event => endGesture(event, lookPointer)}/>
      <Joystick engine={engine} label={tr("MOVE", "تحرّك")}/>
      <div className="touch-action-pad">
        <button className="touch-fire" aria-label="Hold to fire" data-held="false" onPointerDown={beginFire} onPointerMove={event => dragToLook(event, firePointer)}
          onPointerUp={event => endGesture(event, firePointer, true)} onPointerCancel={event => endGesture(event, firePointer, true)} onLostPointerCapture={event => endGesture(event, firePointer, true)}>
          <Crosshair size={31}/><span>FIRE</span><small>{tr("DRAG TO AIM", "اسحب للتصويب")}</small>
        </button>
        <button className="touch-action touch-reload" aria-label="Reload weapon" onPointerDown={event => { event.preventDefault(); event.stopPropagation(); engine.current?.reload(); }}><RotateCcw size={22}/><span>{tr("RELOAD", "تلقيم")}</span></button>
        <button className="touch-action touch-jump" aria-label="Jump" onPointerDown={event => { event.preventDefault(); event.stopPropagation(); engine.current?.jump(); }}><ArrowUp size={24}/><span>{tr("JUMP", "قفز")}</span></button>
        <button className="touch-action touch-grenade" aria-label="Throw grenade" disabled={hud.grenades === 0} onPointerDown={event => { event.preventDefault(); event.stopPropagation(); engine.current?.grenade(); }}><Bomb size={21}/><span>{tr("FRAG", "قنبلة")} {hud.grenades}</span></button>
        <button className={`touch-action touch-aim ${aiming ? "active" : ""}`} aria-label="Toggle aim down sights" aria-pressed={aiming} onPointerDown={event => { event.preventDefault(); event.stopPropagation(); engine.current?.aim(!aiming); setAiming(!aiming); }}><Target size={23}/><span>{tr("AIM", "تصويب")}</span></button>
      </div>
    </div>}

    {ready && !engaged && !blocked && <div className="engage-panel"><span className="eyebrow"><span className="status-dot"/>{tr("BOOTS ON THE GROUND", "وصلت إلى ساحة المعركة")}</span><h2>{tr("YOU’RE UP, OPERATOR.", "حان دورك أيها المقاتل.")}</h2><p>{touchDevice ? tr("Left thumb to move. Hold FIRE and drag it to aim while shooting.", "حرّك بإبهامك الأيسر. اضغط FIRE واسحب إصبعك للتصويب أثناء الإطلاق.") : tr("WASD to move · Mouse to look · Click to fire", "WASD للتحرك · الماوس للنظر · انقر لإطلاق النار")}</p><button className="button button-primary" autoFocus onClick={() => engine.current?.engage()}><Swords size={18}/>{tr("ENGAGE", "ابدأ القتال")}<ArrowRight size={18}/></button><small>{tr("Eliminate hostiles. Stay moving. Survive 3 minutes.", "أقصِ الخصوم. تحرك باستمرار. اصمد ٣ دقائق.")}</small></div>}

    {!ready && !error && <div className="battle-loading"><span className="loading-crosshair"><Crosshair size={45}/></span><span className="eyebrow">{tr("ESTABLISHING UPLINK", "جارٍ تجهيز الاتصال")}</span><h2>{tr("PREPARING THE BATTLEFIELD", "جارٍ تجهيز ساحة المعركة")}</h2><div className="loading-track"><span/></div><p>{map.name} <span>·</span> {tr("Checking your equipment…", "جارٍ فحص معداتك…")}</p></div>}
    {error && <div className="battle-overlay"><div className="battle-dialog"><ShieldCheck size={36}/><span className="eyebrow">{tr("DEPLOYMENT INTERRUPTED", "تعذر بدء المعركة")}</span><h2>{tr("LET’S REGROUP.", "لنحاول من جديد.")}</h2><p>{error}</p><button className="button button-primary full-width" onClick={onExit}><ChevronLeft size={17}/>{tr("RETURN TO LOBBY", "العودة للردهة")}</button></div></div>}

    {paused && !result && <div className="battle-overlay"><div className="battle-dialog pause-dialog" role="dialog" aria-modal="true" aria-labelledby="pause-title"><div className="pause-badge"><Pause size={27}/></div><span className="eyebrow">{tr("OPERATION PAUSED", "المعركة متوقفة مؤقتًا")}</span><h2 id="pause-title">{tr("TAKE A BREATHER.", "خذ استراحة.")}</h2><p>{config.session ? tr("Online opponents keep playing. Rejoin when you’re ready.", "اللاعبون الآخرون مستمرون. عد عندما تكون جاهزًا.") : tr("Your battlefield will be right here. Ready for another push?", "ساحة المعركة تنتظرك. جاهز للعودة؟")}</p><div className="pause-match"><img src={map.image} alt=""/><span><b>{map.name}</b><small>{hud.kills} ELIMINATIONS <i>·</i> {hud.score} PTS</small></span><strong>{clock}</strong></div><button className="button button-primary full-width" autoFocus onClick={() => engine.current?.setPaused(false)}><Play size={16}/>{tr("RESUME BATTLE", "استئناف المعركة")}<ArrowRight size={18}/></button><button className="button button-ghost full-width" onClick={restart}><RotateCcw size={16}/>{tr("RESTART OPERATION", "ابدأ من جديد")}</button>{config.session && <button className="button button-ghost full-width" onClick={copyCode}><Copy size={15}/>{tr("INVITE A FRIEND", "ادعُ صديقًا")}<span className="pause-room-code">{config.session.room.code}</span></button>}<div className="pause-utilities"><button onClick={toggleMic}>{micMuted ? <MicOff size={16}/> : <Mic size={16}/>} {micMuted ? tr("Mic muted", "المايك مكتوم") : tr("Mic on", "المايك مفعّل")}</button><button onClick={toggleSound}>{sound ? <Volume2 size={16}/> : <VolumeX size={16}/>} {sound ? tr("Sound on", "الصوت مفعّل") : tr("Sound off", "الصوت مغلق")}</button><button onClick={fullscreen}><Maximize size={15}/>{tr("Fullscreen", "ملء الشاشة")}</button></div><div className="mic-settings-box"><div className="mic-settings-row"><span>{tr("Squad Comms Mode", "نمط المحادثة الصوتية")}</span><button className="button button-ghost" style={{ height: "30px", padding: "0 10px", fontSize: "10px" }} onClick={() => { const next = micMode === "open" ? "ptt" : "open"; setMicMode(next); voiceRef.current?.setMode(next); }}>{micMode === "open" ? tr("Open Mic", "مفتوح دائمًا") : tr("Push-to-Talk (V)", "اضغط للتحدث (V)")}</button></div><div className="mic-test-container"><div style={{ display: "flex", justifyContent: "space-between", fontSize: "9px", color: "#a8be95" }}><span>{tr("Mic Input Level", "مستوى صوت الميكروفون")}</span><span>{micMuted ? tr("Muted", "مكتوم") : `${Math.round(micLevel * 100)}%`}</span></div><div className="mic-test-meter"><span style={{ width: `${micMuted ? 0 : Math.round(micLevel * 100)}%` }}/></div></div></div>{touchDevice && <div className="touch-tuning" dir={ar ? "rtl" : "ltr"}>
        <label htmlFor="touch-sensitivity"><span><SlidersHorizontal size={15}/>{tr("Touch sensitivity", "حساسية اللمس")}</span><output htmlFor="touch-sensitivity">{touchSensitivity.toFixed(2)}×</output></label>
        <input id="touch-sensitivity" aria-label={tr("Touch sensitivity", "حساسية اللمس")} aria-valuetext={`${touchSensitivity.toFixed(2)}×`} aria-describedby="touch-control-help" onKeyDown={event => { if (event.key.startsWith("Arrow") || ["Home", "End", "PageUp", "PageDown"].includes(event.key)) event.stopPropagation(); }} type="range" min="0.45" max="1.6" step="0.05" value={touchSensitivity} onChange={event => adjustTouchSensitivity(Number(event.target.value))}/>
        <div className="sensitivity-scale"><span>{tr("Precise", "أدق")}</span><span>{tr("Faster turns", "التفاف أسرع")}</span></div>
        <p id="touch-control-help">{tr("Drag FIRE to aim while shooting. Movement starts where your left thumb lands.", "اسحب زر FIRE للتصويب أثناء الإطلاق. تبدأ الحركة من مكان إصبعك الأيسر.")}</p>
      </div>}<button className="subtle-button" onClick={() => engine.current?.finish(false)}>{tr("End operation & save score", "إنهاء الجولة وحفظ النتيجة")}</button><button className="return-to-lobby" onClick={onExit}><Home size={13}/>{tr("Return to lobby", "العودة إلى الردهة")}</button>{notice && <p className="pause-notice" role="status">{notice.text}</p>}</div></div>}

    {result && <div className="battle-overlay result-overlay"><div className="battle-dialog result-dialog" role="dialog" aria-modal="true" aria-labelledby="result-title"><span className={`result-emblem ${result.won ? "won" : ""}`}>{result.won ? <Trophy size={32}/> : <Skull size={32}/>}</span><span className="eyebrow">{tr("AFTER-ACTION REPORT", "تقرير ما بعد المعركة")}</span><h2 id="result-title">{result.won ? tr("MISSION COMPLETE.", "اكتملت المهمة.") : tr("OPERATOR DOWN.", "سقط المقاتل.")}</h2><p>{result.won ? tr("You held the line. Your squad would be proud.", "صمدت حتى النهاية. فريقك يفخر بك.") : tr("Every great operator has a comeback. This is yours.", "لكل مقاتل عودة قوية. هذه فرصتك.")}</p><div className="result-score"><small>{tr("FINAL COMBAT SCORE", "نتيجة القتال النهائية")}</small><b>{result.score.toLocaleString()}<span>PTS</span></b>{records[0]?.id === result.id && result.score > 0 && <span className="personal-record"><Trophy size={11}/>{tr("NEW PERSONAL BEST", "رقم قياسي شخصي جديد")}</span>}</div><div className="result-stats"><div><Crosshair size={16}/><b>{result.kills}</b><span>{tr("ELIMINATIONS", "إقصاءات")}</span></div><div><ShieldCheck size={16}/><b>{hud.wave}</b><span>{tr("WAVE REACHED", "الموجة")}</span></div><div><Zap size={16}/><b>{Math.floor(result.duration / 60)}:{String(result.duration % 60).padStart(2, "0")}</b><span>{tr("TIME SURVIVED", "مدة الصمود")}</span></div></div><button className="button button-primary full-width" autoFocus onClick={restart}><RotateCcw size={17}/>{tr("ONE MORE ROUND", "جولة أخرى")}<ArrowRight size={18}/></button><button className="button button-ghost full-width" onClick={onExit}><Home size={16}/>{tr("BACK TO LOBBY", "العودة للردهة")}</button><span className="result-saved"><ShieldCheck size={12}/>{tr("Score saved on this device", "تم حفظ النتيجة على هذا الجهاز")}<kbd>ENTER ↵</kbd></span></div></div>}
  </div>;
}
