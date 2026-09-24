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
  Number.parseFloat(
    getComputedStyle(loading).getPropertyValue("--loading-duration"),
  ) || 0;
setTimeout(() => {
  companySplash.classList.add("hidden");
  loading.classList.remove("hidden");
  setTimeout(() => {
    loading.classList.add("hidden");
    app.classList.remove("hidden");
  }, loadingDurationMs);
}, 0);
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
    swimming: false,
    swimY: null,
    swimDepth: 0,
  };
let keys = {},
  ammo = 30,
  startedAt = 0,
  audioCtx = null,
  noiseBuffer = null,
  soundOn = true,
  lastMove = 0,
  paused = false,
  scoped = false,
  verticalSpeed = 0,
  grounded = true,
  jumpOffset = 0,
  baseFov = 76,
  mapObstacles = [],
  mapId = "desert",
  selectedMap =
    localStorage.getItem("ld-selected-map") === "forest" ? "forest" : "desert",
  triggerHeld = false,
  fireInterval = null,
  lastHitEventId = 0,
  bloodParticles = [],
  resultTimeout = null,
  resultCountdown = null,
  resultEndsAt = 0;
const FIRE_INTERVAL_MS = 120;

// Vật phẩm / balo / hồi máu (server quyết định kết quả, khớp với server.js)
const PICKUP_RADIUS = 2;
const HEAL_DURATION_MS = 5000;
const lootItems = new Map(); // id -> { id, type, x, z, amount, mesh, body }
let backpackOpen = false,
  lootToastTimer = null,
  gunBusy = 0, // 0 = cầm súng bình thường, 1 = súng gập ngang (đang hồi máu)
  packLimits = { ammo: 210, medkits: 5 }; // sức chứa balo, server gửi lại khi bắt đầu trận

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
// ---------------------------------------------------------------------------
// ÂM THANH KHÔNG GIAN: tiếng chân, tiếng súng, tiếng nạp đạn
// ---------------------------------------------------------------------------
// Âm lượng giảm dần theo khoảng cách và về 0 hẳn khi vượt "max" (đơn vị mét
// trong thế giới game). Chỉnh các số dưới đây nếu muốn nghe xa/gần hơn.
//   ref: trong khoảng này âm lượng tối đa
//   max: xa hơn mức này thì hoàn toàn không nghe thấy
const AUDIO_RANGE = {
  footstep: { ref: 1.5, max: 16 }, // chạy bộ; đi chậm/khom tự nhỏ hơn (nhân theo intensity)
  gunshot: { ref: 4, max: 60 },
  reload: { ref: 1.5, max: 12 },
};
// Thời điểm (ms, tính từ lúc bắt đầu nạp) của từng tiếng trong 1.8 giây nạp đạn.
const RELOAD_STAGES = [
  { at: 250, kind: "magOut" },
  { at: 950, kind: "magIn" },
  { at: 1450, kind: "bolt" },
];

