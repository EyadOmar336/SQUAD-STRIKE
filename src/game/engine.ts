import * as THREE from "three";
import { CombatAudio } from "./audio";
import { buildWorld, createSoldier, createWeapon, seeded, type Soldier, type World } from "./world";
import type { GameConfig, GameResult, HudData, Peer } from "@/lib/game-types";

type Feedback = "hit" | "damage" | "kill" | "info" | "grenade";
export type EngineCallbacks = { hud: (data: HudData) => void; pause: (paused: boolean) => void; finish: (result: GameResult) => void; feedback: (type: Feedback, text: string, points?: number) => void; engage: () => void };
type Actor = { id: string; soldier: Soldier; hp: number; alive: boolean; target: THREE.Vector3; yaw: number; phase: number; lastShot: number; respawnAt: number; diedAt: number; flashUntil: number; shots: number; hitUntil: number };
type Particle = { p: THREE.Vector3; v: THREE.Vector3; life: number; maxLife: number; scale: number };
type Tracer = { mesh: THREE.Mesh; life: number };
type Grenade = { mesh: THREE.Mesh; velocity: THREE.Vector3; life: number };
const EYE = 1.72;
const ZERO = new THREE.Vector3();

export class ArenaEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(76, 1, 0.055, 430);
  private world: World;
  private weapon: ReturnType<typeof createWeapon>;
  private audio: CombatAudio;
  private config: GameConfig;
  private callbacks: EngineCallbacks;
  private host: HTMLElement;
  private minimap: HTMLCanvasElement;
  private keys = new Set<string>();
  private touch = { x: 0, y: 0 };
  private player = new THREE.Vector3(0, EYE, 18);
  private yaw = 0;
  private pitch = 0;
  private vertical = 0;
  private grounded = true;
  private firing = false;
  private aiming = false;
  private dragging = false;
  private hadLock = false;
  private lockAt = 0;
  private lastRender = 0;
  private touchDevice: boolean;
  private engaged = false;
  private paused = false;
  private ended = false;
  private disposed = false;
  private elapsed = 0;
  private hp = 100;
  private ammo = 30;
  private score = 0;
  private kills = 0;
  private serverScore = 0;
  private serverKills = 0;
  private grenades = 3;
  private combo = 0;
  private lastKill = -10;
  private lastDamage = -10;
  private reloadRemaining = 0;
  private lastShot = -10;
  private recoil = 0;
  private shake = 0;
  private muzzleTime = 0;
  private stepTime = 0;
  private totalShots = 0;
  private animation = 0;
  private previousFrame = 0;
  private lastHud = 0;
  private frameCount = 0;
  private frameSeconds = 0;
  private fps = 60;
  private pixelRatio = 1;
  private lastQualityChange = 0;
  private bots: Actor[] = [];
  private remotes = new Map<string, Actor>();
  private pvp = false;
  private pvpStarted = false;
  private particles: Particle[] = [];
  private particleMesh: THREE.InstancedMesh;
  private particleCursor = 0;
  private dummy = new THREE.Object3D();
  private direction = new THREE.Vector3();
  private temp = new THREE.Vector3();
  private ray = new THREE.Ray();
  private sphere = new THREE.Sphere(new THREE.Vector3(), 0.78);
  private tracers: Tracer[] = [];
  private thrown: Grenade[] = [];
  private networkTimer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;
  private abort: AbortController | null = null;
  private restartPending = true;
  private hits: string[] = [];
  private pendingBlasts: { x: number; y: number; z: number }[] = [];
  private network = "SOLO";
  private runId = crypto.randomUUID();
  private random = seeded(78522);
  private observer: ResizeObserver;

  constructor(host: HTMLElement, minimap: HTMLCanvasElement, config: GameConfig, callbacks: EngineCallbacks) {
    this.host = host; this.minimap = minimap; this.config = config; this.callbacks = callbacks;
    this.touchDevice = matchMedia("(pointer: coarse)").matches;
    let low = config.settings.quality === "low";
    this.renderer = new THREE.WebGLRenderer({ antialias: config.settings.quality === "high" && !this.touchDevice, powerPreference: "high-performance", alpha: false });
    const gl = this.renderer.getContext();
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const software = debug ? /swiftshader|llvmpipe|software/i.test(String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))) : false;
    if (software && config.settings.quality === "auto") low = true;
    this.renderer.setClearColor(0x9bab94); this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.13;
    this.pixelRatio = software && config.settings.quality === "auto" ? 0.7 : low ? 0.85 : Math.min(devicePixelRatio, this.touchDevice ? 1.25 : 1.5);
    this.renderer.setPixelRatio(this.pixelRatio); this.renderer.shadowMap.enabled = !low; this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false; this.renderer.shadowMap.needsUpdate = true;
    this.renderer.domElement.tabIndex = 0; this.renderer.domElement.setAttribute("aria-label", "3D battlefield. WASD to move, mouse to look, click or F to fire, R to reload, P to pause.");
    host.appendChild(this.renderer.domElement);
    this.world = buildWorld(this.scene, config.map, low);
    this.weapon = createWeapon(); this.camera.add(this.weapon.group); this.scene.add(this.camera);
    this.audio = new CombatAudio(config.settings.sound, config.settings.volume);
    this.particleMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.085, 0.085, 0.085), new THREE.MeshBasicMaterial({ color: 0xffffff }), 240);
    this.particleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.particleMesh.frustumCulled = false;
    for (let i = 0; i < 240; i++) { this.particles.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, maxLife: 1, scale: 1 }); this.dummy.scale.setScalar(0); this.dummy.updateMatrix(); this.particleMesh.setMatrixAt(i, this.dummy.matrix); this.particleMesh.setColorAt(i, new THREE.Color(0xffd28a)); }
    this.scene.add(this.particleMesh);
    this.setSpawn();
    for (let i = 0; i < 3; i++) this.addBot(i, true);
    this.bind(); this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(host); this.resize();
    this.previousFrame = performance.now(); this.animation = requestAnimationFrame(this.frame); this.emitHud();
    if (config.session) { this.network = "CONNECTING"; this.sync(); this.networkTimer = setInterval(() => this.sync(), 220); }
  }

  private setSpawn() {
    if (this.config.session) {
      const hash = [...this.config.session.playerId].reduce((sum, char) => sum + char.charCodeAt(0), 0);
      let angle = (hash % 360) / 180 * Math.PI;
      for (let attempt = 0; attempt < 30; attempt++) {
        const x = Math.sin(angle) * 12, z = Math.cos(angle) * 12;
        const clear = [0, 1, 2, 3].every(distance => !this.collides(x - Math.sin(angle) * distance, z - Math.cos(angle) * distance, 0));
        if (clear) { this.player.set(x, EYE, z); break; }
        angle += 0.43;
      }
      this.yaw = angle;
    } else { this.player.copy(this.world.spawn); this.yaw = 0; }
    this.pitch = 0; this.camera.position.copy(this.player); this.camera.rotation.set(0, this.yaw, 0, "YXZ");
  }
  private actor(id: string, name: string, bot: boolean): Actor {
    const soldier = createSoldier(name, bot); this.scene.add(soldier.group);
    return { id, soldier, hp: 80, alive: true, target: new THREE.Vector3(), yaw: 0, phase: this.random() * 6.28, lastShot: 0, respawnAt: 0, diedAt: 0, flashUntil: 0, shots: 0, hitUntil: 0 };
  }
  private addBot(index: number, initial: boolean) { const bot = this.actor(`bot-${index}`, `HOSTILE ${String(index + 1).padStart(2, "0")}`, true); this.bots.push(bot); this.spawnBot(bot, index, initial); }
  private spawnBot(bot: Actor, index: number, initial = false) {
    const positions = [[0, -1], [-6, -9], [8, -17]];
    let x = 0, z = 0;
    if (initial && index < 3 && !this.config.session) { [x, z] = positions[index]; }
    else {
      for (let i = 0; i < 20; i++) { const angle = this.random() * Math.PI * 2; const radius = 17 + this.random() * 17; x = THREE.MathUtils.clamp(this.player.x + Math.sin(angle) * radius, -89, 89); z = THREE.MathUtils.clamp(this.player.z + Math.cos(angle) * radius, -89, 89); if (!this.collides(x, z, 0)) break; }
    }
    bot.soldier.group.position.set(x, 0, z); bot.soldier.group.rotation.set(0, 0, 0); bot.soldier.group.scale.setScalar(1); bot.soldier.group.visible = true; bot.soldier.marker.visible = true;
    bot.hp = 80; bot.alive = true; bot.lastShot = this.elapsed + 1.4 + index * 0.3; bot.hitUntil = 0;
  }

  private bind() {
    window.addEventListener("keydown", this.keyDown); window.addEventListener("keyup", this.keyUp);
    document.addEventListener("mousemove", this.mouseMove); document.addEventListener("pointerlockchange", this.lockChange);
    document.addEventListener("visibilitychange", this.visibility); window.addEventListener("blur", this.blur);
    this.renderer.domElement.addEventListener("pointerdown", this.pointerDown); window.addEventListener("pointerup", this.pointerUp);
    this.renderer.domElement.addEventListener("contextmenu", this.contextMenu);
  }
  private contextMenu = (e: Event) => e.preventDefault();
  private keyDown = (e: KeyboardEvent) => {
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyW", "KeyA", "KeyS", "KeyD", "KeyF", "KeyR", "KeyG", "KeyP", "Escape"].includes(e.code)) e.preventDefault();
    if (e.code === "Escape" || e.code === "KeyP") { if (!e.repeat && !this.ended) this.setPaused(!this.paused); return; }
    if (this.paused || this.ended) return;
    this.keys.add(e.code);
    if (["KeyW", "KeyA", "KeyS", "KeyD", "KeyF", "Space"].includes(e.code) && !this.engaged) this.engage();
    if (e.code === "KeyR" && !e.repeat) this.reload();
    if (e.code === "Space" && !e.repeat) this.jump();
    if (e.code === "KeyG" && !e.repeat) this.grenade();
  };
  private keyUp = (e: KeyboardEvent) => { this.keys.delete(e.code); };
  private mouseMove = (e: MouseEvent) => { if (performance.now() - this.lockAt < 120 || Math.abs(e.movementX) > 180 || Math.abs(e.movementY) > 180) return; if (!this.paused && !this.ended && (document.pointerLockElement === this.renderer.domElement || this.dragging)) this.look(e.movementX, e.movementY); };
  private pointerDown = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" || this.paused || this.ended) return;
    this.engage(); if (e.button === 0) { this.firing = true; this.dragging = true; if (this.reloadRemaining <= 0) this.shoot(); } if (e.button === 2) this.aiming = true;
  };
  private pointerUp = (e: PointerEvent) => { if (e.pointerType === "mouse") { if (e.button === 0) { this.firing = false; this.dragging = false; } if (e.button === 2) this.aiming = false; } };
  private lockChange = () => { const locked = document.pointerLockElement === this.renderer.domElement; if (locked) this.lockAt = performance.now(); if (this.hadLock && !locked && !this.ended) this.setPaused(true); this.hadLock = locked; };
  private visibility = () => { if (document.hidden && this.engaged && !this.ended) this.setPaused(true); };
  private blur = () => { this.keys.clear(); this.firing = false; if (this.engaged && !this.ended) this.setPaused(true); };
  private resize() { if (this.disposed) return; const w = this.host.clientWidth, h = this.host.clientHeight; if (!w || !h) return; this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
  private requestLock() {
    const canvas = this.renderer.domElement;
    if (this.touchDevice || document.pointerLockElement || canvas.dataset.lookMode === "drag") return;
    const fallback = () => {
      if (this.disposed) return;
      canvas.dataset.lookMode = "drag";
      this.callbacks.feedback("info", "DRAG TO LOOK · CLICK OR F TO FIRE · ARROW KEYS TO TURN");
    };
    if (!canvas.requestPointerLock) { fallback(); return; }
    try { const result = canvas.requestPointerLock(); if (result) result.catch(fallback); } catch { fallback(); }
  }

  engage() { if (this.ended) return; this.renderer.domElement.focus({ preventScroll: true }); this.audio.unlock(); if (!this.engaged) { this.engaged = true; this.callbacks.engage(); this.callbacks.feedback("info", this.config.session ? "ROOM LIVE · WARM UP UNTIL YOUR SQUAD ARRIVES" : "ELIMINATE HOSTILES · SURVIVE 3 MINUTES"); } this.requestLock(); }
  look(dx: number, dy: number) { if (this.paused || this.ended) return; const factor = this.config.settings.sensitivity * (this.touchDevice ? 0.004 : 0.0022) * (this.aiming ? 0.62 : 1); this.yaw -= dx * factor; this.pitch = THREE.MathUtils.clamp(this.pitch - dy * factor, -1.42, 1.42); }
  moveTouch(x: number, y: number) { if (!this.engaged && (x || y)) this.engage(); this.touch.x = x; this.touch.y = y; }
  fire(active: boolean) { this.firing = active; if (active && !this.paused && !this.ended) { this.engage(); if (this.reloadRemaining <= 0) this.shoot(); } }
  aim(active: boolean) { this.aiming = active; }
  jump() { if (!this.paused && !this.ended && this.grounded) { this.engage(); this.vertical = 6.8; this.grounded = false; this.audio.jump(); } }
  toggleSound(enabled: boolean) { this.audio.setEnabled(enabled); }
  setPaused(paused: boolean) {
    if (this.ended || this.paused === paused) return;
    this.paused = paused; this.firing = false; this.dragging = false; this.aiming = false; this.keys.clear(); this.touch.x = this.touch.y = 0; this.audio.pause(paused);
    if (paused && document.pointerLockElement === this.renderer.domElement) document.exitPointerLock();
    if (!paused) { this.previousFrame = performance.now(); this.audio.unlock(); this.engage(); }
    this.callbacks.pause(paused);
  }
  reload() { if (this.paused || this.ended || this.reloadRemaining > 0 || this.ammo === 30) return; this.reloadRemaining = 1.45; this.audio.reload(); this.emitHud(); }
  grenade() {
    if (this.paused || this.ended || this.grenades <= 0) return;
    this.engage(); this.grenades--; this.camera.updateMatrixWorld(); this.camera.getWorldDirection(this.direction);
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.13, 1), new THREE.MeshStandardMaterial({ color: 0x4e6640, emissive: 0x29331d, roughness: 0.8 }));
    mesh.position.copy(this.player).addScaledVector(this.direction, 0.7); this.scene.add(mesh);
    this.thrown.push({ mesh, velocity: this.direction.clone().multiplyScalar(17).add(new THREE.Vector3(0, 5, 0)), life: 1.25 });
    this.audio.reload(); this.callbacks.feedback("info", "GRENADE OUT"); this.emitHud();
  }

  private collides(x: number, z: number, foot: number) {
    if (Math.abs(x) > 108 || Math.abs(z) > 108) return true;
    for (const c of this.world.colliders) if (foot < c.height - 0.08 && Math.abs(x - c.x) < c.hw + 0.34 && Math.abs(z - c.z) < c.hd + 0.34) return true;
    return false;
  }
  private blocked(origin: THREE.Vector3, dir: THREE.Vector3, maxDistance: number) {
    let closest = maxDistance;
    for (const c of this.world.colliders) {
      let enter = 0, exit = closest;
      if (Math.abs(dir.x) < 0.00001) { if (origin.x < c.x - c.hw || origin.x > c.x + c.hw) continue; }
      else { const a = (c.x - c.hw - origin.x) / dir.x, b = (c.x + c.hw - origin.x) / dir.x; enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b)); }
      if (Math.abs(dir.z) < 0.00001) { if (origin.z < c.z - c.hd || origin.z > c.z + c.hd) continue; }
      else { const a = (c.z - c.hd - origin.z) / dir.z, b = (c.z + c.hd - origin.z) / dir.z; enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b)); }
      if (enter > exit || exit < 0) continue;
      const y = origin.y + dir.y * enter; if (y >= 0 && y <= c.height) closest = Math.min(closest, enter);
    }
    if (dir.y < -0.01) closest = Math.min(closest, -origin.y / dir.y);
    return closest;
  }
  private updatePlayer(dt: number) {
    let forward = (this.keys.has("KeyW") || this.keys.has("ArrowUp") ? 1 : 0) - (this.keys.has("KeyS") || this.keys.has("ArrowDown") ? 1 : 0) - this.touch.y;
    let strafe = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0) + this.touch.x;
    if (this.keys.has("ArrowLeft")) this.yaw += dt * 1.8; if (this.keys.has("ArrowRight")) this.yaw -= dt * 1.8;
    const length = Math.hypot(forward, strafe); if (length > 1) { forward /= length; strafe /= length; }
    const sprint = (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")) && !this.aiming;
    const speed = (sprint ? 12 : this.aiming ? 4.2 : 7.5) * dt;
    const dx = (strafe * Math.cos(this.yaw) - forward * Math.sin(this.yaw)) * speed;
    const dz = (-forward * Math.cos(this.yaw) - strafe * Math.sin(this.yaw)) * speed;
    const foot = this.player.y - EYE;
    if (!this.collides(this.player.x + dx, this.player.z, foot)) this.player.x += dx;
    if (!this.collides(this.player.x, this.player.z + dz, foot)) this.player.z += dz;
    let ground = 0;
    for (const c of this.world.colliders) if (Math.abs(this.player.x - c.x) < c.hw + 0.2 && Math.abs(this.player.z - c.z) < c.hd + 0.2 && foot >= c.height - 0.16) ground = Math.max(ground, c.height);
    this.vertical -= 18 * dt; this.player.y += this.vertical * dt;
    if (this.player.y <= EYE + ground) { this.player.y = EYE + ground; this.vertical = 0; this.grounded = true; } else this.grounded = false;
    if (length > 0.15 && this.grounded) { this.stepTime += dt; if (this.stepTime > (sprint ? 0.27 : 0.39)) { this.audio.step(); this.stepTime = 0; } }
    const bob = length > 0.1 && this.grounded ? Math.sin(this.elapsed * (sprint ? 16 : 11)) * 0.027 : Math.sin(this.elapsed * 1.8) * 0.005;
    this.recoil = Math.max(0, this.recoil - dt * 5); this.shake = Math.max(0, this.shake - dt * 1.6);
    this.camera.position.copy(this.player); this.camera.position.y += bob;
    this.camera.rotation.set(this.pitch + this.recoil * 0.022 + (this.random() - 0.5) * this.shake * 0.07, this.yaw + (this.random() - 0.5) * this.shake * 0.055, (this.random() - 0.5) * this.shake * 0.025, "YXZ");
    const targetFov = this.aiming ? 51 : sprint && length > 0 ? 82 : 76;
    if (Math.abs(this.camera.fov - targetFov) > 0.05) { this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, Math.min(1, dt * 12)); this.camera.updateProjectionMatrix(); }
    const reload = this.reloadRemaining > 0 ? Math.sin((1 - this.reloadRemaining / 1.45) * Math.PI) : 0;
    const targetX = this.aiming ? 0.012 : 0.3;
    this.weapon.group.position.x = THREE.MathUtils.lerp(this.weapon.group.position.x, targetX, Math.min(1, dt * 13)) + Math.sin(this.elapsed * 5) * length * 0.001;
    this.weapon.group.position.y = (this.aiming ? -0.128 : -0.26) - bob * 0.65 - reload * 0.2;
    this.weapon.group.position.z = -0.51 + this.recoil * 0.055;
    this.weapon.group.rotation.set(reload * 0.8 + this.recoil * 0.05, -0.02, -reload * 0.75 - strafe * 0.012);
    this.weapon.flash.visible = this.elapsed < this.muzzleTime;
    if (this.weapon.flash.visible) this.weapon.flash.rotation.z = this.random() * 6.28;
    this.camera.updateMatrixWorld(true);
    if (this.reloadRemaining > 0) { this.reloadRemaining -= dt; if (this.reloadRemaining <= 0) { this.reloadRemaining = 0; this.ammo = 30; this.audio.reload(); } }
    if ((this.firing || this.keys.has("KeyF")) && this.reloadRemaining <= 0) this.shoot();
  }

  private shoot() {
    if (this.elapsed - this.lastShot < 0.112) return;
    if (this.ammo <= 0) { this.reload(); return; }
    this.lastShot = this.elapsed; this.ammo--; this.totalShots++; this.recoil = Math.min(1.5, this.recoil + 0.68); this.shake = Math.max(this.shake, 0.15); this.muzzleTime = this.elapsed + 0.045;
    this.audio.shot(); this.camera.getWorldDirection(this.direction);
    const origin = this.camera.position; const distance = this.blocked(origin, this.direction, 95);
    this.ray.set(origin, this.direction);
    let target: Actor | null = null; let closest = distance; const hitPosition = origin.clone().addScaledVector(this.direction, distance);
    const actors = this.pvp ? [...this.remotes.values()] : this.bots;
    for (const actor of actors) {
      if (!actor.alive || !actor.soldier.group.visible) continue;
      this.sphere.center.copy(actor.soldier.group.position).add(new THREE.Vector3(0, 1.13, 0));
      if (this.ray.intersectSphere(this.sphere, this.temp)) { const d = origin.distanceTo(this.temp); if (d < closest) { closest = d; target = actor; hitPosition.copy(this.temp); } }
    }
    const muzzle = new THREE.Vector3(0, 0.015, -0.86); this.weapon.group.localToWorld(muzzle); this.tracer(muzzle, hitPosition, 0xffd89a);
    if (target) {
      target.hitUntil = this.elapsed + 0.13; this.burst(hitPosition, 10, 0xffd397, 3.3); this.audio.hit(); this.callbacks.feedback("hit", "");
      if (target.id.startsWith("bot-")) this.damageBot(target, 40);
      else if (this.hits.length < 5) this.hits.push(target.id);
    } else if (distance < 95) this.burst(hitPosition, 5, 0xd3c5a0, 2.6);
    if (this.ammo === 0) this.reload();
  }
  private damageBot(bot: Actor, damage: number) {
    if (!bot.alive) return; bot.hp -= damage;
    if (bot.hp > 0) return;
    bot.alive = false; bot.diedAt = this.elapsed; bot.respawnAt = this.elapsed + 2.7; bot.soldier.marker.visible = false;
    this.combo = this.elapsed - this.lastKill < 3.5 ? Math.min(5, this.combo + 1) : 1; this.lastKill = this.elapsed;
    const points = 100 + (this.combo - 1) * 25; this.score += points; this.kills++; this.hp = Math.min(100, this.hp + 8);
    this.burst(bot.soldier.group.position.clone().add(new THREE.Vector3(0, 1.1, 0)), 27, 0xd0e598, 5);
    this.audio.kill(); this.shake = Math.max(this.shake, 0.2);
    this.callbacks.feedback("kill", this.combo >= 3 ? "ON A ROLL" : this.combo === 2 ? "DOUBLE ELIMINATION" : "HOSTILE ELIMINATED", points);
    if (this.kills % 5 === 0) this.callbacks.feedback("info", `WAVE ${1 + Math.floor(this.kills / 5)} · STAY SHARP`);
  }
  private hurt(amount: number) {
    if (this.ended) return; this.hp = Math.max(0, this.hp - amount); this.lastDamage = this.elapsed; this.shake = 0.6; this.audio.hurt(); this.callbacks.feedback("damage", "TAKING FIRE"); if (this.hp <= 0) this.finish(false);
  }
  private updateBots(dt: number) {
    const wave = 1 + Math.floor(this.kills / 5);
    if (!this.pvp && this.bots.length < Math.min(7, 3 + Math.floor(this.kills / 4))) this.addBot(this.bots.length, false);
    for (let index = 0; index < this.bots.length; index++) {
      const bot = this.bots[index]; const group = bot.soldier.group;
      if (this.pvp) { group.visible = false; continue; }
      if (!bot.alive) {
        const progress = Math.min(1, (this.elapsed - bot.diedAt) / 0.6); group.rotation.z = -progress * 1.5; group.scale.setScalar(Math.max(0.01, 1 - progress * 0.85)); group.position.y = -progress * 0.3;
        if (progress >= 1) group.visible = false;
        if (this.elapsed > bot.respawnAt) this.spawnBot(bot, index); continue;
      }
      group.visible = true;
      const dx = this.player.x - group.position.x, dz = this.player.z - group.position.z, distance = Math.hypot(dx, dz);
      group.rotation.y = Math.atan2(dx, dz); group.rotation.z = 0;
      const chase = distance > 13 ? 1 : distance < 7 ? -0.5 : 0.02;
      const strafe = Math.sin(this.elapsed * 0.7 + bot.phase) * (distance < 22 ? 0.55 : 0.1);
      const speed = (1.35 + wave * 0.15) * dt;
      let mx = (dx / Math.max(0.1, distance) * chase + dz / Math.max(0.1, distance) * strafe) * speed;
      let mz = (dz / Math.max(0.1, distance) * chase - dx / Math.max(0.1, distance) * strafe) * speed;
      if (this.collides(group.position.x + mx, group.position.z + mz, 0)) { mx = Math.sin(this.elapsed + bot.phase) * speed; mz = Math.cos(this.elapsed + bot.phase) * speed; }
      if (!this.collides(group.position.x + mx, group.position.z, 0)) group.position.x += mx;
      if (!this.collides(group.position.x, group.position.z + mz, 0)) group.position.z += mz;
      const swing = Math.sin(this.elapsed * 8 + bot.phase) * 0.35;
      bot.soldier.leftLeg.rotation.x = swing; bot.soldier.rightLeg.rotation.x = -swing;
      bot.soldier.leftArm.rotation.x = 0.15 + swing * 0.15; bot.soldier.rightArm.rotation.x = -0.3 - swing * 0.12;
      group.position.y = Math.abs(Math.sin(this.elapsed * 8 + bot.phase)) * 0.025;
      group.scale.setScalar(this.elapsed < bot.hitUntil ? 1.045 : 1);
      bot.soldier.flash.visible = this.elapsed < bot.flashUntil;
      if (this.elapsed > 5.5 && distance < 40 && this.elapsed - bot.lastShot > Math.max(1.05, 2.1 - wave * 0.1)) {
        bot.lastShot = this.elapsed + this.random() * 0.65;
        const origin = group.position.clone().add(new THREE.Vector3(0, 1.35, 0)); const dir = this.player.clone().sub(origin).normalize();
        if (this.blocked(origin, dir, distance) >= distance - 0.9) {
          bot.flashUntil = this.elapsed + 0.08; const destination = this.player.clone().add(new THREE.Vector3((this.random() - 0.5) * 2.3, (this.random() - 0.5) * 1.1, 0)); this.tracer(origin, destination, 0xff9364);
          if (distance < 30) this.audio.distantShot();
          if (this.random() < (this.elapsed < 18 ? 0.45 : 0.63)) this.hurt(4 + Math.min(7, wave));
        }
      }
    }
  }
  private updateRemotes(dt: number) {
    for (const actor of this.remotes.values()) {
      const group = actor.soldier.group; if (!actor.alive) { group.visible = false; continue; } group.visible = true;
      const moving = group.position.distanceToSquared(actor.target) > 0.003;
      group.position.lerp(actor.target, 1 - Math.exp(-dt * 13));
      const angle = Math.atan2(Math.sin(actor.yaw - group.rotation.y), Math.cos(actor.yaw - group.rotation.y)); group.rotation.y += angle * Math.min(1, dt * 12);
      actor.soldier.leftLeg.rotation.x = moving ? Math.sin(this.elapsed * 12 + actor.phase) * 0.5 : 0;
      actor.soldier.rightLeg.rotation.x = -actor.soldier.leftLeg.rotation.x;
      actor.soldier.flash.visible = performance.now() < actor.flashUntil;
      group.scale.setScalar(this.elapsed < actor.hitUntil ? 1.045 : 1);
    }
  }
  private burst(position: THREE.Vector3, count: number, color: number, force = 4) {
    for (let i = 0; i < count; i++) { const id = this.particleCursor++ % this.particles.length; const p = this.particles[id]; p.p.copy(position); p.v.set((this.random() - 0.5) * force * 2, this.random() * force, (this.random() - 0.5) * force * 2); p.maxLife = p.life = 0.2 + this.random() * 0.5; p.scale = 0.5 + this.random() * 1.7; this.particleMesh.setColorAt(id, new THREE.Color(color)); }
    if (this.particleMesh.instanceColor) this.particleMesh.instanceColor.needsUpdate = true;
  }
  private tracer(from: THREE.Vector3, to: THREE.Vector3, color: number) {
    const delta = to.clone().sub(from); const length = delta.length();
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, Math.max(0.01, length), 4), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false }));
    mesh.position.copy(from).addScaledVector(delta, 0.5); mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()); this.scene.add(mesh); this.tracers.push({ mesh, life: 0.052 });
  }
  private updateEffects(dt: number) {
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i]; if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { this.dummy.scale.setScalar(0); } else { p.v.y -= 10 * dt; p.p.addScaledVector(p.v, dt); if (p.p.y < 0.035) { p.p.y = 0.035; p.v.y *= -0.25; p.v.x *= 0.7; p.v.z *= 0.7; } this.dummy.position.copy(p.p); this.dummy.rotation.set(p.life * 5, p.life * 6, p.life * 3); this.dummy.scale.setScalar(p.scale * (p.life / p.maxLife)); }
      this.dummy.updateMatrix(); this.particleMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.particleMesh.instanceMatrix.needsUpdate = true;
    for (let i = this.tracers.length - 1; i >= 0; i--) { const tracer = this.tracers[i]; tracer.life -= dt; if (tracer.life <= 0) { this.scene.remove(tracer.mesh); this.disposeObject(tracer.mesh); this.tracers.splice(i, 1); } }
    for (let i = this.thrown.length - 1; i >= 0; i--) {
      const grenade = this.thrown[i]; grenade.life -= dt; grenade.velocity.y -= 12 * dt;
      const next = grenade.mesh.position.clone().addScaledVector(grenade.velocity, dt);
      if (!this.collides(next.x, next.z, Math.max(0, next.y - 0.15))) grenade.mesh.position.copy(next); else { grenade.velocity.x *= -0.4; grenade.velocity.z *= -0.4; grenade.mesh.position.y = next.y; }
      if (grenade.mesh.position.y < 0.16) { grenade.mesh.position.y = 0.16; grenade.velocity.y *= -0.4; grenade.velocity.x *= 0.7; grenade.velocity.z *= 0.7; }
      grenade.mesh.rotation.x += dt * 6;
      if (grenade.life <= 0) {
        const p = grenade.mesh.position; this.burst(p, 65, 0xffcd7a, 11); this.burst(p, 30, 0x8e9872, 7); this.audio.explosion(); this.shake = 1; this.callbacks.feedback("grenade", "FRAG DETONATED");
        if (!this.pvp) for (const bot of this.bots) { if (bot.alive && bot.soldier.group.position.distanceTo(p) < 10) this.damageBot(bot, 120); }
        else if (this.config.session) this.pendingBlasts.push({ x: p.x, y: p.y, z: p.z });
        this.scene.remove(grenade.mesh); this.disposeObject(grenade.mesh); this.thrown.splice(i, 1);
      }
    }
  }
  private frame = (now: number) => {
    if (this.disposed) return;
    this.animation = requestAnimationFrame(this.frame);
    const realDt = Math.max(0, (now - this.previousFrame) / 1000);
    this.previousFrame = now;
    this.frameCount++; this.frameSeconds += realDt;
    if (this.frameSeconds >= 1) { this.fps = Math.min(144, Math.round(this.frameCount / this.frameSeconds)); this.frameCount = 0; this.frameSeconds = 0; }
    if (!this.paused && !this.ended && this.engaged) {
      const simulationTime = Math.min(0.25, realDt);
      const steps = Math.max(1, Math.ceil(simulationTime / 0.025));
      const step = simulationTime / steps;
      this.elapsed += Math.max(0, Math.min(1, realDt) - simulationTime);
      for (let i = 0; i < steps && !this.ended; i++) {
        this.elapsed += step; this.updatePlayer(step); this.updateBots(step);
        if (!this.ended) { this.updateRemotes(step); this.updateEffects(step); }
        if (!this.pvp && this.elapsed - this.lastDamage > 7 && this.hp < 100) this.hp = Math.min(100, this.hp + step * 4);
      }
      if (this.elapsed - this.lastKill > 3.5) this.combo = 0;
      if (this.elapsed >= 180) this.finish(true);
      if (this.config.settings.quality === "auto" && now - this.lastQualityChange > 2000 && this.fps < 43 && this.pixelRatio > 0.66) { this.pixelRatio = Math.max(0.65, this.pixelRatio * 0.84); this.renderer.setPixelRatio(this.pixelRatio); if (this.pixelRatio < 0.85) this.renderer.shadowMap.enabled = false; this.resize(); this.lastQualityChange = now; }
    }
    const flagPositions = this.world.flag.geometry.attributes.position;
    for (let i = 0; i < flagPositions.count; i++) { const x = flagPositions.getX(i); flagPositions.setZ(i, Math.sin(now * 0.0025 + x * 2) * 0.12 * ((x + 1.45) / 2.9)); } flagPositions.needsUpdate = true;
    if (now - this.lastHud > 100) { this.emitHud(); this.drawMinimap(); this.lastHud = now; }
    if ((!this.paused && !this.ended && this.engaged) || now - this.lastRender > 100) { this.renderer.render(this.scene, this.camera); this.lastRender = now; }
  };
  private emitHud() { this.callbacks.hud({ hp: Math.ceil(this.hp), ammo: this.ammo, score: this.score + this.serverScore, kills: this.kills + this.serverKills, time: Math.max(0, 180 - this.elapsed), wave: 1 + Math.floor(this.kills / 5), reloading: this.reloadRemaining > 0, grenades: this.grenades, combo: this.combo, peers: this.remotes.size + 1, fps: this.fps, network: this.network }); }
  private drawMinimap() {
    const ctx = this.minimap.getContext("2d"); if (!ctx) return; const size = this.minimap.width, half = size / 2, scale = size / 83;
    ctx.clearRect(0, 0, size, size); ctx.fillStyle = "rgba(15,27,15,.88)"; ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = "rgba(155,185,129,.1)"; ctx.lineWidth = 1;
    for (let i = 0; i < size; i += size / 5) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, size); ctx.moveTo(0, i); ctx.lineTo(size, i); ctx.stroke(); }
    ctx.fillStyle = "#7f927148";
    for (const c of this.world.colliders) { const x = (c.x - this.player.x) * scale + half, y = (c.z - this.player.z) * scale + half; if (x < -25 || x > size + 25 || y < -25 || y > size + 25) continue; ctx.fillRect(x - c.hw * scale, y - c.hd * scale, c.hw * 2 * scale, c.hd * 2 * scale); }
    ctx.strokeStyle = "#b5d79525"; ctx.beginPath(); ctx.arc(half, half, half * 0.74, 0, Math.PI * 2); ctx.stroke();
    for (const a of this.pvp ? this.remotes.values() : this.bots) { if (!a.alive) continue; const x = (a.soldier.group.position.x - this.player.x) * scale + half, y = (a.soldier.group.position.z - this.player.z) * scale + half; if (x < 3 || x > size - 3 || y < 3 || y > size - 3) continue; ctx.fillStyle = "#f19469"; ctx.beginPath(); ctx.arc(x, y, 2.7, 0, Math.PI * 2); ctx.fill(); }
    ctx.save(); ctx.translate(half, half); ctx.rotate(-this.yaw); ctx.fillStyle = "#cfefa6"; ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(4.5, 4); ctx.lineTo(0, 2); ctx.lineTo(-4.5, 4); ctx.closePath(); ctx.fill(); ctx.restore();
    ctx.font = "9px monospace"; ctx.textAlign = "center"; ctx.fillStyle = "#c4d8b1"; ctx.fillText("N", half, 11);
  }

  private async sync() {
    if (!this.config.session || this.disposed || this.syncing) return;
    this.syncing = true; this.abort = new AbortController(); const run = this.runId;
    const restart = this.restartPending; const hit = this.hits.shift(); const blast = this.pendingBlasts.shift();
    const timeout = setTimeout(() => this.abort?.abort(), 4000);
    try {
      const response = await fetch(`/api/rooms/${this.config.session.room.code}/sync`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: this.abort.signal, body: JSON.stringify({ token: this.config.session.token, position: { x: this.player.x, y: this.player.y, z: this.player.z, yaw: this.yaw }, playing: !this.ended, shots: this.totalShots, hit, blast, restart }) });
      if (!response.ok) throw new Error("Connection interrupted");
      const data: { self: Peer; peers: Peer[] } = await response.json();
      if (this.disposed || run !== this.runId) return;
      if (restart) this.restartPending = false;
      this.network = "LIVE";
      const peers = data.peers.filter(peer => peer.playing);
      this.pvp = peers.length > 0;
      if (this.pvp && !this.pvpStarted) { this.pvpStarted = true; this.score = 0; this.kills = 0; this.elapsed = 0; this.hp = 100; this.ammo = 30; this.grenades = 3; this.callbacks.feedback("info", "SQUAD CONNECTED · FREE FOR ALL IS LIVE"); }
      const seen = new Set<string>();
      for (const peer of peers) {
        seen.add(peer.id); let actor = this.remotes.get(peer.id);
        if (!actor) { actor = this.actor(peer.id, peer.name, false); actor.soldier.group.position.set(peer.position.x, peer.position.y - EYE, peer.position.z); this.remotes.set(peer.id, actor); }
        actor.target.set(peer.position.x, peer.position.y - EYE, peer.position.z); actor.yaw = peer.position.yaw + Math.PI; actor.hp = peer.hp; actor.alive = peer.hp > 0;
        if (peer.shots > actor.shots) { actor.flashUntil = performance.now() + 120; const origin = actor.target.clone().add(new THREE.Vector3(0, 1.4, 0)); const direction = new THREE.Vector3(-Math.sin(peer.position.yaw), 0, -Math.cos(peer.position.yaw)); this.tracer(origin, origin.clone().addScaledVector(direction, 35), 0xffbd83); if (origin.distanceTo(this.player) < 35) this.audio.distantShot(); } actor.shots = peer.shots;
      }
      for (const [id, actor] of this.remotes) if (!seen.has(id)) { this.scene.remove(actor.soldier.group); this.disposeObject(actor.soldier.group); this.remotes.delete(id); }
      if (this.pvpStarted && !this.ended) {
        if (data.self.hp < this.hp) { this.lastDamage = this.elapsed; this.shake = 0.65; this.audio.hurt(); this.callbacks.feedback("damage", "TAKING FIRE"); }
        this.hp = data.self.hp;
        if (data.self.kills > this.serverKills) { this.audio.kill(); this.callbacks.feedback("kill", "OPERATOR ELIMINATED", 100); }
        this.serverKills = data.self.kills; this.serverScore = data.self.score;
        if (this.hp <= 0) this.finish(false);
      }
    } catch { if (!this.disposed) this.network = "RECONNECTING"; }
    finally { clearTimeout(timeout); this.syncing = false; }
  }
  finish(won = false) {
    if (this.ended) return; this.ended = true; this.firing = false; this.keys.clear(); this.audio.pause(false); this.audio.finish(won); this.emitHud();
    if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock();
    this.callbacks.finish({ id: this.runId, name: this.config.name, score: this.score + this.serverScore, kills: this.kills + this.serverKills, map: this.config.map, duration: Math.floor(Math.min(180, this.elapsed)), won, date: new Date().toISOString() });
  }
  restart() {
    this.runId = crypto.randomUUID(); this.elapsed = 0; this.hp = 100; this.ammo = 30; this.score = this.kills = this.serverScore = this.serverKills = 0; this.grenades = 3; this.combo = 0; this.lastKill = this.lastDamage = this.lastShot = -10;
    this.recoil = this.shake = this.reloadRemaining = this.vertical = 0; this.totalShots = 0; this.firing = false; this.aiming = false; this.paused = false; this.ended = false; this.grounded = true; this.keys.clear(); this.touch.x = this.touch.y = 0; this.hits = []; this.pendingBlasts = []; this.restartPending = true; this.pvpStarted = false;
    this.setSpawn(); this.bots.forEach((bot, index) => this.spawnBot(bot, index, true));
    for (const p of this.particles) p.life = 0;
    this.dummy.scale.setScalar(0); this.dummy.updateMatrix(); for (let i = 0; i < this.particles.length; i++) this.particleMesh.setMatrixAt(i, this.dummy.matrix); this.particleMesh.instanceMatrix.needsUpdate = true;
    for (const item of [...this.tracers, ...this.thrown]) { this.scene.remove(item.mesh); this.disposeObject(item.mesh); } this.tracers = []; this.thrown = [];
    this.audio.pause(false); this.audio.unlock(); this.callbacks.pause(false); this.emitHud(); this.engage();
    this.callbacks.feedback("info", "FRESH MAGAZINE. FRESH START.");
  }
  private disposeObject(object: THREE.Object3D) {
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
    object.traverse(item => { if (item instanceof THREE.Mesh || item instanceof THREE.Sprite) { if ("geometry" in item) geometries.add(item.geometry); const mats = Array.isArray(item.material) ? item.material : [item.material]; mats.forEach(mat => { materials.add(mat); for (const value of Object.values(mat)) if (value instanceof THREE.Texture) textures.add(value); }); } });
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
  }
  dispose() {
    this.disposed = true; cancelAnimationFrame(this.animation); this.observer.disconnect(); this.abort?.abort(); if (this.networkTimer) clearInterval(this.networkTimer);
    window.removeEventListener("keydown", this.keyDown); window.removeEventListener("keyup", this.keyUp); document.removeEventListener("mousemove", this.mouseMove); document.removeEventListener("pointerlockchange", this.lockChange); document.removeEventListener("visibilitychange", this.visibility); window.removeEventListener("blur", this.blur); window.removeEventListener("pointerup", this.pointerUp);
    this.renderer.domElement.removeEventListener("pointerdown", this.pointerDown); this.renderer.domElement.removeEventListener("contextmenu", this.contextMenu);
    if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock();
    this.audio.dispose(); this.disposeObject(this.scene); this.renderer.dispose(); this.renderer.forceContextLoss(); this.renderer.domElement.remove();
  }
}
