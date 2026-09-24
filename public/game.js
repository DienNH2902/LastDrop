// Client prototype: Three.js scene, FPS controls and WebSocket room connection.
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.166.1/build/three.module.js";

const $ = (s) => document.querySelector(s),
  screens = [...document.querySelectorAll(".screen")];
const show = (id) => {
  screens.forEach((x) => x.classList.toggle("active", x.id === id));
};
const companySplash = $("#companySplash"),
  loading = $("#loading"),
  app = $("#app");
// Read the same duration used by the loading bar's CSS animation.
const loadingDurationMs =
  Number.parseFloat(getComputedStyle(loading).getPropertyValue("--loading-duration")) || 5000;
setTimeout(() => {
  companySplash.classList.add("hidden");
  loading.classList.remove("hidden");
  setTimeout(() => {
    loading.classList.add("hidden");
    app.classList.remove("hidden");
  }, loadingDurationMs);
}, 4000);
let socket = null,
  roomCode = "",
  playerId = "",
  isHost = false,
  gameState = null,
  scene,
  camera,
  renderer,
  clock,
  gun,
  local = {
    x: 0,
    z: 8,
    yaw: 0,
    hp: 100,
    kills: 0,
    crouching: false,
    jumping: false,
  };
let keys = {},
  ammo = 30,
  startedAt = 0,
  audioCtx = null,
  soundOn = true,
  lastMove = 0,
  paused = false,
  scoped = false,
  verticalSpeed = 0,
  grounded = true,
  jumpOffset = 0,
  baseFov = 76,
  mapObstacles = [],
  triggerHeld = false,
  fireInterval = null,
  lastHitEventId = 0,
  bloodParticles = [],
  resultTimeout = null,
  resultCountdown = null,
  resultEndsAt = 0;
const FIRE_INTERVAL_MS = 120;

// Movement
const STAND_HEIGHT = 1.65;
const CROUCH_HEIGHT = 1.05;
const PRONE_HEIGHT = 0.48;

const NORMAL_SPEED = 7;
const SLOW_SPEED = 3.2;
const CROUCH_SPEED = 3.8;
const CROUCH_SLOW_SPEED = 2.0;
const saved = JSON.parse(localStorage.getItem("ld-settings") || "{}");
$("#nameInput").value = saved.name || "Rookie";
$("#sensitivity").value = saved.sensitivity || 50;
$("#sfx").value = saved.sfx ?? 65;
$("#music").value = saved.music ?? 25;
function tone(freq = 440, duration = 0.06, type = "sine", volume = 0.03) {
  if (!soundOn) return;
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  const o = audioCtx.createOscillator(),
    g = audioCtx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.value = volume;
  o.connect(g);
  g.connect(audioCtx.destination);
  o.start();
  g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
  o.stop(audioCtx.currentTime + duration);
}
document
  .querySelectorAll("button")
  .forEach((b) =>
    b.addEventListener("mouseenter", () => tone(580, 0.025, "sine", 0.008)),
  );
document
  .querySelectorAll("button")
  .forEach((b) =>
    b.addEventListener("click", () => tone(310, 0.055, "triangle", 0.025)),
  );
$("#soundToggle").onclick = () => {
  soundOn = !soundOn;
  $("#soundToggle").textContent = soundOn ? "♫" : "♪";
};
document
  .querySelectorAll("[data-screen]")
  .forEach((b) => (b.onclick = () => show(b.dataset.screen)));
document.querySelectorAll(".back").forEach(
  (b) =>
    (b.onclick = () => {
      saveSettings();
      show("menu");
    }),
);
$("#sensitivity").oninput = (e) => ($("#sensVal").textContent = e.target.value);
$("#sfx").oninput = (e) => ($("#sfxVal").textContent = e.target.value + "%");
$("#music").oninput = (e) =>
  ($("#musicVal").textContent = e.target.value + "%");
