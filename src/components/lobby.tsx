"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { ArrowDown, ArrowRight, AudioLines, BookOpen, Check, ChevronDown, ChevronRight, Copy, Crosshair, DoorOpen, Gamepad2, Globe2, Headphones, Layers3, LoaderCircle, LockKeyhole, Maximize, Monitor, Plus, Radio, RefreshCw, Search, Settings2, ShieldCheck, Signal, Smartphone, Swords, Target, Trophy, Users, Volume2, VolumeX, X, Zap } from "lucide-react";
import { DEFAULT_SETTINGS, MAPS, readLocalScores, type GameConfig, type GameResult, type GameSettings, type MapId, type Peer, type Room, type RoomSession } from "@/lib/game-types";

const Battle = dynamic(() => import("./battle"), { ssr: false, loading: () => <div className="game-loading"><Crosshair size={44} /><h2>PREPARING THE BATTLEFIELD</h2><span>Checking your equipment…</span></div> });
type ModalType = "create" | "join" | "help" | "settings" | "room" | null;
const initialRooms: Room[] = [
  { id: "public-valley", code: "VALLEY", name: "Valley Vanguard", map: "valley", mode: "ffa", capacity: 8, isPrivate: false, playerCount: 0, permanent: true },
  { id: "public-desert", code: "DUST01", name: "Desert Drifters", map: "desert", mode: "ffa", capacity: 8, isPrivate: false, playerCount: 0, permanent: true },
  { id: "public-harbor", code: "HARBOR", name: "Night Shift", map: "harbor", mode: "ffa", capacity: 8, isPrivate: false, playerCount: 0, permanent: true },
];
async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Connection interrupted. Please try again.");
  return data;
}
function Logo({ compact = false }: { compact?: boolean }) {
  return <span className="brand"><svg viewBox="0 0 38 42" fill="none" aria-hidden="true"><path d="M2 8 18 1v10l-7 3v13l7 4v10L2 32V8Z" fill="currentColor"/><path d="m21 1 15 7v10l-9-4v5l9 5v9l-15 8V30l7-3-7-5V1Z" fill="currentColor"/></svg>{!compact && <span>SQUAD<span>STRIKE</span><small>TACTICAL MULTIPLAYER</small></span>}</span>;
}
function Modal({ children, title, eyebrow, onClose, wide = false }: { children: ReactNode; title: string; eyebrow: string; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const overflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    const first = ref.current?.querySelector<HTMLElement>("input, button, select"); first?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
      if (event.key === "Tab") {
        const nodes = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, [tabindex="0"]');
        if (!nodes?.length) return;
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", handler);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", handler); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div ref={ref} className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-top"><div><span className="eyebrow">{eyebrow}</span><h2 id="modal-title">{title}</h2></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20}/></button></div>{children}</div></div>;
}

export default function Lobby() {
  const [tab, setTab] = useState("play");
  const [modal, setModal] = useState<ModalType>(null);
  const [ar, setAr] = useState(false);
  const [name, setName] = useState("OPERATOR_07");
  const [settings, setSettings] = useState<GameSettings>(DEFAULT_SETTINGS);
  const [hydrated, setHydrated] = useState(false);
  const [roomList, setRoomList] = useState<Room[]>(initialRooms);
  const [connected, setConnected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [session, setSession] = useState<RoomSession | null>(null);
  const [members, setMembers] = useState<Peer[]>([]);
  const [game, setGame] = useState<GameConfig | null>(null);
  const [localScores, setLocalScores] = useState<GameResult[]>([]);
  const [globalScores, setGlobalScores] = useState<GameResult[]>([]);
  const [scoreTab, setScoreTab] = useState("local");
  const [scoreLoading, setScoreLoading] = useState(false);
  const [scoreError, setScoreError] = useState("");
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [roomName, setRoomName] = useState("The Wolf Pack");
  const [selectedMap, setSelectedMap] = useState<MapId>("valley");
  const [capacity, setCapacity] = useState(8);
  const [isPrivate, setIsPrivate] = useState(false);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const tr = (en: string, arabic: string) => ar ? arabic : en;

  useEffect(() => {
    try {
      setName(localStorage.getItem("squadstrike-name") || "OPERATOR_07");
      setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("squadstrike-settings") || "{}") });
      setAr(localStorage.getItem("squadstrike-language") === "ar");
    } catch { /* Storage is optional in private browsing. */ }
    setLocalScores(readLocalScores()); setHydrated(true);
    const code = new URLSearchParams(location.search).get("room");
    if (code) { setJoinCode(code.toUpperCase().slice(0, 6)); setModal("join"); }
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    document.documentElement.lang = ar ? "ar" : "en";
    try { localStorage.setItem("squadstrike-name", name); localStorage.setItem("squadstrike-settings", JSON.stringify(settings)); localStorage.setItem("squadstrike-language", ar ? "ar" : "en"); } catch { /* Keep working without storage. */ }
  }, [name, settings, ar, hydrated]);
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(""), 3500); return () => clearTimeout(timer); } }, [toast]);
  const refreshRooms = useCallback(async () => {
    setRefreshing(true);
    try { const data = await api<{ rooms: Room[] }>("/api/rooms"); setRoomList(data.rooms); setConnected(true); }
    catch { setConnected(false); }
    finally { setRefreshing(false); }
  }, []);
  useEffect(() => { refreshRooms(); const timer = setInterval(refreshRooms, 12000); return () => clearInterval(timer); }, [refreshRooms]);
  useEffect(() => {
    if (!session || game) return;
    let alive = true;
    const heartbeat = async () => {
      try {
        const data = await api<{ peers: Peer[]; self: Peer }>(`/api/rooms/${session.room.code}/sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: session.token, playing: false }) });
        if (alive) setMembers([data.self, ...data.peers]);
      } catch { if (alive) setError("Reconnecting to your squad…"); }
    };
    heartbeat(); const timer = setInterval(heartbeat, 2500);
    return () => { alive = false; clearInterval(timer); };
  }, [session, game]);
  useEffect(() => {
    if (tab !== "leaderboard" || scoreTab !== "global") return;
    let alive = true; setScoreLoading(true); setScoreError("");
    api<{ scores: GameResult[] }>("/api/scores").then(data => { if (alive) setGlobalScores(data.scores); }).catch(e => { if (alive) setScoreError(e.message); }).finally(() => { if (alive) setScoreLoading(false); });
    return () => { alive = false; };
  }, [tab, scoreTab]);

  function openModal(type: ModalType) { setError(""); setModal(type); }
  function play(map: MapId = "valley", roomSession?: RoomSession) { setModal(null); setGame({ map, name: name.trim() || "OPERATOR", settings, session: roomSession }); }
  async function joinRoom(code: string) {
    setBusy(true); setError("");
    try { const data = await api<RoomSession>(`/api/rooms/${encodeURIComponent(code.toUpperCase())}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }); setSession(data); setMembers([]); setModal("room"); }
    catch (e) { setError((e as Error).message); if (modal !== "join") setModal("join"); }
    finally { setBusy(false); }
  }
  async function createRoom(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { const data = await api<RoomSession>("/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: roomName, playerName: name, map: selectedMap, capacity, isPrivate }) }); setSession(data); setMembers([]); setModal("room"); refreshRooms(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function leaveRoom() {
    if (session) fetch(`/api/rooms/${session.room.code}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: session.token }), keepalive: true }).catch(() => {});
    setSession(null); setMembers([]); setModal(null); setError(""); refreshRooms();
  }
  async function copyInvite() {
    if (!session) return;
    const link = `${location.origin}${location.pathname}?room=${session.room.code}`;
    try { await navigator.clipboard.writeText(link); setToast(tr("Invite link copied. Your squad is one click away.", "تم نسخ الدعوة. أرسل الرابط لأصدقائك.")); }
    catch { setToast(`${tr("Share this room code", "شارك رمز الغرفة")}: ${session.room.code}`); }
  }
  function recordResult(result: GameResult) {
    const scores = [...readLocalScores().filter(s => s.id !== result.id), result].sort((a, b) => b.score - a.score).slice(0, 20);
    try { localStorage.setItem("squadstrike-scores", JSON.stringify(scores)); } catch { /* Display in memory. */ }
    setLocalScores(scores);
    fetch("/api/scores", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) }).catch(() => {});
  }
  const displayedScores = scoreTab === "local" ? localScores : globalScores;
  const filteredRooms = roomList.filter(room => (filter === "all" || room.map === filter) && `${room.name} ${MAPS.find(m => m.id === room.map)?.name}`.toLowerCase().includes(search.toLowerCase()));
  const activePlayers = roomList.reduce((sum, room) => sum + room.playerCount, 0);

  if (game) return <Battle config={game} ar={ar} onResult={recordResult} onExit={() => { setGame(null); setLocalScores(readLocalScores()); if (session) setModal("room"); refreshRooms(); }} />;

  const renderCard = (room: Room) => {
    const map = MAPS.find(m => m.id === room.map) || MAPS[0];
    return <button key={room.id} className={`room-card map-${map.id}`} disabled={busy || room.playerCount >= room.capacity} onClick={() => { setJoinCode(room.code); joinRoom(room.code); }} aria-label={`Join ${room.name} on ${map.name}`}><div className="room-image"><img src={map.image} alt="" loading="lazy"/><div className="room-image-shade"/><span className="map-mode"><Crosshair size={11}/>{tr("FREE FOR ALL", "قتال حر")}</span><span className="room-open"><Signal size={13}/>{room.playerCount >= room.capacity ? tr("FULL", "ممتلئة") : tr("OPEN", "متاحة")}</span><span className="map-region">{map.region}</span></div><div className="room-card-body"><div><h3>{map.name}</h3><span className="room-card-meta">{room.name}<span>·</span>{room.playerCount === 0 ? tr("Bots ready", "خصوم جاهزون") : tr("Battle in progress", "المعركة مستمرة")}</span></div><div className="room-card-right"><span><Users size={13}/><b>{room.playerCount}</b><span>/ {room.capacity}</span></span><span className="join-arrow"><ArrowRight size={17}/></span></div></div></button>;
  };

  return <div className={`app-shell ${ar ? "arabic" : ""}`} dir={ar ? "rtl" : "ltr"}>
    <header className="site-header"><div className="header-inner"><button className="brand-button" aria-label="SquadStrike home" onClick={() => setTab("play")}><Logo/></button><nav className="main-nav" aria-label="Main navigation"><button className={tab === "play" ? "active" : ""} onClick={() => setTab("play")}><Gamepad2 size={16}/>{tr("Play", "العب")}</button><button className={tab === "rooms" ? "active" : ""} onClick={() => setTab("rooms")}><DoorOpen size={16}/>{tr("Rooms", "الغرف")}</button><button className={tab === "leaderboard" ? "active" : ""} onClick={() => setTab("leaderboard")}><Trophy size={16}/>{tr("Leaderboard", "المتصدرون")}</button><button onClick={() => openModal("help")}><BookOpen size={16}/>{tr("How to play", "طريقة اللعب")}</button></nav><div className="header-actions"><span className={`server-status ${connected ? "connected" : ""}`}><span className="status-dot"/>{connected ? tr("SYSTEMS ONLINE", "متصل بالخادم") : tr("SOLO READY", "اللعب الفردي جاهز")}</span><button className="icon-button language-toggle" aria-label={ar ? "Switch to English" : "التبديل إلى العربية"} title={ar ? "English" : "العربية"} onClick={() => setAr(!ar)}>{ar ? "EN" : "ع"}</button><button className="icon-button sound-toggle" title={settings.sound ? "Mute sound" : "Enable sound"} aria-label={settings.sound ? "Mute sound" : "Enable sound"} onClick={() => setSettings(s => ({ ...s, sound: !s.sound }))}>{settings.sound ? <Volume2 size={17}/> : <VolumeX size={17}/>}</button><button className="profile-button" onClick={() => openModal("settings")} aria-label="Operator profile and settings"><span className="avatar"><img src="/images/battlefield-hero.jpg" alt=""/></span><span><b>{name}</b><small>{tr("ROOKIE", "مبتدئ")}<span>LVL 01</span></small></span><ChevronDown size={13}/></button></div></div></header>

    <main className="lobby-main">
      {tab === "play" && <>
        <div className="welcome-row"><div><div className="eyebrow"><span className="tiny-cross">+</span>{tr("YOUR SQUAD. YOUR BATTLEFIELD.", "فريقك. ساحة معركتك.")}</div><h1>{tr("WELCOME TO THE FRONTLINE.", "مرحبًا بك في خط المواجهة.")}</h1></div><button className="invite-nudge" onClick={() => openModal("create")}><span className="squad-avatars"><span><img src="/images/battlefield-hero.jpg" alt=""/></span><span><ShieldCheck size={15}/></span><span><Plus size={15}/></span></span><span><b>{tr("Better with your people.", "المعركة أحلى مع أصدقائك.")}</b><small>{tr("Bring your squad", "ادعُ فريقك")}<ArrowRight size={12}/></small></span></button></div>
        <section className="hero" aria-label="Start playing SquadStrike"><img className="hero-art" src="/images/battlefield-hero.jpg" alt="Tactical operator overlooking a forest battlefield" fetchPriority="high"/><div className="hero-shade"/><div className="hero-scanline"/><div className="hero-content"><div className="hero-eyebrow"><span className="status-dot"/>{tr("MULTIPLAYER. ZERO DOWNLOADS.", "قتال جماعي. بدون تحميل.")}</div><h2>{tr("LOCK IN.", "استعد.")}<br/><span>{tr("SQUAD UP.", "واجمع فريقك.")}</span></h2><p>{tr("Big maps. Close calls. Your friends by your side.", "خرائط واسعة. معارك حماسية. وأصدقاؤك بجانبك.")}<br/>{tr("The next great battle starts with you.", "المعركة القادمة تبدأ معك.")}</p><div className="hero-buttons"><button className="button button-primary quick-play" onClick={() => play()}><span className="play-triangle"/>{tr("QUICK PLAY", "العب الآن")}<ArrowRight size={18}/></button><button className="button button-ghost" onClick={() => openModal("create")}><Plus size={18}/>{tr("CREATE ROOM", "أنشئ غرفة")}</button></div><span className="instant-note"><Zap size={11}/>{tr("Straight into the action. No sign-up needed.", "ابدأ فورًا. لا حاجة للتسجيل.")}</span></div><div className="hero-operation"><span className="live-chip"><Radio size={12}/>{tr("LIVE OPERATION", "عملية مباشرة")}</span><b>VERDANT VALLEY</b><span>48° 15′ N &nbsp; 11° 34′ E</span></div><div className="hero-bottom"><span><Users size={14}/>{tr("UP TO 8 PLAYERS", "حتى ٨ لاعبين")}</span><i/><span><Layers3 size={14}/>{tr("3 OPEN BATTLEFIELDS", "٣ ساحات واسعة")}</span><i/><span><Monitor size={14}/><Smartphone size={12}/>{tr("DESKTOP & MOBILE", "كمبيوتر وهاتف")}</span><span className="hero-bottom-end">01 <span>/ 03</span><span className="slide-line"/></span></div></section>
        <section className="battlefields-section"><div className="section-heading"><div><h2>{tr("LIVE BATTLEFIELDS", "ساحات القتال")}</h2><span className="room-count"><span className="status-dot"/>{roomList.length} {tr("rooms available", "غرف متاحة")}</span></div><div className="section-actions"><button onClick={() => openModal("join")}><DoorOpen size={14}/>{tr("Join with code", "انضم برمز")}</button><span className="divider"/><button className="text-link" onClick={() => setTab("rooms")}>{tr("View all rooms", "كل الغرف")}<ArrowRight size={14}/></button></div></div><div className="room-grid">{roomList.slice(0, 3).map(renderCard)}</div></section>
        <section className="feature-strip" aria-label="Game features"><div><span className="feature-icon"><Crosshair size={24}/></span><span><b>{tr("ALL SKILL. NO SHORTCUTS.", "مهارتك تصنع الفرق.")}</b><p>{tr("Pure, fast-paced 3D combat. Every shot counts.", "قتال ثلاثي الأبعاد سريع. كل طلقة مهمة.")}</p></span></div><div><span className="feature-icon"><Users size={25}/></span><span><b>{tr("YOUR FRIENDS. YOUR RULES.", "أصدقاؤك. قواعدك.")}</b><p>{tr("Create a room. Share a code. Make some memories.", "أنشئ غرفة. شارك الرمز. اصنع الذكريات.")}</p></span></div><div><span className="feature-icon"><Smartphone size={24}/></span><span><b>{tr("ANY SCREEN. SAME ADRENALINE.", "أي شاشة. نفس الحماس.")}</b><p>{tr("Built for keyboard, mouse, and thumbs.", "مصممة للوحة المفاتيح والماوس واللمس.")}</p></span></div></section>
      </>}

      {tab === "rooms" && <section className="rooms-page"><div className="page-title-row"><div><span className="eyebrow">{tr("FIND YOUR PEOPLE", "اعثر على فريقك")}</span><h1>{tr("CHOOSE YOUR BATTLEFIELD.", "اختر ساحة معركتك.")}</h1><p>{tr("Join the action, or make a little room for your friends.", "انضم إلى القتال أو أنشئ غرفة لأصدقائك.")}</p></div><button className="button button-primary" onClick={() => openModal("create")}><Plus size={17}/>{tr("CREATE ROOM", "أنشئ غرفة")}</button></div><div className="rooms-toolbar"><div className="filter-tabs"><button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>{tr("All maps", "كل الخرائط")}</button>{MAPS.map(map => <button key={map.id} className={filter === map.id ? "selected" : ""} onClick={() => setFilter(map.id)}>{map.name}</button>)}</div><div className="room-search"><Search size={16}/><input aria-label="Search rooms" placeholder={tr("Find a room…", "ابحث عن غرفة…")} value={search} onChange={e => setSearch(e.target.value)}/><button className="icon-button" onClick={refreshRooms} aria-label="Refresh rooms"><RefreshCw size={15} className={refreshing ? "spin" : ""}/></button></div></div><div className="room-grid all-rooms">{filteredRooms.map(renderCard)}</div>{filteredRooms.length === 0 && <div className="empty-state"><Search size={34}/><h3>{tr("NO ROOMS IN SIGHT", "لا توجد غرف")}</h3><p>{tr("Try another search, or create the first room here.", "جرّب بحثًا آخر أو أنشئ غرفة جديدة.")}</p><button className="button button-ghost" onClick={() => { setSearch(""); setFilter("all"); }}>{tr("CLEAR FILTERS", "مسح التصفية")}</button></div>}<div className="invite-banner"><div><LockKeyhole size={25}/><span><h3>{tr("GOT AN INVITE?", "لديك دعوة؟")}</h3><p>{tr("Your squad is waiting. Enter their 6-character room code.", "فريقك ينتظرك. أدخل رمز الغرفة المكوّن من ٦ أحرف.")}</p></span></div><button className="button button-ghost" onClick={() => openModal("join")}>{tr("JOIN WITH CODE", "انضم برمز")}<ArrowRight size={16}/></button></div></section>}

      {tab === "leaderboard" && <section className="leaderboard-page"><div className="page-title-row"><div><span className="eyebrow">{tr("THE HALL OF OPERATORS", "قاعة الأبطال")}</span><h1>{tr("MAKE YOUR MARK.", "اترك بصمتك.")}</h1><p>{tr("One more round. One higher score. A new personal best.", "جولة إضافية. نقاط أعلى. رقم قياسي جديد.")}</p></div><div className="personal-best"><Trophy size={26}/><span><small>{tr("PERSONAL BEST", "أفضل نتيجة")}</small><b>{(localScores[0]?.score || 0).toLocaleString()} <span>PTS</span></b></span></div></div><div className="leaderboard-toolbar"><div className="filter-tabs"><button className={scoreTab === "local" ? "selected" : ""} onClick={() => setScoreTab("local")}><Monitor size={14}/>{tr("On this device", "على هذا الجهاز")}</button><button className={scoreTab === "global" ? "selected" : ""} onClick={() => setScoreTab("global")}><Globe2 size={14}/>{tr("Global operators", "أبطال العالم")}</button></div><span className="eyebrow">TOP 20 · {tr("ALL TIME", "كل الأوقات")}</span></div>{scoreLoading ? <div className="empty-state"><LoaderCircle className="spin" size={32}/><p>{tr("Retrieving field reports…", "جاري تحميل النتائج…")}</p></div> : scoreError ? <div className="empty-state"><Signal size={32}/><p>{scoreError}</p></div> : displayedScores.length ? <div className="score-table-wrap"><table className="score-table"><thead><tr>{[tr("RANK", "الترتيب"), tr("OPERATOR", "اللاعب"), tr("BATTLEFIELD", "الخريطة"), tr("ELIMINATIONS", "الإقصاءات"), tr("SCORE", "النتيجة")].map(s => <th key={s}>{s}</th>)}</tr></thead><tbody>{displayedScores.map((score, i) => <tr key={score.id}><td><span className={`rank rank-${i}`}>{i === 0 ? <Trophy size={18}/> : String(i + 1).padStart(2, "0")}</span></td><td><span className="table-avatar"><ShieldCheck size={17}/></span><b>{score.name}</b></td><td>{MAPS.find(m => m.id === score.map)?.name}</td><td>{score.kills}</td><td className="score-value">{score.score.toLocaleString()}<small>PTS</small></td></tr>)}</tbody></table></div> : <div className="empty-state leaderboard-empty"><div className="empty-emblem"><Trophy size={38}/></div><span className="eyebrow">{tr("EVERY LEGEND STARTS SOMEWHERE", "كل بطل يبدأ من هنا")}</span><h3>{tr("THE TOP SPOT COULD BE YOURS.", "المركز الأول قد يكون لك.")}</h3><p>{tr("Finish your first match to put your name on the board.", "أكمل أول مباراة لتسجيل اسمك في لوحة المتصدرين.")}</p><button className="button button-primary" onClick={() => play()}><Swords size={17}/>{tr("PLAY YOUR FIRST ROUND", "ابدأ جولتك الأولى")}<ArrowRight size={16}/></button></div>}<p className="leaderboard-note"><ShieldCheck size={14}/>{tr("Local scores stay on this browser. Global rankings are community-submitted match results.", "النتائج المحلية محفوظة في هذا المتصفح. الترتيب العالمي يعرض نتائج مباريات اللاعبين.")}</p></section>}
    </main>

    <footer className="site-footer"><div><Logo compact/><span>© 2026 SQUADSTRIKE<span className="footer-dot">·</span>{tr("BUILT FOR THE SQUAD.", "صُنعت لفريقك.")}</span></div><div><span className="footer-online"><span className="status-dot"/>{activePlayers} {tr("operators online", "لاعب متصل")}</span><button onClick={() => { setAr(!ar); }}><Globe2 size={13}/>{ar ? "English" : "العربية"}</button><button onClick={() => openModal("settings")} aria-label="Game settings"><Settings2 size={15}/><span>{tr("Settings", "الإعدادات")}</span></button><span className="build-label">V.1.0.4</span></div></footer>
    {toast && <div className="toast" role="status"><Check size={18}/>{toast}</div>}
    {busy && !modal && <div className="connection-toast" role="status"><LoaderCircle className="spin" size={18}/>{tr("Connecting to battlefield…", "جارٍ الاتصال بالساحة…")}</div>}

    {modal === "create" && <Modal title={tr("BUILD YOUR SQUAD.", "اجمع فريقك.")} eyebrow={tr("YOUR ROOM. YOUR BATTLE.", "غرفتك. معركتك.")} onClose={() => setModal(null)} wide><form onSubmit={createRoom}><label className="field-label" htmlFor="room-name">{tr("ROOM NAME", "اسم الغرفة")}</label><input className="text-input" id="room-name" value={roomName} onChange={e => setRoomName(e.target.value)} maxLength={24} required placeholder="The Wolf Pack"/><label className="field-label">{tr("CHOOSE YOUR BATTLEFIELD", "اختر ساحة المعركة")}</label><div className="map-picker">{MAPS.map(map => <button type="button" key={map.id} className={selectedMap === map.id ? "selected" : ""} onClick={() => setSelectedMap(map.id)} aria-pressed={selectedMap === map.id}><img src={map.image} alt=""/><span>{map.name}</span>{selectedMap === map.id && <span className="map-check"><Check size={12}/></span>}</button>)}</div><div className="form-two"><div><label className="field-label" htmlFor="capacity">{tr("SQUAD SIZE", "عدد اللاعبين")}</label><select id="capacity" className="text-input" value={capacity} onChange={e => setCapacity(Number(e.target.value))}><option value={2}>2 players</option><option value={4}>4 players</option><option value={8}>8 players</option></select></div><div><label className="field-label" htmlFor="visibility">{tr("VISIBILITY", "خصوصية الغرفة")}</label><select id="visibility" className="text-input" value={String(isPrivate)} onChange={e => setIsPrivate(e.target.value === "true")}><option value="false">{tr("Public · anyone can join", "عامة · متاحة للجميع")}</option><option value="true">{tr("Private · invite only", "خاصة · بالدعوة فقط")}</option></select></div></div><div className="info-note"><ShieldCheck size={17}/><span>{tr("Free-for-all combat. Bots keep you warmed up until your friends deploy.", "قتال حر. تدرب ضد الخصوم حتى ينضم أصدقاؤك.")}</span></div>{error && <p className="form-error" role="alert">{error}</p>}<button disabled={busy} className="button button-primary full-width" type="submit">{busy ? <LoaderCircle className="spin" size={17}/> : <Plus size={17}/>} {tr("CREATE ROOM", "أنشئ غرفة")}<ArrowRight size={17}/></button></form></Modal>}

    {modal === "join" && <Modal title={tr("YOUR SQUAD IS WAITING.", "فريقك في انتظارك.")} eyebrow={tr("JOIN THE OPERATION", "انضم إلى العملية")} onClose={() => setModal(null)}><p className="modal-description">{tr("Enter the 6-character code from your friend’s room. You’ll be on the same battlefield in seconds.", "أدخل رمز غرفة صديقك المكوّن من ٦ أحرف. ستكونون في نفس الساحة خلال ثوانٍ.")}</p><form onSubmit={e => { e.preventDefault(); joinRoom(joinCode); }}><label className="field-label" htmlFor="join-code">{tr("ROOM CODE", "رمز الغرفة")}</label><input id="join-code" className="text-input code-input" value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} minLength={6} maxLength={6} placeholder="ABC123" autoComplete="off" required/>{error && <p className="form-error" role="alert">{error}</p>}<button className="button button-primary full-width" disabled={busy || joinCode.length !== 6}>{busy ? <LoaderCircle className="spin" size={17}/> : <DoorOpen size={17}/>} {tr("JOIN ROOM", "انضم للغرفة")}<ArrowRight size={17}/></button></form><p className="modal-footnote"><LockKeyhole size={12}/>{tr("No account. No downloads. Just your squad.", "بلا حساب. بلا تحميل. فقط أنت وفريقك.")}</p></Modal>}

    {modal === "room" && session && <Modal title={session.room.name.toUpperCase()} eyebrow={tr("SQUAD ASSEMBLY", "تجميع الفريق")} onClose={leaveRoom}><div className="room-preview"><img src={MAPS.find(m => m.id === session.room.map)?.image} alt=""/><span><Crosshair size={14}/>{MAPS.find(m => m.id === session.room.map)?.name}<small>FREE FOR ALL</small></span></div><div className="invite-code"><span><small>{tr("ROOM CODE · SHARE WITH FRIENDS", "رمز الغرفة · شاركه مع أصدقائك")}</small><b>{session.room.code}</b></span><button className="button button-ghost" onClick={copyInvite}><Copy size={15}/>{tr("COPY INVITE", "نسخ الدعوة")}</button></div><div className="squad-label"><span className="field-label">{tr("YOUR SQUAD", "فريقك")}</span><span>{members.length || 1} / {session.room.capacity}</span></div><div className="squad-list">{(members.length ? members : [{ id: session.playerId, name, playing: false }]).map(member => <div key={member.id}><span className="member-avatar"><ShieldCheck size={18}/></span><b>{member.name}</b>{member.id === session.playerId && <span className="you-tag">YOU</span>}<span className="member-ready"><span className="status-dot"/>{member.playing ? tr("IN BATTLE", "يقاتل") : tr("READY", "جاهز")}</span></div>)}{members.length < session.room.capacity && <div className="empty-member"><Plus size={18}/><span>{tr("A spot for your next squadmate", "مكان متاح لصديقك القادم")}</span></div>}</div><p className="modal-description small">{tr("Everyone deploys when ready. Share the invite to meet in the same arena. Bots fill the silence until your squad arrives.", "يمكن لكل لاعب الدخول عندما يكون جاهزًا. شارك الدعوة للقاء في نفس الساحة.")}</p>{error && <p className="form-error">{error}</p>}<button className="button button-primary full-width" onClick={() => play(session.room.map, session)}><Swords size={18}/>{tr("DEPLOY TO BATTLEFIELD", "انطلق إلى المعركة")}<ArrowRight size={18}/></button><button className="subtle-button full-width" onClick={leaveRoom}>{tr("Leave room", "مغادرة الغرفة")}</button></Modal>}

    {modal === "help" && <Modal title={tr("A QUICK FIELD BRIEFING.", "إحاطة سريعة قبل المعركة.")} eyebrow={tr("EASY TO LEARN. WORTH MASTERING.", "سهلة التعلم. ممتعة الإتقان.")} onClose={() => setModal(null)} wide><div className="briefing-objective"><Target size={28}/><div><b>{tr("3 MINUTES. MAKE EVERY SHOT COUNT.", "٣ دقائق. اجعل كل طلقة مهمة.")}</b><p>{tr("Survive enemy waves, earn 100 points per elimination, and chain kills for combo bonuses. Join a room to fight your friends instead.", "اصمد أمام موجات الخصوم، واحصل على ١٠٠ نقطة لكل إقصاء ومكافآت متتالية. انضم لغرفة لمقاتلة أصدقائك.")}</p></div></div><div className="control-columns"><div><h3><Monitor size={17}/>{tr("KEYBOARD & MOUSE", "لوحة المفاتيح والماوس")}</h3>{[["W A S D", tr("Move", "تحرك")], ["MOUSE", tr("Look around", "انظر حولك")], ["CLICK / F", tr("Fire weapon", "إطلاق النار")], ["RMB", tr("Aim down sights", "تصويب دقيق")], ["R", tr("Reload", "إعادة التلقيم")], ["SHIFT", tr("Sprint", "اركض")], ["SPACE", tr("Jump", "اقفز")], ["G", tr("Grenade", "قنبلة")], ["ESC / P", tr("Pause", "إيقاف مؤقت")]].map(([key, label]) => <div className="control-row" key={key}><kbd>{key}</kbd><span>{label}</span></div>)}</div><div><h3><Smartphone size={17}/>{tr("TOUCH CONTROLS", "تحكم باللمس")}</h3><div className="touch-diagram"><div className="diagram-stick"><span/></div><span className="diagram-look"><Crosshair size={30}/><ArrowRight size={20}/></span><span className="diagram-fire"><Crosshair size={21}/></span></div><p className="touch-help">{tr("Left thumb to move. Swipe the right side to look. Hold FIRE to shoot. Tap reload, jump, and grenade buttons when you need them.", "استخدم العصا اليسرى للحركة واسحب يمين الشاشة للنظر. اضغط مطولًا لإطلاق النار واستخدم أزرار التلقيم والقفز والقنابل.")}</p><div className="tip-box"><Zap size={17}/><p>{tr("Field tip: keep moving! Your health regenerates when you stay out of danger. Landscape feels best on mobile.", "نصيحة: لا تتوقف عن الحركة! تتجدد صحتك بعيدًا عن الخطر. الوضع الأفقي أفضل للهاتف.")}</p></div></div></div><button className="button button-primary full-width" onClick={() => play()}>{tr("GOT IT. LET’S PLAY.", "فهمت. لنلعب.")}<ArrowRight size={17}/></button></Modal>}

    {modal === "settings" && <Modal title={tr("YOUR FIELD SETUP.", "إعداداتك الميدانية.")} eyebrow={tr("OPERATOR SETTINGS", "إعدادات اللاعب")} onClose={() => setModal(null)}><label className="field-label" htmlFor="operator-name">{tr("CALLSIGN", "اسم اللاعب")}</label><input className="text-input" id="operator-name" maxLength={20} value={name} onChange={e => setName(e.target.value)} onBlur={() => { if (!name.trim()) setName("OPERATOR_07"); }}/><div className="setting-row"><span><Volume2 size={18}/><b>{tr("Sound effects", "المؤثرات الصوتية")}</b></span><button role="switch" aria-checked={settings.sound} aria-label="Sound effects" className={`toggle ${settings.sound ? "on" : ""}`} onClick={() => setSettings(s => ({ ...s, sound: !s.sound }))}><span/></button></div><label className="slider-label" htmlFor="volume">{tr("MASTER VOLUME", "مستوى الصوت")}<span>{Math.round(settings.volume * 100)}%</span></label><input id="volume" className="slider" type="range" min="0" max="1" step="0.05" value={settings.volume} onChange={e => setSettings(s => ({ ...s, volume: Number(e.target.value) }))}/><label className="slider-label" htmlFor="sensitivity">{tr("LOOK SENSITIVITY", "حساسية التصويب")}<span>{settings.sensitivity.toFixed(1)}×</span></label><input id="sensitivity" className="slider" type="range" min="0.4" max="2" step="0.1" value={settings.sensitivity} onChange={e => setSettings(s => ({ ...s, sensitivity: Number(e.target.value) }))}/><label className="field-label" htmlFor="quality">{tr("GRAPHICS QUALITY", "جودة الرسومات")}</label><select id="quality" className="text-input" value={settings.quality} onChange={e => setSettings(s => ({ ...s, quality: e.target.value as GameSettings["quality"] }))}><option value="auto">{tr("Adaptive · recommended", "تلقائية · موصى بها")}</option><option value="high">{tr("High · full detail", "عالية · تفاصيل كاملة")}</option><option value="low">{tr("Performance · lower resolution", "أداء · دقة أقل")}</option></select><div className="info-note"><Zap size={16}/><span>{tr("Settings are saved automatically on this device.", "تُحفظ الإعدادات تلقائيًا على هذا الجهاز.")}</span></div><button className="button button-primary full-width" onClick={() => setModal(null)}><Check size={17}/>{tr("READY FOR ACTION", "جاهز للمعركة")}</button></Modal>}
  </div>;
}
