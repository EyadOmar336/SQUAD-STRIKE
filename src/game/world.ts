import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { MapId } from "@/lib/game-types";

export type Collider = { x: number; z: number; hw: number; hd: number; height: number };
export type World = { group: THREE.Group; colliders: Collider[]; solids: THREE.Mesh[]; flag: THREE.Mesh; spawn: THREE.Vector3 };
const THEMES = {
  valley: { sky: 0xadb9a3, ground: "#687653", dirt: "#626450", wall: 0x797c65, roof: 0x3e4c3b, tree: 0x354d30, treeTop: 0x456039, mountain: 0x69765d, sun: 0xfff0c8 },
  desert: { sky: 0xdcc7a2, ground: "#b49b71", dirt: "#9e835d", wall: 0xaa9677, roof: 0x776747, tree: 0x686a3b, treeTop: 0x838049, mountain: 0xa18a6b, sun: 0xffdfa0 },
  harbor: { sky: 0x9aabb1, ground: "#747e79", dirt: "#555f5d", wall: 0x6f8080, roof: 0x3f5157, tree: 0x354846, treeTop: 0x4d6460, mountain: 0x627879, sun: 0xdce9eb },
};
export function seeded(seed: number) { let state = seed; return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; }; }
function groundTexture(base: string, seed: number) {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!; ctx.fillStyle = base; ctx.fillRect(0, 0, 256, 256);
  const random = seeded(seed);
  for (let i = 0; i < 15000; i++) { const value = Math.floor(random() * 100); ctx.fillStyle = `rgba(${value},${value},${value},${random() * 0.16})`; const size = 1 + random() * 3; ctx.fillRect(random() * 256, random() * 256, size, size); }
  for (let i = 0; i < 130; i++) { ctx.fillStyle = "#0c1c1011"; ctx.beginPath(); ctx.ellipse(random() * 256, random() * 256, 2 + random() * 8, 1 + random() * 3, random() * 3, 0, Math.PI * 2); ctx.fill(); }
  const texture = new THREE.CanvasTexture(canvas); texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(35, 35); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4; return texture;
}
export function buildWorld(scene: THREE.Scene, map: MapId, low: boolean): World {
  const t = THEMES[map]; const random = seeded(map === "valley" ? 324 : map === "desert" ? 846 : 999);
  const group = new THREE.Group(); scene.add(group);
  const colliders: Collider[] = []; const statics: THREE.Mesh[] = []; const solids: THREE.Mesh[] = [];
  const palette = new Map<number, THREE.MeshStandardMaterial>();
  const material = (color: number) => { if (!palette.has(color)) palette.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0.04 })); return palette.get(color)!; };
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  function box(w: number, h: number, d: number, x: number, y: number, z: number, color: number, solid = false) {
    const mesh = new THREE.Mesh(boxGeo, material(color)); mesh.position.set(x, y, z); mesh.scale.set(w, h, d); group.add(mesh); statics.push(mesh);
    if (solid) { colliders.push({ x, z, hw: w / 2, hd: d / 2, height: y + h / 2 }); }
    return mesh;
  }
  function mesh(geo: THREE.BufferGeometry, color: number, x: number, y: number, z: number) { const m = new THREE.Mesh(geo, material(color)); m.position.set(x, y, z); group.add(m); statics.push(m); return m; }
  scene.background = new THREE.Color(t.sky); scene.fog = new THREE.FogExp2(t.sky, map === "harbor" ? 0.008 : 0.006);
  scene.add(new THREE.HemisphereLight(0xe6edda, map === "desert" ? 0x847155 : 0x424f35, 2.25));
  const sun = new THREE.DirectionalLight(t.sun, 2.65); sun.position.set(-48, 75, 30); sun.castShadow = !low;
  sun.shadow.mapSize.set(1024, 1024); sun.shadow.camera.left = -65; sun.shadow.camera.right = 65; sun.shadow.camera.top = 65; sun.shadow.camera.bottom = -65; sun.shadow.camera.far = 200; sun.shadow.normalBias = 0.08; sun.shadow.bias = -0.0003; scene.add(sun);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(520, 520), new THREE.MeshStandardMaterial({ map: groundTexture(t.ground, 71), roughness: 1 })); ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; group.add(ground);
  const roadTex = groundTexture(t.dirt, 411); roadTex.repeat.set(3, 45);
  const road = new THREE.Mesh(new THREE.PlaneGeometry(12, 235), new THREE.MeshStandardMaterial({ map: roadTex, roughness: 1 })); road.rotation.x = -Math.PI / 2; road.position.y = 0.016; road.receiveShadow = true; group.add(road);
  const crossroad = new THREE.Mesh(new THREE.PlaneGeometry(140, 10), road.material); crossroad.rotation.x = -Math.PI / 2; crossroad.position.set(0, 0.017, -30); crossroad.receiveShadow = true; group.add(crossroad);
  if (map === "harbor") for (let z = -105; z < 105; z += 7) box(0.14, 0.025, 3, 0, 0.04, z, 0xd4cf9d);

  function bunker(x: number, z: number, w: number, d: number, h: number) {
    box(w, h, 0.65, x, h / 2, z - d / 2, t.wall, true);
    box(0.65, h, d, x - w / 2, h / 2, z, t.wall, true); box(0.65, h, d, x + w / 2, h / 2, z, t.wall, true);
    const part = (w - 2.8) / 2;
    box(part, h, 0.65, x - (w + 2.8) / 4, h / 2, z + d / 2, t.wall, true); box(part, h, 0.65, x + (w + 2.8) / 4, h / 2, z + d / 2, t.wall, true);
    box(2.8, h - 2.7, 0.65, x, (h + 2.7) / 2, z + d / 2, t.wall);
    box(w + 0.8, 0.4, d + 0.8, x, h + 0.2, z, t.roof);
    box(w - 0.5, 0.05, d - 0.5, x, 0.05, z, 0x737660);
    for (const sign of [-1, 1]) { box(2, 1.25, 0.08, x + sign * w * 0.31, 2.7, z + d / 2 + 0.36, 0x263a32); box(2.1, 0.1, 0.2, x + sign * w * 0.31, 2.05, z + d / 2 + 0.4, t.roof); }
    box(0.14, 3.5, 0.14, x + w / 2 - 1, h + 1.95, z, 0x4a5145);
    box(1.4, 0.08, 0.08, x + w / 2 - 1, h + 3.05, z, 0x4a5145);
    box(0.5, 0.18, 0.35, x, 2.75, z + d / 2 + 0.3, 0xd8bf80);
  }
  bunker(-21, -15, 13, 10, 4.5); bunker(25, -39, 12, 13, 5.2); bunker(-30, -57, 15, 10, 4.4); bunker(36, 24, 12, 10, 4.6); bunker(-38, 29, 10, 9, 3.8);
  if (map === "desert") { bunker(58, -20, 14, 12, 7); bunker(-64, -31, 15, 13, 7.5); }
  function container(x: number, z: number, length: number, color: number, turned = false) {
    const w = turned ? 3.2 : length, d = turned ? length : 3.2;
    box(w, 2.9, d, x, 1.45, z, color, true); box(w + 0.08, 0.12, d + 0.08, x, 2.95, z, 0x67705d);
    for (let i = -length / 2 + 0.3; i < length / 2; i += 0.65) for (const s of [-1, 1]) {
      box(turned ? 0.07 : 0.055, 2.7, turned ? 0.055 : 0.07, turned ? x + s * 1.63 : x + i, 1.45, turned ? z + i : z + s * 1.63, color + 0x070906);
    }
    for (const s of [-1, 1]) box(0.1, 2.4, 0.1, x + s * (w / 2 - 0.55), 1.45, z + d / 2 + 0.07, 0x929782);
  }
  container(-14, 5, 8, 0x536249); container(15, -14, 8, map === "harbor" ? 0x446571 : 0x655846, true); container(-15, -37, 9, 0x5e6850); container(20, 7, 6, 0x77684a); container(45, -7, 10, 0x485e55, true);
  if (map === "harbor") { for (let i = 0; i < 12; i++) container((i % 2 ? -1 : 1) * (48 + (i % 3) * 7), -55 + Math.floor(i / 2) * 13, 10, i % 2 ? 0x466a78 : 0x79614b, true); }
  function crate(x: number, z: number, size = 1.6) {
    box(size, size, size, x, size / 2, z, 0x7b7856, true);
    for (const s of [-1, 1]) { box(size + 0.03, 0.11, size + 0.03, x, size * (s === 1 ? 0.86 : 0.14), z, 0x4e573f); box(0.12, size, size + 0.04, x + s * size * 0.32, size / 2, z, 0x4e573f); }
  }
  [[-9, 17], [-11, 17], [10, -23], [12, -23], [9, -25], [-34, 9], [30, -5], [34, -10], [-9, -48], [20, 31], [-18, -28]].forEach(([x, z], i) => crate(x, z, i % 3 === 0 ? 1.25 : 1.6));
  function sandbags(x: number, z: number, vertical = false) {
    for (let row = 0; row < 3; row++) for (let col = 0; col < 6; col++) {
      const offset = (col - 2.5) * 1.1 + (row % 2) * 0.32;
      const bag = box(vertical ? 0.65 : 1.07, 0.36, vertical ? 1.07 : 0.65, x + (vertical ? 0 : offset), 0.19 + row * 0.35, z + (vertical ? offset : 0), map === "desert" ? 0xae9f7e : 0x8b8c65);
      bag.rotation.y = (random() - 0.5) * 0.1;
    }
    colliders.push({ x, z, hw: vertical ? 0.5 : 3.6, hd: vertical ? 3.6 : 0.5, height: 1.1 });
  }
  sandbags(-9, -4, true); sandbags(9, 0, true); sandbags(3, -24); sandbags(14, 25); sandbags(-32, -27); sandbags(-5, -61);
  const barrelGeometry = new THREE.CylinderGeometry(0.47, 0.47, 1.3, 8);
  for (const [x, z] of [[-8, 5], [-7, 6], [16, -6], [17, -7], [-24, 12], [29, -21], [-10, -30], [15, 15]]) { mesh(barrelGeometry, 0x4c6251, x, 0.65, z); mesh(new THREE.CylinderGeometry(0.49, 0.49, 0.06, 8), 0x353d32, x, 0.94, z); colliders.push({ x, z, hw: 0.5, hd: 0.5, height: 1.3 }); }
  // Watchtower and communications equipment.
  for (const x of [34, 40]) for (const z of [-62, -56]) box(0.38, 7, 0.38, x, 3.5, z, 0x555d49, true);
  box(7.2, 0.35, 7.2, 37, 5.6, -59, 0x626852); box(7.8, 0.28, 7.8, 37, 8.0, -59, t.roof);
  for (const z of [-62.4, -55.6]) { box(7, 0.13, 0.13, 37, 6.9, z, 0x566047); box(7, 0.13, 0.13, 37, 6.2, z, 0x566047); }
  for (const x of [33.6, 40.4]) box(0.13, 0.13, 7, x, 6.9, -59, 0x566047);
  for (let i = 0; i < 11; i++) box(1.1, 0.12, 0.18, 37, 0.5 + i * 0.46, -55.25, 0x68735a);
  box(0.12, 5.5, 0.12, 36.4, 2.75, -55.25, 0x68735a); box(0.12, 5.5, 0.12, 37.6, 2.75, -55.25, 0x68735a);
  // Distant harbor gantry cranes.
  if (map === "harbor") for (const x of [-72, 74]) { box(1.1, 30, 1.1, x, 15, -83, 0x6b7170); box(1.1, 30, 1.1, x + 13, 15, -83, 0x6b7170); box(37, 1.3, 1.7, x + 7, 29, -83, 0x777e74); box(0.08, 18, 0.08, x + 3, 19, -83, 0x434a47); }
  // Boundary barriers and mountains provide a readable, spacious arena.
  for (let i = 0; i < 44; i++) { const angle = i / 44 * Math.PI * 2; const radius = 167 + random() * 28; const height = 18 + random() * 48; const m = mesh(new THREE.ConeGeometry(28 + random() * 22, height, 5), t.mountain, Math.cos(angle) * radius, height / 2 - 4, Math.sin(angle) * radius); m.rotation.y = random() * Math.PI; }
  for (let i = 0; i < 40; i++) { const angle = i / 40 * Math.PI * 2; const r = 111; const m = mesh(new THREE.DodecahedronGeometry(2.8 + random() * 2), 0x777c68, Math.cos(angle) * r, 1.7, Math.sin(angle) * r); m.scale.set(1.7, 0.8, 1.5); }
  // Instanced foliage: hundreds of trees in only three draw calls.
  const count = low ? 145 : 240;
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.4, 5, 5), material(0x5b5940), count);
  const leaves = new THREE.InstancedMesh(new THREE.ConeGeometry(2.8, 7.4, 7), material(t.tree), count);
  const tops = new THREE.InstancedMesh(new THREE.ConeGeometry(2, 5.8, 7), material(t.treeTop), count);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    let x = (random() - 0.5) * 255, z = (random() - 0.5) * 255;
    if (Math.abs(x) < 50 && Math.abs(z) < 80) x += x < 0 ? -55 : 55;
    const scale = 0.75 + random() * 1.0;
    dummy.rotation.set(0, random() * 6.28, 0); dummy.scale.setScalar(scale);
    dummy.position.set(x, 2.5 * scale, z); dummy.updateMatrix(); trunks.setMatrixAt(i, dummy.matrix);
    dummy.position.y = 5.1 * scale; dummy.updateMatrix(); leaves.setMatrixAt(i, dummy.matrix);
    dummy.position.y = 8.4 * scale; dummy.updateMatrix(); tops.setMatrixAt(i, dummy.matrix);
    if (map === "desert") { dummy.scale.set(scale, scale * 0.32, scale); dummy.position.y = 5.1 * scale; dummy.updateMatrix(); leaves.setMatrixAt(i, dummy.matrix); dummy.position.y = 5.8 * scale; dummy.updateMatrix(); tops.setMatrixAt(i, dummy.matrix); }
    if (Math.abs(x) < 110 && Math.abs(z) < 110) colliders.push({ x, z, hw: 0.5, hd: 0.5, height: 7 });
  }
  trunks.castShadow = leaves.castShadow = tops.castShadow = !low; group.add(trunks, leaves, tops);
  // Scattered rocks.
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), material(map === "desert" ? 0xa08a65 : 0x797e6b), 70);
  for (let i = 0; i < 70; i++) { let x = (random() - 0.5) * 200, z = (random() - 0.5) * 200; if (Math.abs(x) < 40) x += x > 0 ? 40 : -40; dummy.position.set(x, 0.3, z); dummy.rotation.set(random(), random() * 3, random()); dummy.scale.set(0.6 + random() * 2, 0.6 + random(), 0.6 + random() * 2); dummy.updateMatrix(); rocks.setMatrixAt(i, dummy.matrix); }
  rocks.castShadow = !low; group.add(rocks);
  // Landing zone and objective marker.
  const pad = mesh(new THREE.CylinderGeometry(6.8, 6.8, 0.06, 48), 0x747964, 27, 0.03, 32);
  pad.receiveShadow = true; box(0.45, 0.04, 4, 25.6, 0.08, 32, 0xcbcba8); box(0.45, 0.04, 4, 28.4, 0.08, 32, 0xcbcba8); box(3.2, 0.04, 0.45, 27, 0.08, 32, 0xcbcba8);
  box(0.15, 8.5, 0.15, -4, 4.25, -34, 0x8d9a78);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.9, 1.5, 8, 1), new THREE.MeshStandardMaterial({ color: 0xc1dc86, side: THREE.DoubleSide, roughness: 1 })); flag.position.set(-2.55, 7.45, -34); group.add(flag);
  const ring = new THREE.Mesh(new THREE.RingGeometry(3.8, 3.9, 48), new THREE.MeshBasicMaterial({ color: 0xb3db81, transparent: true, opacity: 0.6, side: THREE.DoubleSide })); ring.rotation.x = -Math.PI / 2; ring.position.set(0, 0.04, -35); group.add(ring);
  // Bake static geometry by material for mobile-friendly draw counts.
  group.updateMatrixWorld(true);
  const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const item of statics) {
    const m = item.material as THREE.Material; const geometry = item.geometry.clone().applyMatrix4(item.matrixWorld);
    if (!batches.has(m)) batches.set(m, []); batches.get(m)!.push(geometry); group.remove(item);
  }
  for (const [mat, geometries] of batches) { const geometry = mergeGeometries(geometries, false); if (geometry) { const item = new THREE.Mesh(geometry, mat); item.castShadow = !low; item.receiveShadow = true; group.add(item); solids.push(item); } geometries.forEach(g => g.dispose()); }
  const sourceGeometries = new Set(statics.map(m => m.geometry)); sourceGeometries.forEach(g => g.dispose());
  return { group, colliders, solids, flag, spawn: new THREE.Vector3(0, 1.72, 18) };
}