function saveSettings() {
  localStorage.setItem(
    "ld-settings",
    JSON.stringify({
      name: $("#nameInput").value,
      sensitivity: $("#sensitivity").value,
      sfx: $("#sfx").value,
      music: $("#music").value,
      quality: $("#quality").value,
    }),
  );
}
$("#createBtn").onclick = () => connect({ type: "create" });
$("#joinBtn").onclick = () => {
  const code = $("#codeInput").value.trim();
  if (!/^\d{6}$/.test(code)) {
    alert("Nhập mã phòng gồm 6 chữ số.");
    return;
  }
  connect({ type: "join", code });
};
function connect(message) {
  if (socket) socket.close();
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}`);
  $("#status").textContent = "● CONNECTING";
  socket.onopen = () =>
    socket.send(
      JSON.stringify({ ...message, name: $("#nameInput").value || "Rookie" }),
    );
  socket.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "error") {
      alert(m.message);
      return;
    }
    if (m.type === "joined") {
      roomCode = m.code;
      playerId = m.playerId;
      isHost = m.isHost;
      local.x = m.spawn.x;
      local.z = m.spawn.z;
      $("#status").textContent = "● ONLINE";
      $("#roomCode").textContent = roomCode;
      $("#hudRoom").textContent = `ROOM ${roomCode}`;
      $("#startBtn").classList.toggle("hidden", !isHost);
      $("#lobbyHint").textContent = isHost
        ? "Bạn là chủ phòng. Bắt đầu khi mọi người đã sẵn sàng."
        : "Đang chờ chủ phòng bắt đầu...";
      show("lobby");
    }
    if (m.type === "state") {
      gameState = m;
      renderLobby();
      if (m.phase === "playing") {
        if (!$("#game").classList.contains("active")) beginGame();
        renderPlayers(m);
      }
      if (m.phase === "finished" && !$("#result").classList.contains("active")) {
        if (!$("#game").classList.contains("active")) beginGame();
        renderPlayers(m);
        showResult();
      }
    }
  };
  socket.onclose = () => {
    $("#status").textContent = "● OFFLINE";
  };
}
function send(data) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
}
function renderLobby() {
  if (!gameState) return;
  const slots = $("#slots");
  slots.innerHTML = "";
  for (let i = 0; i < 5; i++) {
    const p = gameState.players[i],
      el = document.createElement("div");
    el.className = "slot " + (p ? "filled" : "");
    el.innerHTML = p
      ? `<b>✦</b><strong>${escapeHtml(p.name)}</strong><small>${p.id === playerId ? "YOU" : p.id === gameState.players[0].id ? "HOST" : "READY"}</small>`
      : `<b>＋</b><small>ĐANG CHỜ</small>`;
    slots.append(el);
  }
  $("#lobbyHint").textContent =
    `${gameState.players.length}/5 người chơi trong phòng`;
  $("#startBtn").classList.toggle("hidden", !isHost);
}
$("#copyCode").onclick = async () => {
  try {
    await navigator.clipboard.writeText(roomCode);
    $("#copyCode").textContent = "ĐÃ SAO CHÉP";
    setTimeout(() => ($("#copyCode").textContent = "SAO CHÉP"), 1200);
  } catch {
    alert(`Mã phòng: ${roomCode}`);
  }
};
$("#startBtn").onclick = () => {
  send({ type: "start" });
};
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function makeMat(color, roughness = 1) {
  return new THREE.MeshStandardMaterial({ color, roughness });
}
function createObstacles(seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const spawns = [[-3, 8], [0, 8], [3, 8], [-3, -8], [0, -8]];
  const obstacles = [];
  for (let i = 0; i < 44; i++) {
    const x = (random() - 0.5) * 88;
    const z = (random() - 0.5) * 88;
    if (spawns.some(([sx, sz]) => Math.hypot(x - sx, z - sz) < 5)) continue;
    obstacles.push({ x, z, h: 1 + random() * 3, w: 0.6 + random() * 1.4, roof: i % 3 === 0 });
  }
  return obstacles;
}
const PLAYER_RADIUS = 0.38;
function isBlockedAt(x, z) {
  if (x < -49 || x > 49 || z < -49 || z > 49) return true;
  const selfRadius = local.prone ? 1.15 : PLAYER_RADIUS;
  for (const o of mapObstacles) {
    const closestX = Math.max(o.x - o.w / 2, Math.min(x, o.x + o.w / 2));
    const closestZ = Math.max(o.z - o.w / 2, Math.min(z, o.z + o.w / 2));
    if (Math.hypot(x - closestX, z - closestZ) < selfRadius) return true;
  }
  for (const p of gameState?.players || []) {
    if (p.id === playerId || !p.alive) continue;
    const otherRadius = p.prone ? 1.15 : PLAYER_RADIUS;
    if (Math.hypot(x - p.x, z - p.z) < selfRadius + otherRadius + 0.02) return true;
  }
  return false;
}
function initWorld() {
  const host = $("#world");
  host.innerHTML = "";
  scene = new THREE.Scene();
  scene.background = new THREE.Color("#a6b38d");
  scene.fog = new THREE.Fog("#a6b38d", 38, 100);
  baseFov = 76;
  const viewport = host.getBoundingClientRect();
  camera = new THREE.PerspectiveCamera(
    baseFov,
    viewport.width / viewport.height,
    0.1,
    180,
  );
  camera.position.set(local.x, 1.65, local.z);
  renderer = new THREE.WebGLRenderer({
    antialias: false,
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  // Render to the actual game panel, not the full browser window. The HUD
  // crosshair is centered in this panel; using innerHeight shifts the shot ray.
  renderer.setSize(viewport.width, viewport.height);
  renderer.shadowMap.enabled = false;
  renderer.domElement.style.display = "block";
  renderer.domElement.style.position = "absolute";
  renderer.domElement.style.inset = "0";
  host.append(renderer.domElement);
  clock = new THREE.Clock();
  scene.add(new THREE.HemisphereLight(0xe6f3d2, 0x555b3c, 2));
  const sun = new THREE.DirectionalLight(0xffedc5, 2);
  sun.position.set(-15, 30, 12);
  scene.add(sun);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(110, 110),
    makeMat("#737b56"),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  mapObstacles = createObstacles(gameState?.mapSeed ?? 305419896);
  for (const obstacle of mapObstacles) {
    const { x, z, h, w } = obstacle;
    const b = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, w),
      makeMat(obstacle.roof ? "#6a7555" : "#77745c"),
    );
    b.position.set(x, h / 2, z);
    scene.add(b);
    if (obstacle.roof) {
      const roof = new THREE.Mesh(
        new THREE.ConeGeometry(w * 1.1, 1.1, 4),
        makeMat("#544f3e"),
      );
      roof.position.set(x, h + 0.5, z);
      roof.rotation.y = Math.PI / 4;
      scene.add(roof);
    }
  }
  // First-person weapon silhouette attached to the camera.
  gun = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.14, 0.65),
    makeMat("#252923"),
  );
  body.position.set(0.28, -0.24, -0.55);
  gun.add(body);
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.025, 0.48, 8),
    makeMat("#171a16"),
  );
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0.28, -0.19, -0.98);
  gun.add(barrel);
  const stock = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.16, 0.24),
    makeMat("#645a43"),
  );
  stock.position.set(0.28, -0.25, -0.18);
  gun.add(stock);
  camera.add(gun);
  scene.add(camera);
  addEventListener("resize", resizeWorld);
  requestAnimationFrame(frame);
}
function resizeWorld() {
  if (!renderer) return;
  const viewport = $("#world").getBoundingClientRect();
  camera.aspect = viewport.width / viewport.height;
  camera.updateProjectionMatrix();
  renderer.setSize(viewport.width, viewport.height);
}
const remoteMeshes = new Map();
function spawnBloodBurst(position) {
  if (!scene) return;
  for (let i = 0; i < 13; i++) {
    const particle = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 5, 5),
      new THREE.MeshBasicMaterial({ color: i % 3 ? 0xb51228 : 0xf02e42 }),
    );
    particle.position.copy(position);
    particle.userData.velocity = new THREE.Vector3(
      (Math.random() - 0.5) * 5,
      Math.random() * 4.2,
      (Math.random() - 0.5) * 5,
    );
    particle.userData.life = 0.62;
    scene.add(particle);
    bloodParticles.push(particle);
  }
}
function showBloodScreenFlash() {
  const flash = $("#hitFlash");
  flash.style.background = "radial-gradient(ellipse, transparent 35%, rgba(190, 0, 24, .72) 100%)";
  flash.style.opacity = "1";
  setTimeout(() => {
    flash.style.opacity = "0";
    setTimeout(() => (flash.style.background = ""), 220);
  }, 90);
}
function renderPlayers(state) {
  $("#aliveCount").textContent = state.alive;
  $("#totalCount").textContent = state.total;
  const living = new Set();
  for (const p of state.players) {
    if (p.id === playerId) {
      local.hp = p.hp;
      local.kills = p.kills;
      ammo = p.ammo;
      local.reserveAmmo = p.reserveAmmo;
      local.reloading = Boolean(p.reloading);
      $("#ammo").innerHTML = `${ammo} <i>/ ${local.reserveAmmo}</i>`;
      $("#feed").textContent = local.reloading ? "⟳ ĐANG NẠP ĐẠN · R" : "";
      const reloadHud = $("#reloadHud");
      if (reloadHud) reloadHud.style.display = local.reloading ? "flex" : "none";
      continue;
    }
    living.add(p.id);
    let mesh = remoteMeshes.get(p.id);
    if (!mesh) {
      mesh = new THREE.Group();
      const torso = new THREE.Mesh(
        new THREE.BoxGeometry(0.65, 1, 0.38),
        makeMat("#bf5940"),
      );
      torso.position.y = 1.05;
      mesh.add(torso);
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.24, 8, 8),
        makeMat("#d4b995"),
      );
      head.position.y = 1.72;
      mesh.add(head);
      const legs = new THREE.Mesh(
        new THREE.BoxGeometry(0.48, 0.65, 0.34),
        makeMat("#313b34"),
      );
      legs.position.y = 0.4;
      mesh.add(legs);
      // Simple third-person rifle model, visible to every other player.
      const weapon = new THREE.Group();
      const rifleBody = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.18, 0.62), makeMat("#252821"));
      rifleBody.position.set(0.39, 1.22, -0.34);
      weapon.add(rifleBody);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.48, 7), makeMat("#666b5e"));
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0.39, 1.24, -0.83);
      weapon.add(barrel);
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.2, 0.28), makeMat("#594432"));
      stock.position.set(0.39, 1.21, 0.08);
      weapon.add(stock);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.25, 0.12), makeMat("#34372f"));
      grip.position.set(0.39, 1.03, -0.2);
      weapon.add(grip);
      const armMaterial = makeMat("#a94d39");
      const armGeo = new THREE.BoxGeometry(0.16, 0.18, 0.48);
      const armNear = new THREE.Mesh(armGeo, armMaterial);
      armNear.position.set(0.29, 1.19, -0.2);
      armNear.rotation.x = -0.22;
      mesh.add(armNear);
      const armFar = new THREE.Mesh(armGeo, armMaterial);
      armFar.position.set(0.49, 1.16, -0.22);
      armFar.rotation.x = -0.22;
      mesh.add(armFar);
      mesh.add(weapon);
      const muzzleFlash = new THREE.Mesh(
        new THREE.SphereGeometry(0.13, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0xffd46b }),
      );
      muzzleFlash.position.set(0.39, 1.24, -1.08);
      muzzleFlash.visible = false;
      mesh.add(muzzleFlash);
      // Thick luminous blocks form a dashed ring that stays readable at range.
      const reloadIndicator = new THREE.Group();
      // Stand the ring upright above the head; its local XZ circle becomes XY.
      reloadIndicator.rotation.x = Math.PI / 2;
      const dashCount = 12;
      const dashMaterial = new THREE.MeshBasicMaterial({ color: 0xd6ff45, toneMapped: false });
      for (let dash = 0; dash < dashCount; dash++) {
        const angle = (dash / dashCount) * Math.PI * 2;
        const segment = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.10, 0.11), dashMaterial);
        segment.position.set(Math.cos(angle) * 0.30, 0, Math.sin(angle) * 0.30);
        segment.rotation.y = -angle;
        reloadIndicator.add(segment);
      }
      reloadIndicator.position.set(0, 2.2, 0);
      mesh.add(reloadIndicator);
      mesh.userData = { torso, head, legs, weapon, muzzleFlash, reloadIndicator, shotId: 0, flashUntil: 0 };
      scene.add(mesh);
      remoteMeshes.set(p.id, mesh);
    }
    mesh.rotation.order = "YXZ";
    // Negative X rotation lays local +Y toward local -Z, matching the server's
    // prone hitbox centers (head forward, legs behind).
    mesh.rotation.set(p.prone ? -Math.PI / 2 : 0, p.yaw, 0);
    mesh.position.set(p.x, p.prone ? 0.35 : (p.jumpY || 0), p.z);
    mesh.scale.set(1, p.crouching && !p.prone ? 0.68 : 1, 1);
    mesh.userData.slowWalking = Boolean(p.slowWalking);
    mesh.userData.reloading = Boolean(p.reloading);
    mesh.userData.reloadIndicator.visible = Boolean(p.reloading);
    mesh.userData.reloadIndicator.position.y = p.prone ? 0.78 : p.crouching ? 1.55 : 2.2;
    if (p.shotId && p.shotId !== mesh.userData.shotId) {
      mesh.userData.shotId = p.shotId;
      mesh.userData.flashUntil = Date.now() + 95;
    }
    mesh.userData.muzzleFlash.visible = Date.now() < mesh.userData.flashUntil;
    mesh.userData.weapon.rotation.x = Date.now() < mesh.userData.flashUntil ? 0.12 : 0;
    mesh.visible = p.alive;
  }
  for (const [id, m] of remoteMeshes)
    if (!living.has(id)) {
      scene.remove(m);
      remoteMeshes.delete(id);
    }
  $("#healthText").textContent = local.hp;
  $("#healthBar").style.width = local.hp + "%";
  $("#hitFlash").style.borderWidth = local.hp < 40 ? "8px" : "0";
  if (local.hp <= 0) showResult();
  if (state.lastHit && state.lastHit.id !== lastHitEventId) {
    lastHitEventId = state.lastHit.id;
    const point = state.lastHit.point;
    spawnBloodBurst(new THREE.Vector3(point.x, point.y, point.z));
    if (state.lastHit.targetId === playerId) showBloodScreenFlash();
  }
}
function beginGame() {
  lastHitEventId = 0;
  local.hp = 100;
  local.kills = 0;
  verticalSpeed = 0;
  grounded = true;
  jumpOffset = 0;
  local.crouching = false;
  local.prone = false;
  local.jumping = false;
  local.reloading = false;
  local.reserveAmmo = 90;
  paused = false;
  scoped = false;
  ammo = 30;
  startedAt = Date.now();
  $("#ammo").innerHTML = `${ammo} <i>/ 90</i>`;
  show("game");
  initWorld();
  $("#world").onclick = () => {
    if (!paused) renderer.domElement.requestPointerLock?.();
  };
  $("#world").oncontextmenu = (e) => e.preventDefault();
  document.addEventListener("pointerlockchange", onPointerLockChange);
  document.addEventListener("mousemove", onMouse);
  document.addEventListener("mousedown", onFire);
  document.addEventListener("mouseup", onMouseUp);
  window.addEventListener("blur", stopFiring);
  document.addEventListener("contextmenu", blockContextMenu);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);
  installReloadHud();
  $("#resumeBtn").onclick = resumeGame;
  $("#leaveMatchBtn").onclick = leaveMatch;
}
function installReloadHud() {
  document.querySelector("#reloadHud")?.remove();
  if (!document.querySelector("#reloadHudStyles")) {
    const style = document.createElement("style");
    style.id = "reloadHudStyles";
    style.textContent = "@keyframes ldReloadSpin{to{transform:rotate(360deg)}}";
    document.head.append(style);
  }
  const reloadHud = document.createElement("div");
  reloadHud.id = "reloadHud";
  Object.assign(reloadHud.style, {
    display: "none", alignItems: "center", justifyContent: "flex-end", gap: "8px",
    margin: "4px 0 2px", color: "#d6ff45", font: "bold 11px 'DM Mono', monospace",
    letterSpacing: "1px", textShadow: "0 1px 4px #000",
  });
  const spinner = document.createElement("i");
  Object.assign(spinner.style, {
    width: "20px", height: "20px", display: "block", borderRadius: "50%",
    background: "repeating-conic-gradient(#d6ff45 0deg 20deg, transparent 20deg 36deg)",
    mask: "radial-gradient(farthest-side, transparent 54%, #000 58%)",
    animation: "ldReloadSpin .7s linear infinite",
    filter: "drop-shadow(0 0 4px #d6ff45)",
  });
  reloadHud.append(spinner, document.createTextNode("ĐANG NẠP ĐẠN"));
  $(".weapon").insertBefore(reloadHud, $("#ammo"));
}
function blockContextMenu(e) {
  if ($("#game").classList.contains("active")) e.preventDefault();
}
function onPointerLockChange() {
  if (document.pointerLockElement !== renderer?.domElement) stopFiring();
  if (
    document.pointerLockElement !== renderer?.domElement &&
    $("#game").classList.contains("active") &&
    !paused
  )
    pauseGame();
}
function onKeyDown(e) {
  if (e.code === "Escape") {
    e.preventDefault();

    if (paused) resumeGame();
    else pauseGame();

    return;
  }

  if (e.code === "KeyR" && !e.repeat && !paused && $("#game").classList.contains("active")) {
    e.preventDefault();
    send({ type: "reload" });
    return;
  }

  if (e.code === "KeyZ" && !e.repeat && !paused && grounded && $("#game").classList.contains("active")) {
    local.prone = !local.prone;
    if (local.prone) local.crouching = false;
    e.preventDefault();
    return;
  }

  keys[e.code] = true;

  if (
    e.code === "Space" &&
    !e.repeat &&
    grounded &&
    !paused &&
    !local.prone &&
    !keys.ShiftLeft &&
    !keys.ShiftRight
  ) {
    verticalSpeed = 8;
    jumpOffset = 0;
    grounded = false;

    local.jumping = true;

    e.preventDefault();
  }
}

function onKeyUp(e) {
  keys[e.code] = false;
}
function pauseGame() {
  if (paused || !$("#game").classList.contains("active")) return;
  paused = true;
  stopFiring();
  keys = {};
  scoped = false;
  setScope(false);
  $("#gameMessage").classList.remove("hidden");
  if (document.pointerLockElement) document.exitPointerLock();
}
function resumeGame() {
  if (!paused) return;
  paused = false;
  $("#gameMessage").classList.add("hidden");
  renderer?.domElement.requestPointerLock?.();
}
function leaveMatch() {
  paused = false;
  scoped = false;
  setScope(false);
  document.exitPointerLock?.();
  cleanupGame();
  if (socket) socket.close();
  socket = null;
  $("#status").textContent = "● OFFLINE";
  $("#gameMessage").classList.add("hidden");
  show("menu");
}
function cleanupGame() {
  document.removeEventListener("mousemove", onMouse);
  document.removeEventListener("mousedown", onFire);
  document.removeEventListener("mouseup", onMouseUp);
  window.removeEventListener("blur", stopFiring);
  stopFiring();
  document.removeEventListener("pointerlockchange", onPointerLockChange);
  document.removeEventListener("contextmenu", blockContextMenu);
  document.removeEventListener("keydown", onKeyDown);
  document.removeEventListener("keyup", onKeyUp);
  renderer?.dispose();
  renderer = null;
  remoteMeshes.clear();
}
function onMouse(e) {
  if (document.pointerLockElement !== renderer?.domElement) return;
  local.yaw -= e.movementX * (Number($("#sensitivity").value) || 50) * 0.000055;
  camera.rotation.order = "YXZ";
  camera.rotation.y = local.yaw;
  camera.rotation.x = Math.max(
    -1.35,
    Math.min(1.35, camera.rotation.x - e.movementY * 0.0018),
  );
}
function onFire(e) {
  if (e.button === 2) {
    if (
      $("#game").classList.contains("active") &&
      !paused &&
      document.pointerLockElement === renderer?.domElement
    )
      setScope(!scoped);
    return;
  }
  if (
    e.button !== 0 ||
    paused ||
    !$("#game").classList.contains("active") ||
    document.pointerLockElement !== renderer?.domElement
  )
    return;
  if (triggerHeld) return;
  triggerHeld = true;
  shootOnce();
  fireInterval = setInterval(shootOnce, FIRE_INTERVAL_MS);
}
function onMouseUp(e) {
  if (e.button === 0) stopFiring();
}
function stopFiring() {
  triggerHeld = false;
  if (fireInterval !== null) clearInterval(fireInterval);
  fireInterval = null;
}
function shootOnce() {
  if (!triggerHeld || paused || !$("#game").classList.contains("active") || document.pointerLockElement !== renderer?.domElement) {
    stopFiring();
    return;
  }
  if (local.reloading) return;
  if (ammo <= 0) {
    tone(120, 0.07, "square", 0.015);
    stopFiring();
    return;
  }
  ammo--;
  $("#ammo").innerHTML = `${ammo} <i>/ ${local.reserveAmmo ?? 90}</i>`;
  tone(95, 0.11, "sawtooth", 0.05);
  const flash = new THREE.PointLight(0xffc66b, 2, 3);
  flash.position.set(0.28, -0.22, -1);
  camera.add(flash);
  setTimeout(() => camera.remove(flash), 45);
  makeTracer();
  // Use Three.js's actual camera ray for both the visible tracer and server hit test.
  const aim = new THREE.Vector3();
  camera.getWorldDirection(aim);
  const eye = new THREE.Vector3();
  camera.getWorldPosition(eye);
  send({
    type: "shoot",
    aim: { x: aim.x, y: aim.y, z: aim.z },
    x: local.x,
    z: local.z,
    eyeY: eye.y,
  });
}
function setScope(enabled) {
  scoped = enabled;
  camera.fov = scoped ? 30 : baseFov;
  camera.updateProjectionMatrix();
  gun.visible = !scoped;
  $(".crosshair").classList.toggle("scope-hidden", scoped);
  $("#scopeOverlay").classList.toggle("hidden", !scoped);
}
function makeTracer() {
  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);
  const eye = new THREE.Vector3();
  camera.getWorldPosition(eye);
  const muzzle = new THREE.Vector3();
  camera.localToWorld(muzzle.set(0.28, -0.2, -1));
  // End the tracer on the exact same camera-center ray sent to the server.
  const end = eye.addScaledVector(direction, 140);
  const geometry = new THREE.BufferGeometry().setFromPoints([muzzle, end]);
  const line = new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({
      color: 0xffed8a,
      transparent: true,
      opacity: 0.95,
    }),
  );
  scene.add(line);
  setTimeout(() => {
    scene?.remove(line);
    geometry.dispose();
    line.material.dispose();
  }, 110);
}
function frame() {
  if (!renderer || !$("#game").classList.contains("active")) return;
  const dt = Math.min(clock.getDelta(), 0.05);
  for (const mesh of remoteMeshes.values()) {
    const animTime = performance.now() / 1000;
    if (mesh.userData.reloading) {
      // Spin in the upright ring's plane rather than around the player's head.
      mesh.userData.reloadIndicator.rotation.z += dt * 7;
      mesh.userData.weapon.position.y = -0.22 + Math.sin(animTime * 9) * 0.025;
      mesh.userData.weapon.rotation.x = 0.22;
    } else {
      mesh.userData.weapon.position.y = 0;
      if (Date.now() >= mesh.userData.flashUntil) mesh.userData.weapon.rotation.x = 0;
    }
    mesh.userData.muzzleFlash.visible = Date.now() < mesh.userData.flashUntil;
  }
  for (let i = bloodParticles.length - 1; i >= 0; i--) {
    const particle = bloodParticles[i];
    particle.userData.life -= dt;
    particle.userData.velocity.y -= 8 * dt;
    particle.position.addScaledVector(particle.userData.velocity, dt);
    particle.scale.setScalar(Math.max(0.05, particle.userData.life / 0.62));
    if (particle.userData.life <= 0) {
      scene.remove(particle);
      particle.geometry.dispose();
      particle.material.dispose();
      bloodParticles.splice(i, 1);
    }
  }
  if (!paused) {
    const isProne = Boolean(local.prone);
    const isCrouching = !isProne && (keys.ShiftLeft || keys.ShiftRight);

    local.crouching = isCrouching;

    const isSlowWalking = keys.ControlLeft || keys.ControlRight;

    let moveSpeed = isProne ? 1.3 : NORMAL_SPEED;

    if (!isProne && isCrouching && isSlowWalking) {
      moveSpeed = CROUCH_SLOW_SPEED;
    } else if (!isProne && isCrouching) {
      moveSpeed = CROUCH_SPEED;
    } else if (!isProne && isSlowWalking) {
      moveSpeed = SLOW_SPEED;
    }

    const speed = moveSpeed * dt;
    let dx = 0,
      dz = 0;
    // Forward vector already points toward -Z when yaw is zero. Keep W positive
    // and S negative so input and view direction agree (W forward, S backward).
    if (keys.KeyW) dz += 1;
    if (keys.KeyS) dz -= 1;
    if (keys.KeyA) dx -= 1;
    if (keys.KeyD) dx += 1;
    const len = Math.hypot(dx, dz) || 1;
    const fx = -Math.sin(local.yaw),
      fz = -Math.cos(local.yaw),
      rx = Math.cos(local.yaw),
      rz = -Math.sin(local.yaw);
    const moveX = ((fx * dz + rx * dx) / len) * speed;
    const moveZ = ((fz * dz + rz * dx) / len) * speed;
    // Resolve axes separately so the player slides along walls instead of sticking.
    if (!isBlockedAt(local.x + moveX, local.z)) local.x += moveX;
    if (!isBlockedAt(local.x, local.z + moveZ)) local.z += moveZ;
    const targetHeight = isProne ? PRONE_HEIGHT : isCrouching ? CROUCH_HEIGHT : STAND_HEIGHT;
    if (!grounded) {
      verticalSpeed -= 20 * dt;
      jumpOffset += verticalSpeed * dt;
      if (jumpOffset <= 0) {
        jumpOffset = 0;
        verticalSpeed = 0;
        grounded = true;
        local.jumping = false;
      }
    }

    if (grounded) {
      jumpOffset = 0;
      camera.position.y +=
        (targetHeight - camera.position.y) * Math.min(12 * dt, 1);
      if (!isCrouching && (dx || dz)) {
        camera.position.y += Math.sin(Date.now() * 0.012) * 0.025;
      }
    } else {
      camera.position.y = targetHeight + jumpOffset;
    }
    camera.position.x = local.x;
    camera.position.z = local.z;
    if (Date.now() - lastMove > 50) {
      send({
        type: "move",
        x: local.x,
        z: local.z,
        yaw: local.yaw,
        crouching: local.crouching,
        prone: isProne,
        jumping: local.jumping,
        slowWalking: isSlowWalking,
        jumpY: jumpOffset,
      });
      lastMove = Date.now();
    }
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    $("#matchClock").textContent =
      `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