function updateAudioListener(now) {
  const listener = audioCtx.listener;
  camera?.updateMatrixWorld(true);
  const position = camera
    ? camera.getWorldPosition(new THREE.Vector3())
    : new THREE.Vector3();
  const forward = camera
    ? camera.getWorldDirection(new THREE.Vector3())
    : new THREE.Vector3(0, 0, -1);
  const up = camera
    ? camera.up
        .clone()
        .applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()))
    : new THREE.Vector3(0, 1, 0);
  const setParam = (param, value) => param?.setValueAtTime(value, now);
  if (listener.positionX) {
    setParam(listener.positionX, position.x);
    setParam(listener.positionY, position.y);
    setParam(listener.positionZ, position.z);
    setParam(listener.forwardX, forward.x);
    setParam(listener.forwardY, forward.y);
    setParam(listener.forwardZ, forward.z);
    setParam(listener.upX, up.x);
    setParam(listener.upY, up.y);
    setParam(listener.upZ, up.z);
  } else {
    listener.setPosition(position.x, position.y, position.z);
    listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
  }
  return position;
}
// 1 khi ở sát, giảm mượt về 0 tại "max". Bình phương để càng xa càng nhỏ nhanh.
function distanceGain(distance, ref, max) {
  if (distance >= max) return 0;
  if (distance <= ref) return 1;
  const t = (distance - ref) / (max - ref);
  return (1 - t) * (1 - t);
}
// position = null nghĩa là âm thanh của chính người chơi (không pan, không giảm).
// Trả về null nếu tắt tiếng hoặc nguồn âm quá xa (không tạo node nào cả).
function spatialAudio(
  position,
  { volume = 1, ref = 2, max = 20, delay = 0 } = {},
) {
  if (!soundOn) return null;
  const sfx = Number($("#sfx").value) / 100;
  if (!(sfx > 0)) return null;
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  const now = audioCtx.currentTime;
  const listenerPosition = updateAudioListener(now);
  let attenuation = 1;
  let farness = 0; // 0 = sát, 1 = ở mép tầm nghe
  if (position) {
    const distance = Math.hypot(
      position.x - listenerPosition.x,
      position.y - listenerPosition.y,
      position.z - listenerPosition.z,
    );
    attenuation = distanceGain(distance, ref, max);
    if (attenuation < 0.01) return null;
    farness = Math.min(1, Math.max(0, (distance - ref) / (max - ref)));
  }
  const input = audioCtx.createGain();
  // Càng xa âm càng "đục" (mất tiếng cao).
  const muffle = audioCtx.createBiquadFilter();
  muffle.type = "lowpass";
  muffle.frequency.value = 1500 + 18500 * (1 - farness) * (1 - farness);
  const master = audioCtx.createGain();
  master.gain.value = Math.max(0.0001, volume * sfx * attenuation);
  input.connect(muffle);
  let tail = muffle;
  if (position) {
    // Panner chỉ lo hướng trái/phải/trước/sau; độ to đã tính ở trên
    // (rolloffFactor = 0 tắt hẳn suy giảm mặc định của Web Audio).
    const panner = audioCtx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "linear";
    panner.rolloffFactor = 0;
    if (panner.positionX) {
      panner.positionX.setValueAtTime(position.x, now);
      panner.positionY.setValueAtTime(position.y, now);
      panner.positionZ.setValueAtTime(position.z, now);
    } else {
      panner.setPosition(position.x, position.y, position.z);
    }
    muffle.connect(panner);
    tail = panner;
  }
  tail.connect(master);
  master.connect(audioCtx.destination);
  if (!noiseBuffer) {
    noiseBuffer = audioCtx.createBuffer(
      1,
      Math.ceil(audioCtx.sampleRate * 0.45),
      audioCtx.sampleRate,
    );
    const samples = noiseBuffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  }
  return { t0: now + delay, input, noiseBuffer };
}
function noiseBurst(
  a,
  { at = 0, duration = 0.1, filter = "lowpass", freq = 1000, q = 1, gain = 1 },
) {
  const t = a.t0 + at;
  const src = audioCtx.createBufferSource();
  const f = audioCtx.createBiquadFilter();
  const g = audioCtx.createGain();
  src.buffer = a.noiseBuffer;
  f.type = filter;
  f.frequency.setValueAtTime(freq, t);
  f.Q.value = q;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  src.connect(f);
  f.connect(g);
  g.connect(a.input);
  src.start(t, Math.random() * 0.1);
  src.stop(t + duration + 0.02);
}
function toneBurst(
  a,
  { at = 0, duration = 0.1, type = "sine", from = 100, to = 50, gain = 0.5 },
) {
  const t = a.t0 + at;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t + duration);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  o.connect(g);
  g.connect(a.input);
  o.start(t);
  o.stop(t + duration + 0.02);
}
// position: {x, y, z} của họng súng; null = súng của chính mình.
function playSpatialGunshot(position, volume = 0.7, delay = 0) {
  const a = spatialAudio(position, { volume, ...AUDIO_RANGE.gunshot, delay });
  if (!a) return;
  noiseBurst(a, { duration: 0.03, filter: "highpass", freq: 1800, gain: 0.7 }); // tiếng "tách" đầu nòng
  noiseBurst(a, { duration: 0.19, filter: "lowpass", freq: 2600, gain: 1 }); // tiếng nổ
  toneBurst(a, { duration: 0.14, from: 105, to: 48, gain: 0.75 }); // tiếng dội trầm
}
function playSpatialFootstep(x, y, z, intensity = 1) {
  // Đi chậm / khom người có tầm nghe ngắn hơn chạy.
  const max = AUDIO_RANGE.footstep.max * intensity;
  const ref = Math.min(AUDIO_RANGE.footstep.ref, max * 0.3);
  const a = spatialAudio(
    { x, y, z },
    { volume: 0.55 * (0.5 + 0.5 * intensity), ref, max },
  );
  if (!a) return;
  noiseBurst(a, {
    duration: 0.095,
    filter: "lowpass",
    freq: 700 + intensity * 500,
    gain: 0.85,
  });
  toneBurst(a, { duration: 0.07, from: 105, to: 62, gain: 0.28 });
}
// kind: "magOut" (tháo băng), "magIn" (lắp băng), "bolt" (lên đạn)
function playSpatialReload(kind, position) {
  const a = spatialAudio(position, { volume: 0.7, ...AUDIO_RANGE.reload });
  if (!a) return;
  if (kind === "magOut") {
    noiseBurst(a, {
      duration: 0.02,
      filter: "highpass",
      freq: 3500,
      gain: 0.5,
    });
    noiseBurst(a, {
      duration: 0.05,
      filter: "bandpass",
      freq: 2200,
      q: 2,
      gain: 0.8,
    });
    toneBurst(a, { at: 0.03, duration: 0.07, from: 220, to: 110, gain: 0.35 });
  } else if (kind === "magIn") {
    toneBurst(a, { duration: 0.09, from: 160, to: 70, gain: 0.6 });
    noiseBurst(a, {
      duration: 0.07,
      filter: "bandpass",
      freq: 1800,
      q: 1.5,
      gain: 1,
    });
    noiseBurst(a, {
      at: 0.015,
      duration: 0.03,
      filter: "highpass",
      freq: 4000,
      gain: 0.5,
    });
  } else {
    noiseBurst(a, {
      duration: 0.04,
      filter: "bandpass",
      freq: 3000,
      q: 3,
      gain: 0.9,
    });
    toneBurst(a, {
      duration: 0.05,
      type: "triangle",
      from: 1400,
      to: 700,
      gain: 0.18,
    });
    noiseBurst(a, {
      at: 0.11,
      duration: 0.05,
      filter: "bandpass",
      freq: 2400,
      q: 2,
      gain: 1,
    });
    toneBurst(a, { at: 0.11, duration: 0.07, from: 180, to: 90, gain: 0.4 });
  }
}
// playerKey = null: người chơi của mình; còn lại là id người chơi khác.
// Vị trí được lấy lại ở mỗi tiếng nên âm thanh đi theo người đang nạp đạn,
// và tự dừng nếu họ chết / thoát / ngừng nạp.
function startReloadSounds(playerKey) {
  for (const stage of RELOAD_STAGES) {
    setTimeout(() => {
      if (playerKey === null) {
        if (local.reloading) playSpatialReload(stage.kind, null);
        return;
      }
      const mesh = remoteMeshes.get(playerKey);
      if (!mesh || !mesh.visible || !mesh.userData.reloading) return;
      playSpatialReload(stage.kind, {
        x: mesh.position.x,
        y: mesh.position.y + 1,
        z: mesh.position.z,
      });
    }, stage.at);
  }
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
function renderMapChoice(id) {
  selectedMap = id === "forest" ? "forest" : "desert";
  localStorage.setItem("ld-selected-map", selectedMap);
  document.querySelectorAll("[data-map-choice]").forEach((button) => {
    button.classList.toggle(
      "selected",
      button.dataset.mapChoice === selectedMap,
    );
  });
  const forest = selectedMap === "forest";
  $("#mapName").textContent = forest ? "VERDANT WILDS" : "DUSTY BASIN";
  $("#mapCount").textContent = forest ? "02 / 02" : "01 / 02";
  $("#mapDescription").textContent = forest
    ? "CỎ XANH · HỒ · SÔNG · ĐỒI"
    : "SA MẠC · ĐÁ · XƯƠNG RỒNG";
  $("#mapArt").classList.toggle("forest-preview", forest);
  $("#mapArt").classList.toggle("desert-preview", !forest);
}
const mapCard = $(".map-card");
mapCard.querySelector(".map-title").innerHTML =
  'KHU VỰC TÁC CHIẾN <b id="mapCount">01 / 02</b>';
$(".map-art").id = "mapArt";
$(".map-label").id = "mapName";
mapCard.querySelector(".map-info").innerHTML =
  '<span>HỆ SINH THÁI <b id="mapDescription"></b></span><span>QUY MÔ <b>100 × 100 M</b></span>';
const mapPicker = document.createElement("div");
mapPicker.className = "map-select";
mapPicker.innerHTML =
  '<button type="button" data-map-choice="desert">SA MẠC</button><button type="button" data-map-choice="forest">RỪNG</button>';
mapCard.querySelector(".map-title").after(mapPicker);
mapPicker.querySelectorAll("[data-map-choice]").forEach((button) => {
  button.addEventListener("click", () =>
    renderMapChoice(button.dataset.mapChoice),
  );
});
renderMapChoice(selectedMap);
$("#createBtn").onclick = () => connect({ type: "create", mapId: selectedMap });
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
      mapId = m.mapId === "forest" ? "forest" : "desert";
      mapObstacles = m.obstacles || [];
      renderMapChoice(mapId);
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
    if (m.type === "loot") {
      if (m.limits) packLimits = m.limits;
      setLootItems(m.items || []);
    }
    if (m.type === "lootUpdate" && lootItems.has(m.id))
      lootItems.get(m.id).amount = m.amount;
    if (m.type === "lootRemoved") removeLootItem(m.id);
    if (m.type === "toast") showLootToast(m.text);
    if (m.type === "state") {
      gameState = m;
      if (m.mapId) {
        mapId = m.mapId;
        renderMapChoice(mapId);
      }
      renderLobby();
      if (m.phase === "playing") {
        if (!$("#game").classList.contains("active")) beginGame();
        renderPlayers(m);
      }
      if (
        m.phase === "finished" &&
        !$("#result").classList.contains("active")
      ) {
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
    `${gameState.players.length}/5 người chơi · MAP ${mapId === "forest" ? "RỪNG" : "SA MẠC"}`;
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
function terrainHeightForHill(hill, x, z) {
  const radius = hill.w / 2;
  const d2 = ((x - hill.x) / radius) ** 2 + ((z - hill.z) / radius) ** 2;
  return d2 >= 1 ? 0 : hill.h * Math.pow(1 - d2, 1.4);
}
function groundHeightAt(x, z) {
  let height = 0;
  for (const hill of mapObstacles) {
    if (hill.type === "hill")
      height = Math.max(height, terrainHeightForHill(hill, x, z));
  }
  return height;
}
function waterAt(x, z) {
  for (const water of mapObstacles) {
    if (water.type !== "river" && water.type !== "lake") continue;
    const dx = x - water.x;
    const dz = z - water.z;
    const c = Math.cos(water.yaw || 0);
    const s = Math.sin(water.yaw || 0);
    const localX = c * dx - s * dz;
    const localZ = s * dx + c * dz;
    const inside =
      water.type === "lake"
        ? (localX / water.w) ** 2 + (localZ / water.length) ** 2 <= 1
        : Math.abs(localX) <= water.w / 2 &&
          Math.abs(localZ) <= water.length / 2;
    if (inside) return { surfaceY: 0.08, depth: water.depth || 4 };
  }
  return null;
}
function createGroundMesh(forest) {
  const size = 110;
  const segments = forest ? 220 : 1;
  const step = size / segments;
  const positions = [];
  const indices = [];
  for (let row = 0; row <= segments; row++) {
    const z = -size / 2 + row * step;
    for (let col = 0; col <= segments; col++) {
      positions.push(-size / 2 + col * step, 0, z);
    }
  }
  for (let row = 0; row < segments; row++) {
    for (let col = 0; col < segments; col++) {
      const x = -size / 2 + (col + 0.5) * step;
      const z = -size / 2 + (row + 0.5) * step;
      // Leave an opening in the terrain under every lake and river segment.
      if (forest && waterAt(x, z)) continue;
      const a = row * (segments + 1) + col;
      const b = a + segments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = makeMat(forest ? "#416f3e" : "#ad905e");
  // The underside remains an opaque floor when the player views the river bank underwater.
  material.side = THREE.DoubleSide;
  const floor = new THREE.Mesh(geometry, material);
  scene.add(floor);
}
function blockedByBuilding(o, x, z, radius) {
  const dx = x - o.x;
  const dz = z - o.z;
  const c = Math.cos(o.yaw || 0);
  const s = Math.sin(o.yaw || 0);
  const lx = c * dx - s * dz;
  const lz = s * dx + c * dz;
  const half = o.w / 2;
  const sideWall =
    Math.abs(lx) >= half - 0.16 - radius &&
    Math.abs(lx) <= half + radius &&
    Math.abs(lz) < half + radius;
  const endWall =
    Math.abs(lz) >= half - 0.16 - radius &&
    Math.abs(lz) <= half + radius &&
    Math.abs(lx) < half + radius;
  const frontDoor =
    lz < 0 && Math.abs(lx) < 1.05 && Math.abs(lz) >= half - 0.16 - radius;
  return (sideWall || endWall) && !frontDoor;
}
function drawMapObject(o, forest) {
  const baseY =
    o.type === "hill" || o.solid === false ? 0 : groundHeightAt(o.x, o.z);
  const add = (geometry, color, x = o.x, y = 0, z = o.z, material = null) => {
    const mesh = new THREE.Mesh(geometry, material || makeMat(color));
    mesh.position.set(x, y + baseY, z);
    if (o.yaw) mesh.rotation.y = o.yaw;
    scene.add(mesh);
    return mesh;
  };
  const w = o.w || 1;
  switch (o.type) {
    case "river": {
      const depth = o.depth || 4;
      const bed = add(
        new THREE.BoxGeometry(w, 0.12, o.length),
        "#344b3b",
        o.x,
        -depth + 0.06,
        o.z,
      );
      bed.rotation.y = o.yaw || 0;
      const volume = add(
        new THREE.BoxGeometry(w, depth, o.length),
        "#32869a",
        o.x,
        -depth / 2,
        o.z,
        new THREE.MeshStandardMaterial({
          color: "#32869a",
          transparent: true,
          opacity: 0.24,
          depthWrite: false,
          roughness: 0.18,
          side: THREE.DoubleSide,
        }),
      );
      volume.rotation.y = o.yaw || 0;
      const water = add(
        new THREE.BoxGeometry(w, o.h, o.length),
        "#32869a",
        o.x,
        0.025,
        o.z,
        new THREE.MeshStandardMaterial({
          color: "#32869a",
          roughness: 0.22,
          metalness: 0.12,
          transparent: true,
          opacity: 0.88,
        }),
      );
      water.rotation.y = o.yaw || 0;
      break;
    }
    case "lake": {
      const depth = o.depth || 4;
      const bed = add(
        new THREE.CircleGeometry(o.w, 24),
        "#344b3b",
        o.x,
        -depth + 0.05,
        o.z,
      );
      bed.rotation.x = -Math.PI / 2;
      bed.scale.y = o.length / o.w;
      const volume = add(
        new THREE.CylinderGeometry(o.w, o.w, depth, 24),
        "#287f92",
        o.x,
        -depth / 2,
        o.z,
        new THREE.MeshStandardMaterial({
          color: "#287f92",
          transparent: true,
          opacity: 0.2,
          depthWrite: false,
          roughness: 0.18,
          side: THREE.DoubleSide,
        }),
      );
      volume.scale.z = o.length / o.w;
      const water = add(
        new THREE.CircleGeometry(o.w, 24),
        "#287f92",
        o.x,
        0.035,
        o.z,
        new THREE.MeshStandardMaterial({
          color: "#287f92",
          roughness: 0.2,
          metalness: 0.1,
          transparent: true,
          opacity: 0.88,
        }),
      );
      water.rotation.x = -Math.PI / 2;
      water.scale.y = o.length / o.w;
      break;
    }
    case "house":
    case "hut": {
      const hut = o.type === "hut";
      const wallColor = forest
        ? hut
          ? "#80633f"
          : "#76533a"
        : hut
          ? "#a9814c"
          : "#b59767";
      const wallH = o.h * 0.72;
      const half = w / 2;
      const thickness = 0.24;
      const doorHalf = 1.05;
      const windowHalf = 0.72;
      const sill = wallH * 0.34;
      const windowTop = wallH * 0.73;
      const doorH = Math.min(2.25, wallH * 0.78);
      const wall = (x, y, z, sx, sy, sz, color = wallColor) =>
        add(new THREE.BoxGeometry(sx, sy, sz), color, o.x + x, y, o.z + z);
      wall(0, 0.04, 0, w, 0.08, w, "#594834"); // interior floor slab
      // Split front wall leaves a real doorway; the back remains fully covered.
      wall(
        -(half + doorHalf) / 2,
        wallH / 2,
        -half,
        half - doorHalf,
        wallH,
        thickness,
      );
      wall(
        (half + doorHalf) / 2,
        wallH / 2,
        -half,
        half - doorHalf,
        wallH,
        thickness,
      );
      wall(
        0,
        (wallH + doorH) / 2,
        -half,
        doorHalf * 2,
        wallH - doorH,
        thickness,
      );
      wall(0, wallH / 2, half, w, wallH, thickness);
      // Side windows have a sill, lintel, and dark glass set inside the opening.
      for (const side of [-1, 1]) {
        wall(side * half, sill / 2, 0, thickness, sill, w);
        wall(
          side * half,
          (wallH + windowTop) / 2,
          0,
          thickness,
          wallH - windowTop,
          w,
        );
        wall(
          side * half,
          (sill + windowTop) / 2,
          -(half + windowHalf) / 2,
          thickness,
          windowTop - sill,
          half - windowHalf,
        );
        wall(
          side * half,
          (sill + windowTop) / 2,
          (half + windowHalf) / 2,
          thickness,
          windowTop - sill,
          half - windowHalf,
        );
        wall(
          side * (half - 0.05),
          (sill + windowTop) / 2,
          0,
          0.035,
          windowTop - sill - 0.08,
          windowHalf * 2 - 0.08,
          "#29404a",
        );
        wall(
          side * (half - 0.02),
          sill + 0.025,
          0,
          0.08,
          0.05,
          windowHalf * 2,
          "#d2b77c",
        );
        wall(
          side * (half - 0.02),
          windowTop - 0.025,
          0,
          0.08,
          0.05,
          windowHalf * 2,
          "#d2b77c",
        );
      }
      // Two broad roof planes give the larger houses a pitched silhouette.
      const roofColor = forest
        ? hut
          ? "#59452f"
          : "#343b2c"
        : hut
          ? "#72522f"
          : "#68543b";
      for (const side of [-1, 1]) {
        const roof = wall(
          side * w * 0.245,
          wallH + w * 0.16,
          0,
          w * 0.58,
          0.24,
          w + 0.55,
          roofColor,
        );
        // Flip the slope so both roof planes rise toward the ridge.
        roof.rotation.z = -side * 0.48;
      }
      // Door posts and lintel make the entrance visible without blocking it.
      wall(-doorHalf, doorH / 2, -half - 0.03, 0.12, doorH, 0.12, "#493826");
      wall(doorHalf, doorH / 2, -half - 0.03, 0.12, doorH, 0.12, "#493826");
      wall(
        0,
        doorH + 0.06,
        -half - 0.03,
        doorHalf * 2 + 0.12,
        0.12,
        0.12,
        "#493826",
      );
      break;
    }
    case "tree": {
      add(
        new THREE.CylinderGeometry(w * 0.18, w * 0.25, o.h * 0.62, 6),
        "#60452d",
        o.x,
        o.h * 0.31,
        o.z,
      );
      for (let tier = 0; tier < 3; tier++) {
        add(
          new THREE.ConeGeometry(w * (1.45 - tier * 0.18), o.h * 0.48, 7),
          tier === 1 ? "#397344" : "#2d633b",
          o.x,
          o.h * (0.62 + tier * 0.18),
          o.z,
        );
      }
      break;
    }
    case "deadTree": {
      const trunk = add(
        new THREE.CylinderGeometry(w * 0.17, w * 0.28, o.h, 5),
        "#70563b",
        o.x,
        o.h / 2,
        o.z,
      );
      trunk.rotation.z = 0.08;
      for (const side of [-1, 1]) {
        const branch = add(
          new THREE.CylinderGeometry(w * 0.08, w * 0.12, o.h * 0.36, 4),
          "#70563b",
          o.x + side * w * 0.35,
          o.h * 0.72,
          o.z,
        );
        branch.rotation.z = side * 0.72;
      }
      break;
    }
    case "cactus": {
      add(
        new THREE.CylinderGeometry(w * 0.22, w * 0.26, o.h, 7),
        "#3d7744",
        o.x,
        o.h / 2,
        o.z,
      );
      for (const side of [-1, 1]) {
        add(
          new THREE.CylinderGeometry(w * 0.12, w * 0.15, o.h * 0.38, 6),
          "#4b8948",
          o.x + side * w * 0.36,
          o.h * 0.48,
          o.z,
        );
        add(
          new THREE.CylinderGeometry(w * 0.12, w * 0.12, o.h * 0.16, 6),
          "#4b8948",
          o.x + side * w * 0.36,
          o.h * 0.64,
          o.z,
        );
      }
      break;
    }
    case "rock": {
      const rock = add(
        new THREE.DodecahedronGeometry(0.5, 0),
        forest ? "#68705a" : "#88765c",
        o.x,
        o.h * 0.42,
        o.z,
      );
      rock.scale.set(w, o.h, w * 0.82);
      rock.rotation.set(o.yaw || 0, o.yaw || 0, 0.12);
      break;
    }
    case "hill": {
      const divisions = 32;
      const positions = [];
      const colors = [];
      const indices = [];
      const color = new THREE.Color();
      for (let iz = 0; iz <= divisions; iz++) {
        const z = (iz / divisions - 0.5) * w;
        for (let ix = 0; ix <= divisions; ix++) {
          const x = (ix / divisions - 0.5) * w;
          const height = terrainHeightForHill(o, o.x + x, o.z + z);
          positions.push(x, height, z);
          const top = height / o.h;
          if (forest)
            color.set(
              top > 0.72 ? "#77796a" : top > 0.36 ? "#58774a" : "#426844",
            );
          else
            color.set(
              top > 0.72 ? "#7f7055" : top > 0.36 ? "#b19a6e" : "#a58a5a",
            );
          colors.push(color.r, color.g, color.b);
          if (ix < divisions && iz < divisions) {
            const a = iz * (divisions + 1) + ix;
            const b = a + divisions + 1;
            indices.push(a, b, a + 1, b, b + 1, a + 1);
          }
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3),
      );
      geometry.setAttribute(
        "color",
        new THREE.Float32BufferAttribute(colors, 3),
      );
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      const hillMesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 1,
          side: THREE.DoubleSide,
        }),
      );
      hillMesh.position.set(o.x, 0, o.z);
      scene.add(hillMesh);
      break;
    }
  }
}
function addForestGrass(seed) {
  let state = seed >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const blade = new THREE.ConeGeometry(0.12, 0.65, 3);
  const grass = new THREE.InstancedMesh(
    blade,
    new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 1 }),
    2400,
  );
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  let count = 0;
  for (let i = 0; i < 2400; i++) {
    const x = (rand() - 0.5) * 98;
    const z = (rand() - 0.5) * 98;
    if (Math.hypot(x, z - 8) < 10 || Math.hypot(x, z + 8) < 9) continue;
    const streamZ = -7 + Math.sin((x + 12) / 13) * 13;
    if (Math.abs(z - streamZ) < 3.1 || Math.hypot(x - 22, z + 3) < 12) continue;
    dummy.position.set(x, groundHeightAt(x, z) + 0.29, z);
    dummy.rotation.set(
      (rand() - 0.5) * 0.22,
      rand() * Math.PI,
      (rand() - 0.5) * 0.18,
    );
    const size = 0.55 + rand() * 1.25;
    dummy.scale.set(size, size, size);
    dummy.updateMatrix();
    grass.setMatrixAt(count, dummy.matrix);
    tint.setHSL(
      0.27 + rand() * 0.06,
      0.52 + rand() * 0.2,
      0.24 + rand() * 0.15,
    );
    grass.setColorAt(count, tint);
    count++;
  }
  grass.count = count;
  grass.instanceMatrix.needsUpdate = true;
  scene.add(grass);
}
const PLAYER_RADIUS = 0.38;
// Ground collision follows the visible footprint, not the full square map cell.
function obstacleFootprintRadius(o) {
  if (o.type === "tree") return o.w * 0.25; // visible trunk
  if (o.type === "deadTree") return o.w * 0.28; // trunk
  if (o.type === "cactus") return o.w * 0.48; // body and short arms
  if (o.type === "rock") return o.w * 0.46; // faceted rock, narrower than its cell
  return null;
}
function isBlockedAt(x, z) {
  if (x < -49 || x > 49 || z < -49 || z > 49) return true;
  const selfRadius = local.prone ? 1.15 : PLAYER_RADIUS;
  const obstacleRadius = local.prone ? 0.55 : PLAYER_RADIUS;
  for (const o of mapObstacles) {
    if (o.solid === false) continue;
    if (o.type === "house" || o.type === "hut") {
      if (blockedByBuilding(o, x, z, obstacleRadius)) return true;
      continue;
    }
    const footprint = obstacleFootprintRadius(o);
    if (footprint !== null) {
      if (Math.hypot(x - o.x, z - o.z) < footprint + obstacleRadius)
        return true;
      continue;
    }
    const closestX = Math.max(o.x - o.w / 2, Math.min(x, o.x + o.w / 2));
    const closestZ = Math.max(o.z - o.w / 2, Math.min(z, o.z + o.w / 2));
    if (Math.hypot(x - closestX, z - closestZ) < obstacleRadius) return true;
  }
  for (const p of gameState?.players || []) {
    if (p.id === playerId || !p.alive) continue;
    const otherRadius = p.prone ? 1.15 : PLAYER_RADIUS;
    if (Math.hypot(x - p.x, z - p.z) < selfRadius + otherRadius + 0.02)
      return true;
  }
  return false;
}
function initWorld() {
  const host = $("#world");
  host.innerHTML = "";
  const forest = mapId === "forest";
  scene = new THREE.Scene();
  scene.background = new THREE.Color(forest ? "#91b18a" : "#c5aa79");
  scene.fog = new THREE.Fog(forest ? "#91b18a" : "#c5aa79", 48, 112);
  baseFov = 76;
  const viewport = host.getBoundingClientRect();
  camera = new THREE.PerspectiveCamera(
    baseFov,
    viewport.width / viewport.height,
    0.1,
    180,
  );
  camera.position.set(
    local.x,
    1.65 + groundHeightAt(local.x, local.z),
    local.z,
  );
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
  scene.add(
    new THREE.HemisphereLight(
      forest ? 0xe0f5d9 : 0xffedcc,
      forest ? 0x334d30 : 0x66543b,
      2,
    ),
  );
  const sun = new THREE.DirectionalLight(0xffedc5, 2);
  sun.position.set(-15, 30, 12);
  scene.add(sun);

  if (!mapObstacles.length) mapObstacles = gameState?.obstacles || [];
  createGroundMesh(forest);
  if (forest) addForestGrass(gameState?.mapSeed ?? 305419896);
  for (const obstacle of mapObstacles) drawMapObject(obstacle, forest);
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
  for (const item of lootItems.values()) {
    item.mesh = null;
    addLootMesh(item);
  }
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
  flash.style.background =
    "radial-gradient(ellipse, transparent 35%, rgba(190, 0, 24, .72) 100%)";
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
  const nowMs = Date.now();
  for (const p of state.players) {
    if (p.id === playerId) {
      local.hp = p.hp;
      local.kills = p.kills;
      ammo = p.ammo;
      local.reserveAmmo = p.reserveAmmo;
      local.medkits = p.medkits || 0;
      local.healing = Boolean(p.healing);
      local.healEndsAt = local.healing
        ? performance.now() + (p.healLeftMs || 0)
        : 0;
      if (backpackOpen) renderBackpack();
      const wasLocalReloading = local.reloading;
      local.reloading = Boolean(p.reloading);
      if (local.reloading && !wasLocalReloading) startReloadSounds(null);
      $("#ammo").innerHTML = `${ammo} <i>/ ${local.reserveAmmo}</i>`;
      $("#feed").textContent = local.reloading ? "⟳ ĐANG NẠP ĐẠN · R" : "";
      const reloadHud = $("#reloadHud");
      if (reloadHud)
        reloadHud.style.display = local.reloading ? "flex" : "none";
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
      const rifleBody = new THREE.Mesh(
        new THREE.BoxGeometry(0.17, 0.18, 0.62),
        makeMat("#252821"),
      );
      rifleBody.position.set(0.39, 1.22, -0.34);
      weapon.add(rifleBody);
      const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.045, 0.48, 7),
        makeMat("#666b5e"),
      );
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0.39, 1.24, -0.83);
      weapon.add(barrel);
      const stock = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, 0.2, 0.28),
        makeMat("#594432"),
      );
      stock.position.set(0.39, 1.21, 0.08);
      weapon.add(stock);
      const grip = new THREE.Mesh(
        new THREE.BoxGeometry(0.09, 0.25, 0.12),
        makeMat("#34372f"),
      );
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
      const dashMaterial = new THREE.MeshBasicMaterial({
        color: 0xd6ff45,
        toneMapped: false,
      });
      for (let dash = 0; dash < dashCount; dash++) {
        const angle = (dash / dashCount) * Math.PI * 2;
        const segment = new THREE.Mesh(
          new THREE.BoxGeometry(0.13, 0.1, 0.11),
          dashMaterial,
        );
        segment.position.set(Math.cos(angle) * 0.3, 0, Math.sin(angle) * 0.3);
        segment.rotation.y = -angle;
        reloadIndicator.add(segment);
      }
      reloadIndicator.position.set(0, 2.2, 0);
      mesh.add(reloadIndicator);
      // Chữ thập đỏ xoay trên đầu khi đối phương đang hồi máu (ba thanh vuông góc nên nhìn phía nào cũng thấy).
      const healIndicator = new THREE.Group();
      const healMaterial = new THREE.MeshBasicMaterial({
        color: 0xff4d5e,
        toneMapped: false,
      });
      for (const [w, h, d] of [
        [0.52, 0.14, 0.14],
        [0.14, 0.52, 0.14],
        [0.14, 0.14, 0.52],
      ]) {
        healIndicator.add(
          new THREE.Mesh(new THREE.BoxGeometry(w, h, d), healMaterial),
        );
      }
      healIndicator.position.set(0, 2.2, 0);
      healIndicator.visible = false;
      mesh.add(healIndicator);
      mesh.userData = {
        torso,
        head,
        legs,
        weapon,
        muzzleFlash,
        reloadIndicator,
        healIndicator,
        shotId: Number(p.shotId) || 0,
        flashUntil: 0,
        lastGunshotAt: 0,
        reloading: Boolean(p.reloading),
        lastMotionX: p.x,
        lastMotionZ: p.z,
        footstepDistance: 0,
      };
      scene.add(mesh);
      remoteMeshes.set(p.id, mesh);
    }
    mesh.rotation.order = "YXZ";
    // Negative X rotation lays local +Y toward local -Z, matching the server's
    // prone hitbox centers (head forward, legs behind).
    mesh.rotation.set(p.prone ? -Math.PI / 2 : 0, p.yaw, 0);
    mesh.position.set(
      p.x,
      p.swimming
        ? p.swimY || 0
        : (p.groundY || 0) + (p.prone ? 0.35 : p.jumpY || 0),
      p.z,
    );
    mesh.scale.set(1, p.crouching && !p.prone ? 0.68 : 1, 1);
    mesh.userData.slowWalking = Boolean(p.slowWalking);
    const wasReloading = Boolean(mesh.userData.reloading);
    mesh.userData.reloading = Boolean(p.reloading);
    if (mesh.userData.reloading && !wasReloading && p.alive)
      startReloadSounds(p.id);
    mesh.userData.reloadIndicator.visible = Boolean(p.reloading);
    mesh.userData.reloadIndicator.position.y = p.prone
      ? 0.78
      : p.crouching
        ? 1.55
        : 2.2;
    mesh.userData.healing = Boolean(p.healing);
    mesh.userData.healIndicator.visible = Boolean(p.healing);
    mesh.userData.healIndicator.position.y = p.prone
      ? 0.78
      : p.crouching
        ? 1.55
        : 2.2;
    const motionDistance = Math.hypot(
      p.x - mesh.userData.lastMotionX,
      p.z - mesh.userData.lastMotionZ,
    );
    const canStep = p.alive && !p.prone && !p.swimming;
    if (canStep && motionDistance < 1.5) {
      // Accumulate replicated movement distance so unrelated state packets
      // (such as firing/reloading) cannot break footstep timing.
      mesh.userData.footstepDistance += motionDistance;
      const strideDistance = p.slowWalking ? 1.3 : p.crouching ? 1.5 : 1.85;
      const intensity = p.slowWalking ? 0.42 : p.crouching ? 0.62 : 1;
      while (mesh.userData.footstepDistance >= strideDistance) {
        const soundY = p.groundY || 0;
        playSpatialFootstep(p.x, soundY + 0.08, p.z, intensity);
        mesh.userData.footstepDistance -= strideDistance;
      }
    } else if (!canStep || motionDistance >= 1.5) {
      mesh.userData.footstepDistance = 0;
    }
    mesh.userData.lastMotionX = p.x;
    mesh.userData.lastMotionZ = p.z;
    // Đếm số phát mới theo shotId của server (mỗi phát bắn tăng 1).
    const shotCount =
      (Number(p.shotId) || 0) - (Number(mesh.userData.shotId) || 0);
    if (shotCount > 0) {
      mesh.userData.shotId = Number(p.shotId) || 0;
      mesh.userData.flashUntil = nowMs + 95;
      mesh.userData.lastGunshotAt = nowMs;
      const soundBaseY = p.swimming ? p.swimY || 0 : p.groundY || 0;
      const muzzleY = soundBaseY + (p.prone ? 0.55 : p.crouching ? 0.9 : 1.3);
      // Nếu một gói tin gộp nhiều phát thì phát lần lượt, cách nhau 120 ms.
      for (let i = 0; i < Math.min(shotCount, 4); i++) {
        playSpatialGunshot({ x: p.x, y: muzzleY, z: p.z }, 0.78, i * 0.12);
      }
    }
    mesh.userData.muzzleFlash.visible = Date.now() < mesh.userData.flashUntil;
    mesh.userData.weapon.rotation.x =
      Date.now() < mesh.userData.flashUntil ? 0.12 : 0;
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
// ---------------------------------------------------------------------------
// VẬT PHẨM RƠI TRÊN MAP (đạn, bịch máu) · BALO (Tab) · HỒI MÁU
// ---------------------------------------------------------------------------
// Server sinh vật phẩm ngẫu nhiên khi bắt đầu trận và quyết định ai nhặt được.
// Client chỉ vẽ vật phẩm, hiện gợi ý "F" và gửi yêu cầu lên server.
function lootLabel(item) {
  return item.type === "ammo" ? `ĐẠN 5.56 (+${item.amount})` : "BỊCH MÁU";
}
function setLootItems(items) {
  for (const item of lootItems.values()) disposeLootMesh(item);
  lootItems.clear();
  for (const item of items)
    lootItems.set(item.id, { ...item, mesh: null, body: null });
  if (scene && renderer)
    for (const item of lootItems.values()) addLootMesh(item);
}
function removeLootItem(id) {
  const item = lootItems.get(id);
  if (!item) return;
  disposeLootMesh(item);
  lootItems.delete(id);
}
function disposeLootMesh(item) {
  if (!item.mesh) return;
  scene?.remove(item.mesh);
  item.mesh.traverse((o) => {
    o.geometry?.dispose();
    o.material?.dispose();
  });
  item.mesh = null;
  item.body = null;
}
function addLootMesh(item) {
  if (!scene || item.mesh) return;
  const isMed = item.type === "medkit";
  const root = new THREE.Group();
  const body = new THREE.Group();
  if (isMed) {
    body.add(
      new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.34, 0.34),
        makeMat("#f2f2ec"),
      ),
    );
    const crossMat = new THREE.MeshBasicMaterial({ color: 0xd8202f });
    const bar = (w, h, d, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), crossMat);
      m.position.set(x, y, z);
      body.add(m);
    };
    bar(0.28, 0.02, 0.08, 0, 0.175, 0); // chữ thập trên nắp
    bar(0.08, 0.02, 0.28, 0, 0.175, 0);
    for (const side of [1, -1]) {
      bar(0.28, 0.08, 0.02, 0, 0, 0.171 * side); // hai mặt trước/sau
      bar(0.08, 0.28, 0.02, 0, 0, 0.171 * side);
    }
  } else {
    body.add(
      new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.28, 0.32),
        makeMat("#54602f"),
      ),
    );
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.02, 0.08),
      makeMat("#d5a83a"),
    );
    stripe.position.y = 0.15;
    body.add(stripe);
    const brass = makeMat("#d9b64a");
    for (let i = 0; i < 4; i++) {
      const bullet = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.035, 0.2, 8),
        brass,
      );
      bullet.rotation.z = Math.PI / 2;
      bullet.position.set(0, 0.2, -0.105 + i * 0.07);
      body.add(bullet);
    }
  }
  root.add(body);
  const color = isMed ? 0xff4d5e : 0xffd24a;
  // Vòng sáng dưới đất + cột sáng mảnh để dễ thấy từ xa.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.7, 24),
    new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.75,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  root.add(ring);
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 3.2, 6),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    }),
  );
  beam.position.y = 1.6;
  root.add(beam);
  body.position.y = 0.4;
  root.position.set(item.x, groundHeightAt(item.x, item.z), item.z);
  scene.add(root);
  item.mesh = root;
  item.body = body;
}
// Balo còn chỗ cho loại vật phẩm này không?
function packHasRoom(type) {
  return type === "ammo"
    ? (local.reserveAmmo ?? 0) < packLimits.ammo
    : (local.medkits || 0) < packLimits.medkits;
}
function nearestLoot() {
  let best = null;
  let bestDistance = PICKUP_RADIUS;
  for (const item of lootItems.values()) {
    const d = Math.hypot(item.x - local.x, item.z - local.z);
    if (d < bestDistance) {
      best = item;
      bestDistance = d;
    }
  }
  return best;
}
function onInteract() {
  // F: đang hồi máu thì hủy hồi máu, ngược lại nhặt vật phẩm gần nhất.
  if (local.healing) {
    send({ type: "cancelHeal" });
    return;
  }
  if (!local.swimming && nearestLoot()) send({ type: "pickup" });
}
function useMedkit() {
  if (local.healing) return showLootToast("ĐANG HỒI MÁU · NHẤN F ĐỂ HỦY");
  if (local.reloading) return showLootToast("ĐANG NẠP ĐẠN");
  if ((local.medkits || 0) <= 0) return showLootToast("KHÔNG CÒN BỊCH MÁU");
  if (local.hp >= 100) return showLootToast("MÁU ĐÃ ĐẦY");
  send({ type: "heal" });
  closeBackpack(); // đóng balo để tiếp tục chơi trong lúc hồi máu
}
function installLootUi() {
  document.querySelector("#backpack")?.remove();
  document.querySelector("#lootHud")?.remove();
  if (!document.querySelector("#lootStyles")) {
    const style = document.createElement("style");
    style.id = "lootStyles";
    style.textContent = `
#backpack{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:min(430px,92vw);pointer-events:auto;background:#171a14ed;border:1px solid #555b48;box-shadow:0 15px 60px #0009;padding:22px;color:#f3f3ed;font-family:'DM Mono',monospace;z-index:5}
#backpack .bp-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px}
#backpack .bp-head span{font:900 26px 'Barlow Condensed',Arial,sans-serif;letter-spacing:3px;color:#d6ff45}
#backpack .bp-head small,#backpack .bp-foot{font-size:9px;letter-spacing:1px;color:#85897d}
#backpack .bp-foot{margin-top:14px}
#backpack .bp-row{display:flex;align-items:center;gap:14px;border:1px solid #373b31;padding:13px 15px;margin:9px 0;user-select:none}
#backpack .bp-row>b{font-size:22px;color:#d6ff45;width:24px;text-align:center}
#backpack .bp-row strong{display:block;font-size:13px;letter-spacing:1px}
#backpack .bp-row small{display:block;margin-top:5px;font-size:9px;letter-spacing:1px;color:#929688}
#backpack .bp-count{margin-left:auto;font-size:26px;color:#d6ff45;white-space:nowrap}
#backpack .bp-count small{display:inline;margin:0 0 0 3px;font-size:12px;color:#929688}
#backpack .bp-count.full{color:#ff7a5c}
#backpack .bp-usable{cursor:pointer}
#backpack .bp-usable:hover{border-color:#d6ff45;background:#d6ff4514}
#backpack .bp-usable.empty{opacity:.45;cursor:not-allowed}
#backpack .bp-usable.empty:hover{border-color:#373b31;background:none}
#lootHud{position:absolute;left:50%;bottom:118px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;font-family:'DM Mono',monospace;text-shadow:0 1px 4px #000;z-index:4}
#lootHud .lh-prompt{background:#111c;border:1px solid #d6ff4599;padding:8px 14px;font-size:12px;letter-spacing:1px;color:#fff}
#lootHud .lh-prompt b{color:#d6ff45;margin-right:8px}
#lootHud .lh-heal{width:260px;text-align:center;font-size:11px;letter-spacing:1px;color:#fff}
#lootHud .lh-heal div{height:7px;margin-top:6px;background:#111a;border:1px solid #ffffff33}
#lootHud .lh-heal i{display:block;height:100%;width:0;background:#d6ff45}
#lootHud .lh-toast{background:#111d;padding:7px 14px;font-size:11px;letter-spacing:1px;color:#d6ff45;transition:opacity .25s}`;
    document.head.append(style);
  }
  const panel = document.createElement("div");
  panel.id = "backpack";
  panel.className = "hidden";
  panel.innerHTML = `
    <div class="bp-head"><span>BALO</span><small>TAB / ESC · ĐÓNG</small></div>
    <div class="bp-row"><b>▮</b><div><strong>ĐẠN 5.56 MM</strong><small>ĐANG LẮP TRONG SÚNG: <span id="bpMag">30</span> / 30</small></div><span class="bp-count" id="bpAmmoCount">0</span></div>
    <div class="bp-row bp-usable" id="bpMed"><b>✚</b><div><strong>BỊCH MÁU</strong><small>CHUỘT PHẢI ĐỂ DÙNG · +20 MÁU · 5 GIÂY</small></div><span class="bp-count" id="bpMedCount">0</span></div>
    <div class="bp-foot">F · NHẶT VẬT PHẨM GẦN BẠN · F KHI ĐANG HỒI MÁU = HỦY</div>`;
  $(".hud").append(panel);
  $("#bpMed").addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    useMedkit();
  });
  const hud = document.createElement("div");
  hud.id = "lootHud";
  hud.innerHTML = `<div class="lh-toast hidden"></div><div class="lh-prompt hidden"></div><div class="lh-heal hidden"><span></span><div><i></i></div></div>`;
  $(".hud").append(hud);
}
function renderBackpack() {
  if (!$("#backpack")) return;
  $("#bpAmmoCount").innerHTML =
    `${local.reserveAmmo ?? 0}<small>/${packLimits.ammo}</small>`;
  $("#bpMag").textContent = ammo;
  $("#bpMedCount").innerHTML =
    `${local.medkits || 0}<small>/${packLimits.medkits}</small>`;
  $("#bpAmmoCount").classList.toggle("full", !packHasRoom("ammo"));
  $("#bpMedCount").classList.toggle("full", !packHasRoom("medkit"));
  $("#bpMed").classList.toggle("empty", !(local.medkits > 0));
}
function openBackpack() {
  if (backpackOpen || paused || !$("#game").classList.contains("active"))
    return;
  backpackOpen = true;
  stopFiring();
  if (scoped) setScope(false);
  renderBackpack();
  $("#backpack").classList.remove("hidden");
  // Thả chuột để bấm được vào balo; trận vẫn tiếp tục chạy (không tạm dừng).
  if (document.pointerLockElement) document.exitPointerLock();
}
function closeBackpack(relock = true) {
  if (!backpackOpen) return;
  backpackOpen = false;
  $("#backpack")?.classList.add("hidden");
  if (relock && !paused && $("#game").classList.contains("active")) {
    renderer?.domElement.requestPointerLock?.();
  }
}
function toggleBackpack() {
  if (backpackOpen) closeBackpack();
  else openBackpack();
}
function showLootToast(text) {
  const el = $("#lootHud .lh-toast");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(lootToastTimer);
  lootToastTimer = setTimeout(() => el.classList.add("hidden"), 1800);
}
// Súng góc nhìn thứ nhất hạ xuống và gập ngang khi đang hồi máu (đang bận thao tác).
function updateGunPose(dt) {
  if (!gun) return;
  const target = local.healing ? 1 : 0;
  gunBusy += (target - gunBusy) * Math.min(10 * dt, 1);
  if (Math.abs(target - gunBusy) < 0.002) gunBusy = target;
  gun.rotation.set(0.15 * gunBusy, 1.35 * gunBusy, -0.12 * gunBusy);
  gun.position.set(0.3 * gunBusy, -0.14 * gunBusy, 0.05 * gunBusy);
}
// Gọi mỗi frame: xoay/nhấp nhô vật phẩm, gợi ý phím F, thanh hồi máu.
function updateLootHud(dt) {
  const t = performance.now() / 1000;
  for (const item of lootItems.values()) {
    if (!item.body) continue;
    item.body.rotation.y += dt * 1.4;
    item.body.position.y = 0.4 + Math.sin(t * 2 + item.id) * 0.06;
  }
  const prompt = $("#lootHud .lh-prompt");
  const heal = $("#lootHud .lh-heal");
  if (!prompt || !heal) return;
  if (local.healing) {
    const left = Math.max(0, local.healEndsAt - performance.now());
    heal.querySelector("span").textContent =
      `ĐANG HỒI MÁU ${(left / 1000).toFixed(1)}S · F ĐỂ HỦY`;
    heal.querySelector("i").style.width =
      `${Math.min(100, (1 - left / HEAL_DURATION_MS) * 100)}%`;
    heal.classList.remove("hidden");
    prompt.classList.add("hidden");
    return;
  }
  heal.classList.add("hidden");
  const near = local.swimming ? null : nearestLoot();
  if (near) {
    prompt.innerHTML = packHasRoom(near.type)
      ? `<b>F</b>NHẶT ${lootLabel(near)}`
      : `<b>✕</b>BALO ĐẦY · KHÔNG NHẶT ĐƯỢC ${near.type === "ammo" ? "ĐẠN" : "BỊCH MÁU"}`;
    prompt.classList.remove("hidden");
  } else {
    prompt.classList.add("hidden");
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
  local.swimming = false;
  local.swimY = null;
  local.swimDepth = 0;
  local.reloading = false;
  local.reserveAmmo = 90;
  local.medkits = 0;
  local.healing = false;
  local.healEndsAt = 0;
  backpackOpen = false;
  paused = false;
  scoped = false;
  ammo = 30;
  startedAt = Date.now();
  $("#ammo").innerHTML = `${ammo} <i>/ 90</i>`;
  show("game");
  initWorld();
  $("#world").onclick = () => {
    if (!paused && !backpackOpen) renderer.domElement.requestPointerLock?.();
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
  installLootUi();
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
    display: "none",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "8px",
    margin: "4px 0 2px",
    color: "#d6ff45",
    font: "bold 11px 'DM Mono', monospace",
    letterSpacing: "1px",
    textShadow: "0 1px 4px #000",
  });
  const spinner = document.createElement("i");
  Object.assign(spinner.style, {
    width: "20px",
    height: "20px",
    display: "block",
    borderRadius: "50%",
    background:
      "repeating-conic-gradient(#d6ff45 0deg 20deg, transparent 20deg 36deg)",
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
  if (backpackOpen) return; // đang mở balo: thả chuột là chủ ý, không tạm dừng
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

    if (backpackOpen) {
      closeBackpack();
      return;
    }
    if (paused) resumeGame();
    else pauseGame();

    return;
  }

  if (e.code === "Tab" && !paused && $("#game").classList.contains("active")) {
    e.preventDefault(); // không cho Tab đổi focus của trình duyệt
    if (!e.repeat) toggleBackpack();
    return;
  }

  if (
    e.code === "KeyF" &&
    !e.repeat &&
    !paused &&
    $("#game").classList.contains("active")
  ) {
    e.preventDefault();
    onInteract();
    return;
  }

  if (
    e.code === "KeyR" &&
    !e.repeat &&
    !paused &&
    $("#game").classList.contains("active")
  ) {
    e.preventDefault();
    if (!local.healing) send({ type: "reload" });
    return;
  }

  if (
    e.code === "KeyZ" &&
    !e.repeat &&
    !paused &&
    grounded &&
    !waterAt(local.x, local.z) &&
    $("#game").classList.contains("active")
  ) {
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
    !waterAt(local.x, local.z) &&
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
  closeBackpack(false);
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
  closeBackpack(false);
  for (const item of lootItems.values()) disposeLootMesh(item);
  lootItems.clear();
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
      !local.healing &&
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
  if (
    !triggerHeld ||
    paused ||
    !$("#game").classList.contains("active") ||
    document.pointerLockElement !== renderer?.domElement
  ) {
    stopFiring();
    return;
  }
  if (local.reloading || local.healing) return;
  if (ammo <= 0) {
    tone(120, 0.07, "square", 0.015);
    stopFiring();
    return;
  }
  ammo--;
  $("#ammo").innerHTML = `${ammo} <i>/ ${local.reserveAmmo ?? 90}</i>`;
  playSpatialGunshot(null, 0.65);
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
      if (Date.now() >= mesh.userData.flashUntil)
        mesh.userData.weapon.rotation.x = 0;
    }
    mesh.userData.muzzleFlash.visible = Date.now() < mesh.userData.flashUntil;
    if (mesh.userData.healing) mesh.userData.healIndicator.rotation.y += dt * 5;
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
  updateLootHud(dt);
  updateGunPose(dt);
  if (!paused) {
    const currentlyInWater = Boolean(waterAt(local.x, local.z));
    const isProne = !currentlyInWater && Boolean(local.prone);
    const isCrouching =
      !currentlyInWater && !isProne && (keys.ShiftLeft || keys.ShiftRight);

    local.crouching = isCrouching;

    const isSlowWalking = keys.ControlLeft || keys.ControlRight;

    let moveSpeed = currentlyInWater ? 3.2 : isProne ? 1.3 : NORMAL_SPEED;

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
    const stayInWaterWhileSubmerged =
      currentlyInWater && (local.swimDepth || 0) > 0.12;
    const canMoveTo = (x, z) =>
      !isBlockedAt(x, z) && (!stayInWaterWhileSubmerged || waterAt(x, z));
    if (canMoveTo(local.x + moveX, local.z)) local.x += moveX;
    if (canMoveTo(local.x, local.z + moveZ)) local.z += moveZ;
    const water = waterAt(local.x, local.z);
    $("#swimHint")?.classList.toggle("hidden", !water);
    if (water) {
      if (!local.swimming) local.swimDepth = 0;
      local.swimming = true;
      local.prone = false;
      local.crouching = false;
      local.jumping = false;
      const maxDive = Math.max(0, water.depth - 1.8);
      if (keys.Space) local.swimDepth -= 2.5 * dt;
      if (keys.ControlLeft || keys.ControlRight) local.swimDepth += 2.2 * dt;
      local.swimDepth = Math.max(0, Math.min(maxDive, local.swimDepth || 0));
      local.swimY = water.surfaceY - 1.58 - local.swimDepth;
      jumpOffset = 0;
      verticalSpeed = 0;
      grounded = true;
      const swimEyeY = local.swimY + 1.65;
      camera.position.y += (swimEyeY - camera.position.y) * Math.min(7 * dt, 1);
      $("#underwaterTint")?.classList.toggle(
        "active",
        camera.position.y < water.surfaceY,
      );
    } else {
      $("#underwaterTint")?.classList.remove("active");
      local.swimming = false;
      local.swimDepth = 0;
      local.swimY = null;
      const targetHeight =
        groundHeightAt(local.x, local.z) +
        (isProne ? PRONE_HEIGHT : isCrouching ? CROUCH_HEIGHT : STAND_HEIGHT);
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
        prone: local.prone,
        swimming: local.swimming,
        swimY: local.swimY,
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
  closeBackpack(false);
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
    const secondsLeft = Math.max(
      0,
      Math.ceil((resultEndsAt - Date.now()) / 1000),
    );
    $("#resultDetail").textContent =
      `${resultMessage} Tự động về Home sau ${secondsLeft} giây.`;
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