export type Soldier = { group: THREE.Group; leftLeg: THREE.Group; rightLeg: THREE.Group; leftArm: THREE.Group; rightArm: THREE.Group; marker: THREE.Sprite; flash: THREE.Mesh; materials: THREE.Material[] };
export function createSoldier(name: string, bot = true): Soldier {
  const group = new THREE.Group();
  const clothing = new THREE.MeshLambertMaterial({ color: bot ? 0x66694b : 0x48635a });
  const armor = new THREE.MeshLambertMaterial({ color: 0x303c2d }); const dark = new THREE.MeshLambertMaterial({ color: 0x242b23 });
  const skin = new THREE.MeshLambertMaterial({ color: 0x8f9071 }); const accent = new THREE.MeshBasicMaterial({ color: bot ? 0xf57a4a : 0xf9a76b });
  const g = new THREE.BoxGeometry(1, 1, 1);
  const part = (parent: THREE.Group, w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material) => { const m = new THREE.Mesh(g, material); m.scale.set(w, h, d); m.position.set(x, y, z); parent.add(m); return m; };
  part(group, 0.7, 0.65, 0.4, 0, 1.18, 0, clothing); part(group, 0.64, 0.53, 0.18, 0, 1.2, 0.22, armor);
  part(group, 0.59, 0.23, 0.16, 0, 1.06, 0.32, armor); part(group, 0.6, 0.46, 0.25, 0, 1.2, -0.25, armor);
  part(group, 0.35, 0.35, 0.33, 0, 1.7, 0, skin);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.265, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), armor); helmet.position.set(0, 1.77, 0); group.add(helmet);
  part(group, 0.42, 0.12, 0.38, 0, 1.8, 0, armor); part(group, 0.3, 0.07, 0.05, 0, 1.73, 0.19, accent); part(group, 0.34, 0.14, 0.08, 0, 1.6, 0.18, dark);
  const leftLeg = new THREE.Group(); leftLeg.position.set(-0.19, 0.86, 0); group.add(leftLeg);
  const rightLeg = new THREE.Group(); rightLeg.position.set(0.19, 0.86, 0); group.add(rightLeg);
  for (const leg of [leftLeg, rightLeg]) { part(leg, 0.27, 0.69, 0.3, 0, -0.3, 0, clothing); part(leg, 0.29, 0.19, 0.35, 0, -0.64, 0.04, dark); part(leg, 0.2, 0.21, 0.07, 0, -0.32, 0.16, armor); }
  const leftArm = new THREE.Group(); leftArm.position.set(-0.42, 1.43, 0); group.add(leftArm);
  const rightArm = new THREE.Group(); rightArm.position.set(0.42, 1.43, 0); group.add(rightArm);
  for (const arm of [leftArm, rightArm]) { part(arm, 0.23, 0.48, 0.25, 0, -0.18, 0.08, clothing); part(arm, 0.245, 0.1, 0.26, 0, -0.09, 0.08, accent); part(arm, 0.22, 0.18, 0.3, 0, -0.37, 0.2, dark); }
  part(group, 0.14, 0.16, 0.8, 0.2, 1.17, 0.4, dark); part(group, 0.07, 0.07, 0.35, 0.2, 1.2, 0.95, dark);
  const flashMaterial = new THREE.MeshBasicMaterial({ color: 0xffde7d, transparent: true, opacity: 0.9 });
  const flash = new THREE.Mesh(new THREE.OctahedronGeometry(0.2), flashMaterial); flash.scale.set(0.8, 0.8, 2); flash.position.set(0.2, 1.2, 1.2); flash.visible = false; group.add(flash);
  const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 48; const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgba(17,24,15,0.72)"; ctx.roundRect(0, 0, 256, 48, 4); ctx.fill(); ctx.fillStyle = bot ? "#ffb79b" : "#ffd49b"; ctx.font = "600 21px Arial"; ctx.textAlign = "center"; ctx.fillText(name.slice(0, 19).toUpperCase(), 128, 31);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const markerMat = new THREE.SpriteMaterial({ map: texture, depthTest: true, transparent: true }); const marker = new THREE.Sprite(markerMat); marker.scale.set(2.45, 0.46, 1); marker.position.y = 2.55; group.add(marker);
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.55, 16), new THREE.MeshBasicMaterial({ color: 0x172112, transparent: true, opacity: 0.28, depthWrite: false })); shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.025; group.add(shadow);
  return { group, leftLeg, rightLeg, leftArm, rightArm, marker, flash, materials: [clothing, armor, dark, skin, accent, flashMaterial, markerMat, shadow.material] };
}