function showResult() {
  if (!$("#game").classList.contains("active")) return;
  if ($("#result").classList.contains("active")) return;
  document.exitPointerLock?.();
  $("#killsResult").textContent = local.kills;
  $("#placeResult").textContent = local.hp > 0 ? "TOP 1" : "TOP —";
  const e = Math.floor((Date.now() - startedAt) / 1000);
  $("#surviveResult").textContent =
    `${String(Math.floor(e / 60)).padStart(2, "0")}:${String(e % 60).padStart(2, "0")}`;
  const resultMessage =
    local.hp > 0
      ? "Bạn là người sống sót cuối cùng!"
      : "Bạn đã bị hạ. Hãy xem lại chiến thuật và thử thêm lần nữa.";
  resultEndsAt = Date.now() + 20000;
  const updateCountdown = () => {
    const secondsLeft = Math.max(0, Math.ceil((resultEndsAt - Date.now()) / 1000));
    $("#resultDetail").textContent = `${resultMessage} Tự động về Home sau ${secondsLeft} giây.`;
  };
  clearTimeout(resultTimeout);
  clearInterval(resultCountdown);
  updateCountdown();
  show("result");
  resultCountdown = setInterval(updateCountdown, 250);
  resultTimeout = setTimeout(returnHome, 20000);
}
function returnHome() {
  clearTimeout(resultTimeout);
  clearInterval(resultCountdown);
  resultTimeout = null;
  resultCountdown = null;
  cleanupGame();
  if (socket) socket.close();
  socket = null;
  $("#status").textContent = "● OFFLINE";
  show("menu");
}
$("#returnBtn").onclick = returnHome;