export function createWeapon() {
  const group = new THREE.Group(); const metal = new THREE.MeshStandardMaterial({ color: 0x29322b, roughness: 0.6, metalness: 0.5 }); const olive = new THREE.MeshStandardMaterial({ color: 0x5a6244, roughness: 0.85 }); const black = new THREE.MeshStandardMaterial({ color: 0x171d18, roughness: 0.65 });
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.castShadow = false; group.add(m); return m; };
  box(0.115, 0.13, 0.48, 0, 0, 0, metal); box(0.105, 0.11, 0.3, 0, -0.01, -0.31, olive);
  box(0.1, 0.105, 0.26, 0, -0.01, 0.29, olive); box(0.12, 0.16, 0.06, 0, -0.035, 0.42, black);
  const mag = box(0.07, 0.22, 0.12, 0, -0.16, -0.02, black); mag.rotation.x = -0.18;
  const grip = box(0.075, 0.16, 0.075, 0, -0.13, 0.12, olive); grip.rotation.x = -0.23;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.021, 0.27, 8), metal); barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.015, -0.55); group.add(barrel);
  const suppressor = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.16, 8), black); suppressor.rotation.x = Math.PI / 2; suppressor.position.set(0, 0.015, -0.72); group.add(suppressor);
  box(0.075, 0.045, 0.1, 0, 0.09, -0.02, black); box(0.022, 0.07, 0.06, -0.04, 0.13, -0.02, metal); box(0.022, 0.07, 0.06, 0.04, 0.13, -0.02, metal); box(0.1, 0.019, 0.06, 0, 0.17, -0.02, metal);
  const glass = new THREE.MeshBasicMaterial({ color: 0xa3db9d, transparent: true, opacity: 0.18 }); box(0.06, 0.05, 0.003, 0, 0.125, -0.035, glass);
  for (let i = 0; i < 8; i++) box(0.12, 0.013, 0.014, 0, 0.066, -0.41 + i * 0.038, black);
  const glove = new THREE.MeshStandardMaterial({ color: 0x444b33, roughness: 1 }); const sleeve = new THREE.MeshStandardMaterial({ color: 0x6a7053, roughness: 1 });
  const arm1 = box(0.11, 0.11, 0.27, 0.015, -0.13, 0.28, sleeve); arm1.rotation.x = -0.26;
  box(0.1, 0.1, 0.13, 0, -0.105, 0.12, glove); const arm2 = box(0.1, 0.11, 0.43, -0.15, -0.14, -0.07, sleeve); arm2.rotation.y = -0.32; box(0.13, 0.1, 0.1, -0.08, -0.07, -0.25, glove);
  const flash = new THREE.Mesh(new THREE.OctahedronGeometry(0.12), new THREE.MeshBasicMaterial({ color: 0xffda75, transparent: true, opacity: 0.95, depthTest: false })); flash.position.set(0, 0.015, -0.84); flash.scale.set(0.7, 0.7, 2); flash.visible = false; group.add(flash);
  group.position.set(0.3, -0.26, -0.51); group.rotation.y = -0.02;
  group.traverse(item => { if (item instanceof THREE.Mesh) { item.frustumCulled = false; item.renderOrder = 2; } });
  return { group, flash };
}
