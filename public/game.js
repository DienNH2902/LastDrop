// Client prototype: Three.js scene, FPS controls and WebSocket room connection.
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.166.1/build/three.module.js";

const $ = (s) => document.querySelector(s),
  screens = [...document.querySelectorAll(".screen")];
let settingsReturnScreen = "menu";
const show = (id) => {
  if (id === "settings")
    settingsReturnScreen =
      screens.find((screen) => screen.classList.contains("active"))?.id ||
      "menu";
  screens.forEach((x) => x.classList.toggle("active", x.id === id));
  syncHomeMusic(id);
};
const companySplash = $("#companySplash"),
  loading = $("#loading"),
  app = $("#app");
// Read the same duration used by the loading bar's CSS animation.
const loadingDurationMs =
  Number.parseFloat(
    getComputedStyle(loading).getPropertyValue("--loading-duration"),
  ) || 5000;
setTimeout(() => {
  companySplash.classList.add("hidden");
  loading.classList.remove("hidden");
  setTimeout(() => {
    loading.classList.add("hidden");
    app.classList.remove("hidden");
  }, loadingDurationMs);
}, 6000);
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
    groundY: 0,
    yaw: 0,
    hp: 100,
    weapon: "ranger",
    kills: 0,
    placement: 0,
    peek: 0,
    crouching: false,
    jumping: false,
    swimming: false,
    swimY: null,
    swimDepth: 0,
    vehicleId: null,
    vehicleSeat: -1,
    state: "lobby", // lobby → plane → freefall → parachute → ground
    y: 0, // độ cao (chân) khi ở trên không
    seat: 0, // chỗ đứng trong máy bay
  };
let keys = {},
  ammo = 30,
  startedAt = 0,
  audioCtx = null,
  noiseBuffer = null,
  gunshotReverbBuffer = null,
  soundOn = true,
  lastMove = 0,
  paused = false,
  scoped = false,
  verticalSpeed = 0,
  grounded = true,
  jumpOffset = 0,
  baseFov = 76,
  sniperZoomFov = 12,
  mapObstacles = [],
  mapHills = [],
  mapId = "forest",
  selectedMap =
    localStorage.getItem("ld-selected-map") === "desert" ? "desert" : "forest",
  triggerHeld = false,
  fireInterval = null,
  lastClientShotAt = 0,
  pendingLocalShots = [],
  lastLocalShotAckId = 0,
  lastHitEventId = 0,
  lastFlightMapDraw = 0,
  bloodParticles = [],
  zoneWallMesh = null,
  zoneTargetLine = null,
  resultTimeout = null,
  resultCountdown = null,
  resultEndsAt = 0,
  deathResultTimer = null,
  deathView = null,
  recoilPitch = 0,
  recoilYaw = 0,
  peekBlend = 0,
  lastEliminationId = 0,
  localEliminationMessage = "",
  killFeedTimers = [],
  vehicleMeshes = new Map(),
  vehicleAudioNodes = new Map(),
  vehicleFireAudioNodes = new Map(),
  steeringWheel = null,
  lastVehicleControlAt = 0;
// Slightly above the server's 120 ms cadence so timer/network jitter won't
// cause valid automatic shots to be rejected by the server.
const FIRE_INTERVAL_MS = 130;
const SNIPER_FIRE_INTERVAL_MS = 2500;

const STATE_ORDER = {
  lobby: 0,
  plane: 1,
  freefall: 2,
  parachute: 3,
  ground: 4,
};
// Chỗ đứng trong khoang máy bay (x phải, z lùi về sau); khớp với server.js.
const PLANE_SEATS = [
  [-0.9, 2.2],
  [0.9, 2.2],
  [-0.9, 0.6],
  [0.9, 0.6],
  [-0.9, -1.0],
];
const MAP_HALF = 200; // map 400 × 400 m, diện tích gấp 4 lần bản hiện tại
const MAP_SCALE = MAP_HALF / 50;
const AIR = {
  freefallHoriz: 20, // m/s bay ngang khi rơi tự do
  diveHoriz: 13, // m/s bay ngang khi lao xuống (giữ Shift)
  chuteHoriz: 9, // m/s bay ngang khi đã bung dù
  freefallFall: 32, // m/s rơi tự do
  diveFall: 52, // m/s khi lao xuống
  chuteFall: 5.5, // m/s khi đã bung dù (hạ từ từ)
  gravity: 24, // m/s² tăng tốc khi rơi
  autoDeployAlt: 35, // dưới độ cao này (m) mà chưa bung dù thì tự bung
};
let inMatch = false, // đã vào màn hình trận (phòng chờ trong map, máy bay, mặt đất)
  plane = null, // đường bay server gửi: { sx, sz, dx, dz, speed, alt, tEnter, tExit, startedAt }
  serverOffset = 0,
  serverOffsetReady = false,
  countdownEndsAt = 0,
  matchPhase = "waiting",
  lastCountdownNumber = null,
  readySent = false,
  jumpRequestedAt = 0,
  jumpCuePlayed = false,
  planeObject = null,
  planeCloudField = null,
  envBlend = 0,
  localFootstepDistance = 0,
  localGaitPhase = 0,
  localLegLeft = null,
  localLegRight = null,
  airState = { vx: 0, vz: 0, fall: 0, time: 0 };
const audioLoops = { plane: null, wind: null, weather: null };
let weatherFx = null;
let weatherActive = false; // đồng bộ theo weatherActive server gửi trong state, không tự hẹn giờ nữa

// Track nguồn MP3, tự lặp ở các màn menu và dừng khi vào trận.
const homeMusic = new Audio(
  "https://orangefreesounds.com/wp-content/uploads/2025/06/Deep-ambient-dramatic-background-music.mp3",
);
homeMusic.loop = true;
homeMusic.preload = "none";
function syncHomeMusic(
  screenId = screens.find((screen) => screen.classList.contains("active"))?.id,
) {
  const volume = soundOn
    ? (Number($("#music")?.value ?? 0) / 100) *
      (Number($("#masterVolume")?.value ?? 0) / 100)
    : 0;
  homeMusic.volume = Math.max(0, Math.min(1, volume));
  if (screenId !== "game" && homeMusic.volume > 0) {
    homeMusic.play().catch(() => {}); // Trình duyệt bắt đầu phát sau click đầu tiên.
  } else {
    homeMusic.pause();
  }
}
document.addEventListener("pointerdown", () => syncHomeMusic(), { once: true });
document.addEventListener("keydown", () => syncHomeMusic(), { once: true });
const loopBuffers = {};
const tmpColorA = new THREE.Color();
const tmpColorB = new THREE.Color();

// Vật phẩm / balo / hồi máu (server quyết định kết quả, khớp với server.js)
const PICKUP_RADIUS = 2;
const HEAL_DURATION_MS = 5000;
const lootItems = new Map(); // id -> { id, type, x, z, amount, mesh, body }
const lootCrates = new Map(); // Hòm đồ được đồng bộ từ server theo vị trí người chơi bị hạ.
const interactRaycaster = new THREE.Raycaster();
const crosshairNdc = new THREE.Vector2(0, 0);
let backpackOpen = false,
  crateOpenId = null,
  lootToastTimer = null,
  gunBusy = 0, // 0 = cầm súng bình thường, 1 = súng gập ngang (đang hồi máu)
  gunAimBlend = 0,
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
const savedPlayerName =
  localStorage.getItem("ld-player-name") || saved.name || "Rookie";
$("#nameInput").value = savedPlayerName;
localStorage.setItem("ld-player-name", savedPlayerName);
$("#sensitivity").value = saved.sensitivity || 50;
$("#sfx").value = saved.sfx ?? 30;
$("#music").value = saved.music ?? 10;
$("#masterVolume").value = saved.masterVolume ?? 30;
$("#quality").value = saved.quality || "Performance";
delete saved.name; // nickname is kept separately from graphics/audio settings
localStorage.setItem(
  "ld-settings",
  JSON.stringify({ ...saved, masterVolume: $("#masterVolume").value }),
);
function tone(freq = 440, duration = 0.06, type = "sine", volume = 0.03) {
  if (!soundOn) return;
  const effectiveVolume =
    volume * (Number($("#masterVolume")?.value ?? 100) / 100);
  if (!(effectiveVolume > 0)) return;
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  const o = audioCtx.createOscillator(),
    g = audioCtx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.value = effectiveVolume;
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
  const overall = Number($("#masterVolume").value) / 100;
  if (!(overall > 0)) return null;
  master.gain.value = Math.max(0.0001, volume * sfx * overall * attenuation);
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
  ensureNoiseBuffer(audioCtx);
  return { t0: now + delay, input, noiseBuffer, master };
}
function ensureNoiseBuffer(ctx = ensureAudio()) {
  if (noiseBuffer) return noiseBuffer;
  noiseBuffer = ctx.createBuffer(
    1,
    Math.ceil(ctx.sampleRate * 0.45),
    ctx.sampleRate,
  );
  const samples = noiseBuffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  return noiseBuffer;
}
// Đường cong méo tiếng (soft-clip) — tạo "grit" như tiếng súng thật ghi âm gần,
// vốn luôn hơi vỡ tiếng chứ không "sạch" như âm tổng hợp thuần.
function makeDistortionCurve(amount = 20) {
  const n = 256;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}
// Impulse response giả lập tiếng vọng ngoài trời (nhiễu trắng suy giảm dần) —
// đây mới là phần tạo ra "tiếng vang" thật sự, khác với tiếng dội trầm (chỉ là
// một nốt trầm tắt dần chứ không phải phản xạ âm thanh).
function ensureGunshotReverb(ctx = ensureAudio()) {
  if (gunshotReverbBuffer) return gunshotReverbBuffer;
  const duration = 1.7;
  const length = Math.ceil(ctx.sampleRate * duration);
  gunshotReverbBuffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = gunshotReverbBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const decay = Math.pow(1 - i / length, 2.6);
      data[i] = (Math.random() * 2 - 1) * decay;
    }
  }
  return gunshotReverbBuffer;
}
// Gửi một phần tiếng súng qua bộ vọng âm rồi trộn vào đường ra cuối (a.master).
// Convolver rất tốn để khởi tạo (gán buffer = phải tính lại FFT của impulse
// response). Súng auto bắn nhiều phát/giây nên KHÔNG được tạo mới mỗi phát —
// chỉ tạo 1 lần duy nhất rồi dùng lại mãi mãi cho mọi tiếng súng.
let gunshotConvolver = null;
function ensureGunshotConvolver(ctx = ensureAudio()) {
  if (gunshotConvolver) return gunshotConvolver;
  gunshotConvolver = ctx.createConvolver();
  gunshotConvolver.buffer = ensureGunshotReverb(ctx); // chỉ gán 1 lần trong cả trận
  const output = ctx.createGain();
  output.gain.value = 1;
  gunshotConvolver.connect(output);
  output.connect(ctx.destination);
  return gunshotConvolver;
}
// Gửi một phần tiếng súng qua bộ vọng âm (dùng lại 1 convolver chung) rồi trộn
// ra loa — các node ở đây (delay/lọc/gain) đều rẻ, tạo mới mỗi phát không sao.
function gunshotReverbTail(
  a,
  { wet = 0.3, tone = 1400, predelay = 0.01 } = {},
) {
  if (!a.master) return;
  const convolver = ensureGunshotConvolver(audioCtx);
  const delayNode = audioCtx.createDelay(0.05);
  delayNode.delayTime.value = predelay;
  const tiltFilter = audioCtx.createBiquadFilter();
  tiltFilter.type = "lowpass";
  tiltFilter.frequency.value = tone;
  const wetGain = audioCtx.createGain();
  // Nhân thêm âm lượng thực tế của phát súng đó (đã tính suy giảm theo khoảng
  // cách) để tiếng vang cũng nhỏ dần theo khoảng cách như tiếng súng gốc.
  const masterLevel = a.master.gain.value || 0;
  wetGain.gain.value = wet * masterLevel;
  a.input.connect(delayNode);
  delayNode.connect(tiltFilter);
  tiltFilter.connect(wetGain);
  wetGain.connect(convolver);
}
function noiseBurst(
  a,
  {
    at = 0,
    duration = 0.1,
    filter = "lowpass",
    freq = 1000,
    q = 1,
    gain = 1,
    drive = 0, // >0 = thêm méo tiếng (grit), dùng cho tiếng súng cho "đã tai" hơn
  },
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
  let tail = f;
  if (drive > 0) {
    const shaper = audioCtx.createWaveShaper();
    shaper.curve = makeDistortionCurve(drive);
    shaper.oversample = "2x";
    f.connect(shaper);
    tail = shaper;
  }
  tail.connect(g);
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
// Đặc tính âm bắn theo từng loại súng, mô phỏng theo tiếng nổ thật:
// - "rifle" (RANGER-9, súng tự động): dựa theo AUG — tiếng "tách" sắc, gọn,
//   dội trầm ngắn, đanh và nhanh, đúng chất súng trường tự động 5.56mm.
// - "sniper" (bắn tỉa): dựa theo Kar98k — tiếng nổ trầm, vang, boom sâu và kéo
//   dài hơn hẳn, kèm tiếng vọng đuôi, đúng chất bolt-action cỡ đạn lớn 7.92mm.
const GUNSHOT_PROFILES = {
  rifle: {
    crackDuration: 0.022,
    crackFreq: 3200,
    crackGain: 0.85,
    blastDuration: 0.14,
    blastFreq: 2800,
    blastGain: 0.95,
    boomFrom: 120,
    boomTo: 55,
    boomDuration: 0.11,
    boomGain: 0.7,
    tailGain: 0,
  },
  sniper: {
    crackDuration: 0.03,
    crackFreq: 2400,
    crackGain: 0.9,
    blastDuration: 0.26,
    blastFreq: 1500,
    blastGain: 1.15,
    boomFrom: 78,
    boomTo: 28,
    boomDuration: 0.32,
    boomGain: 1.1,
    tailGain: 0.4,
  },
};
// position: {x, y, z} của họng súng; null = súng của chính mình.
// weapon: "rifle" (mặc định, AUG) hoặc "sniper" (Kar98k).
// AUG (súng tự động RANGER-9): tách nhanh-sắc kiểu bullpup nòng ngắn, có grit,
// dội trầm gọn — to và đanh nhưng không kéo dài/vang xa bằng súng bolt-action.
function playAugShot(a) {
  noiseBurst(a, {
    duration: 0.018,
    filter: "highpass",
    freq: 3400,
    gain: 1.1,
    drive: 18,
  }); // tách đầu nòng
  noiseBurst(a, {
    at: 0.006,
    duration: 0.16,
    filter: "lowpass",
    freq: 3000,
    gain: 1.3,
    drive: 10,
  }); // tiếng nổ chính, có grit
  noiseBurst(a, {
    at: 0.05,
    duration: 0.09,
    filter: "bandpass",
    freq: 1200,
    q: 1.4,
    gain: 0.55,
  }); // dư âm ngắn kiểu bullpup
  toneBurst(a, { duration: 0.1, from: 150, to: 60, gain: 0.9 }); // đấm trầm
  toneBurst(a, { duration: 0.14, from: 80, to: 34, gain: 0.6 }); // lớp sub bổ sung độ "nặng"
  gunshotReverbTail(a, { wet: 0.22, tone: 2200, predelay: 0.006 });
}
// Kar98k (súng sniper): một phát boom cực trầm, cực to, kéo dài, kèm tiếng
// vọng dội đặc trưng của đạn cỡ lớn bắn ngoài trời (bolt-action).
function playKarShot(a) {
  noiseBurst(a, {
    duration: 0.032,
    filter: "highpass",
    freq: 2200,
    gain: 1.15,
    drive: 14,
  }); // tách đầu nòng
  noiseBurst(a, {
    at: 0.008,
    duration: 0.3,
    filter: "lowpass",
    freq: 1400,
    gain: 1.5,
    drive: 22,
  }); // tiếng nổ chính, rất to và vỡ tiếng
  toneBurst(a, { duration: 0.34, from: 85, to: 26, gain: 1.3 }); // boom trầm chính
  toneBurst(a, { at: 0.02, duration: 0.4, from: 46, to: 16, gain: 0.85 }); // lớp sub cực trầm
  noiseBurst(a, {
    at: 0.09,
    duration: 0.5,
    filter: "lowpass",
    freq: 650,
    gain: 0.55,
  }); // đuôi vọng
  gunshotReverbTail(a, { wet: 0.55, tone: 1100, predelay: 0.015 });
}
// position: {x, y, z} của họng súng; null = súng của chính mình.
// weapon: "rifle" (mặc định, AUG) hoặc "sniper" (Kar98k).
function playSpatialGunshot(
  position,
  volume = 0.7,
  delay = 0,
  weapon = "rifle",
) {
  const isSniper = weapon === "sniper";
  const a = spatialAudio(position, {
    volume: volume * (isSniper ? 1.5 : 1.15),
    ...AUDIO_RANGE.gunshot,
    max: AUDIO_RANGE.gunshot.max * (isSniper ? 1.8 : 1.2),
    delay,
  });
  if (!a) return;
  if (isSniper) playKarShot(a);
  else playAugShot(a);
}
function playSpatialFootstep(x, y, z, intensity = 1, ownPlayer = false) {
  if (ownPlayer && local.vehicleId) return;
  // Đi chậm / khom người có tầm nghe ngắn hơn chạy.
  const max = AUDIO_RANGE.footstep.max * intensity;
  const ref = Math.min(AUDIO_RANGE.footstep.ref, max * 0.3);
  const a = spatialAudio(
    { x, y, z },
    { volume: (ownPlayer ? 0.2 : 0.55) * (0.5 + 0.5 * intensity), ref, max },
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
  applyAudioSettings();
};
document
  .querySelectorAll("[data-screen]")
  .forEach((b) => (b.onclick = () => show(b.dataset.screen)));
document.querySelectorAll(".back").forEach(
  (b) =>
    (b.onclick = () => {
      saveSettings();
      show(
        settingsReturnScreen === "lobby" &&
          socket?.readyState === WebSocket.OPEN
          ? "lobby"
          : "menu",
      );
    }),
);
const settingsBindings = {
  sensitivity: {
    main: "sensitivity",
    pause: "pauseSensitivity",
    mainLabel: "sensVal",
    pauseLabel: "pauseSensVal",
    suffix: "",
  },
  masterVolume: {
    main: "masterVolume",
    pause: "pauseMasterVolume",
    mainLabel: "masterVal",
    pauseLabel: "pauseMasterVal",
    suffix: "%",
  },
  sfx: {
    main: "sfx",
    pause: "pauseSfx",
    mainLabel: "sfxVal",
    pauseLabel: "pauseSfxVal",
    suffix: "%",
  },
  music: {
    main: "music",
    pause: "pauseMusic",
    mainLabel: "musicVal",
    pauseLabel: "pauseMusicVal",
    suffix: "%",
  },
  quality: { main: "quality", pause: "pauseQuality" },
};
function syncSettingControl(key, value) {
  const binding = settingsBindings[key];
  if (!binding) return;
  for (const id of [binding.main, binding.pause]) {
    const input = document.getElementById(id);
    if (input) input.value = value;
  }
  if (binding.suffix !== undefined) {
    for (const id of [binding.mainLabel, binding.pauseLabel]) {
      const label = document.getElementById(id);
      if (label) label.textContent = String(value) + binding.suffix;
    }
  }
}
function syncPauseSettings() {
  for (const key of Object.keys(settingsBindings)) {
    const input = document.getElementById(settingsBindings[key].main);
    if (input) syncSettingControl(key, input.value);
  }
}
function saveSettings() {
  localStorage.setItem(
    "ld-settings",
    JSON.stringify({
      sensitivity: $("#sensitivity").value,
      masterVolume: $("#masterVolume").value,
      sfx: $("#sfx").value,
      music: $("#music").value,
      quality: $("#quality").value,
    }),
  );
}
function onSettingInput(key, value) {
  syncSettingControl(key, value);
  saveSettings();
  if (key === "quality") applyGraphicsSettings();
  if (["masterVolume", "sfx", "music"].includes(key)) applyAudioSettings();
}
for (const [key, binding] of Object.entries(settingsBindings)) {
  for (const id of [binding.main, binding.pause]) {
    document
      .getElementById(id)
      ?.addEventListener("input", (event) =>
        onSettingInput(key, event.currentTarget.value),
      );
    document
      .getElementById(id)
      ?.addEventListener("change", (event) =>
        onSettingInput(key, event.currentTarget.value),
      );
  }
}
$("#nameInput").addEventListener("input", () => {
  localStorage.setItem("ld-player-name", $("#nameInput").value.slice(0, 18));
});
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
  $("#mapCount").textContent = forest ? "01 / 02" : "02 / 02";
  $("#mapDescription").textContent = forest
    ? "CỎ XANH · HỒ · SÔNG · ĐỒI"
    : "SA MẠC · ĐÁ · XƯƠNG RỒNG";
  $("#mapArt").classList.toggle("forest-preview", forest);
  $("#mapArt").classList.toggle("desert-preview", !forest);
}
document.querySelectorAll("[data-map-choice]").forEach((button) => {
  button.addEventListener("click", () =>
    renderMapChoice(button.dataset.mapChoice),
  );
});
renderMapChoice(selectedMap);
function requireHomePlayerName() {
  const name = $("#nameInput").value.trim().slice(0, 18);
  if (!name) {
    alert("Nhập tên người chơi ngay trên màn Home trước khi vào phòng.");
    $("#nameInput").focus();
    return null;
  }
  $("#nameInput").value = name;
  localStorage.setItem("ld-player-name", name);
  return name;
}
$("#createBtn").onclick = () => {
  if (!requireHomePlayerName()) return;
  connect({ type: "create", mapId: selectedMap });
};
$("#joinBtn").onclick = () => {
  if (!requireHomePlayerName()) return;
  const code = $("#codeInput").value.trim();
  if (!/^\d{6}$/.test(code)) {
    alert("Nhập mã phòng gồm 6 chữ số.");
    return;
  }
  connect({ type: "join", code });
};
function connect(message) {
  if (socket) socket.close();
  serverOffsetReady = false;
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
      mapId = m.mapId === "desert" ? "desert" : "forest";
      mapObstacles = m.obstacles || [];
      mapHills = mapObstacles.filter((obstacle) => obstacle.type === "hill");
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
    if (m.type === "lootAdded" && m.item) addLootItem(m.item);
    if (m.type === "toast") showLootToast(m.text);
    if (m.type === "horn" && m.senderId !== playerId)
      playCarHorn({ x: m.x, y: m.y, z: m.z });
    // Server sửa lại chỗ tiếp đất (ví dụ trúng cây / đá).
    if (m.type === "landed" && local.state === "ground") {
      local.x = m.x;
      local.z = m.z;
      local.groundY = Number(m.groundY) || 0;
    }
    if (m.type === "state") {
      gameState = m;
      syncLootCrates(m.crates || []);
      // Đồng bộ đồng hồ với server để máy bay / đếm ngược khớp giữa các máy.
      const offset = m.now - Date.now();
      serverOffset = serverOffsetReady
        ? serverOffset + (offset - serverOffset) * 0.1
        : offset;
      serverOffsetReady = true;
      plane = m.plane || null;
      countdownEndsAt = m.countdownEndsAt || 0;
      matchPhase = m.phase;
      if (m.mapId) {
        mapId = m.mapId;
        renderMapChoice(mapId);
      }
      if (
        typeof m.weatherActive === "boolean" &&
        m.weatherActive !== weatherActive
      ) {
        weatherActive = m.weatherActive;
        const forest = mapId === "forest";
        if (weatherActive) beginWeather(forest);
        else endWeather(forest);
      }
      renderLobby();
      // staging: vào map chờ · countdown: đếm ngược · plane: trên máy bay · playing: đã nhảy hết
      if (["staging", "countdown", "plane", "playing"].includes(m.phase)) {
        if (!inMatch) beginGame();
        renderPlayers(m);
        if (!readySent) {
          readySent = true; // báo server: đã dựng xong map trong phòng chờ
          send({ type: "ready" });
        }
      }
      if (m.phase === "finished") {
        // Ngừng hẳn động cơ kể cả khi bảng kết quả đã được mở sẵn.
        stopVehicleEngineAudio();
        stopVehicleFireAudio();
      }
      if (
        m.phase === "finished" &&
        !$("#result").classList.contains("active")
      ) {
        if (!inMatch) beginGame();
        renderPlayers(m);
        if (local.hp <= 0) beginDeathView(local);
        else showResult();
      }
    }
  };
  socket.onclose = () => {
    $("#status").textContent = "● ONLINE";
  };
}
function send(data) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
    return true;
  }
  if (data.type === "dropItem" || data.type === "transferCrate")
    showLootToast("MẤT KẾT NỐI VỚI SERVER");
  return false;
}
function renderLobby() {
  if (!gameState) return;
  isHost = gameState.hostId === playerId;
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
  $("#leaveLobbyBtn")?.classList.remove("hidden");
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
$("#leaveLobbyBtn").onclick = () => {
  // Closing the room socket makes the server remove this player from the team.
  if (socket) socket.close();
  socket = null;
  roomCode = "";
  playerId = "";
  gameState = null;
  isHost = false;
  $("#roomCode").textContent = "------";
  $("#status").textContent = "● ONLINE";
  show("menu");
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
function updateAmmoHud() {
  const capacity = local.weapon === "sniper" ? 5 : 30;
  const reserve = local.reserveAmmo ?? 90;
  const hud = $("#ammo");
  if (hud) hud.innerHTML = `${ammo} <i>/ ${capacity} · DỰ TRỮ ${reserve}</i>`;
}
function terrainHeightForHill(hill, x, z) {
  const radiusX = hill.w / 2;
  const radiusZ = (hill.length || hill.w) / 2;
  const d2 = ((x - hill.x) / radiusX) ** 2 + ((z - hill.z) / radiusZ) ** 2;
  return d2 >= 1 ? 0 : hill.h * Math.pow(1 - d2, 1.4);
}
function groundHeightAt(x, z) {
  let height = 0;
  for (const hill of mapHills)
    height = Math.max(height, terrainHeightForHill(hill, x, z));
  if (isOnBridgeAt(x, z, 0.2)) height = Math.max(height, 0.3);
  return height;
}
function isOnBridgeAt(x, z, clearance = 0) {
  return mapObstacles.some((road) => {
    if (road.type !== "road" || !road.bridge) return false;
    const dx = (Math.sin(road.yaw || 0) * road.length) / 2;
    const dz = (Math.cos(road.yaw || 0) * road.length) / 2;
    const ax = road.x - dx,
      az = road.z - dz;
    const bx = road.x + dx,
      bz = road.z + dz;
    const vx = bx - ax,
      vz = bz - az;
    const t = Math.max(
      0,
      Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz)),
    );
    return (
      Math.hypot(x - (ax + t * vx), z - (az + t * vz)) <= road.w / 2 + clearance
    );
  });
}
// Return the walkable top of a roof or large rock, if the point is on it.
function raisedSurfaceAt(x, z) {
  let best = null;
  for (const o of mapObstacles) {
    const base = groundHeightAt(o.x, o.z);
    if (o.type === "house" || o.type === "hut") {
      const dx = x - o.x,
        dz = z - o.z;
      const c = Math.cos(o.yaw || 0),
        s = Math.sin(o.yaw || 0);
      const lx = c * dx - s * dz,
        lz = s * dx + c * dz;
      // Vùng "trên mái" phải rộng bằng hoặc hơn vùng va chạm của tường nhà
      // (blockedByBuilding dùng half + obstacleRadius) — nếu không sẽ có một
      // dải hẹp nơi người chơi vừa rời mái (mất độ cao) nhưng vẫn còn nằm
      // trong vùng chặn của tường -> bị kẹt cứng ở mép mái.
      const halfX = Math.max(o.w * 0.53, o.w / 2 + 0.6);
      const halfZ = o.w / 2 + 0.6;
      if (Math.abs(lx) > halfX || Math.abs(lz) > halfZ) continue;
      const wallH = o.h * 0.72;
      const height =
        base +
        wallH +
        o.w * 0.16 +
        0.12 * Math.cos(0.48) +
        (o.w * 0.245 - Math.abs(lx)) * Math.sin(0.48);
      if (!best || height > best.height)
        best = { height, base, type: "roof", obstacle: o };
    } else if (o.type === "rock") {
      const dx = x - o.x,
        dz = z - o.z;
      const dist = Math.hypot(dx, dz);
      // Tương tự: vùng "trên đá" phải rộng bằng hoặc hơn bán kính va chạm
      // (o.w * 0.46) của chính khối đá đó, để tránh dải kẹt ở mép đá.
      const topRadius = o.w * 0.46 + 0.6;
      if (dist > topRadius) continue;
      const nx = dx / (o.w * 0.48),
        nz = dz / (o.w * 0.4);
      const r2 = Math.min(1, nx * nx + nz * nz);
      const height = base + o.h * (0.42 + 0.5 * Math.sqrt(1 - r2));
      if (!best || height > best.height)
        best = { height, base, type: "rock", obstacle: o };
    }
  }
  return best;
}
// During descent, only land on raised geometry if the player came down onto it.
function landingHeightAt(x, z, previousY) {
  const terrain = groundHeightAt(x, z);
  const raised = raisedSurfaceAt(x, z);
  return raised && previousY >= raised.height - 0.25
    ? Math.max(terrain, raised.height)
    : terrain;
}
// Preserve an elevated support while the player walks across its top surface.
function standingHeightAt(x, z, previousGroundY) {
  const terrain = groundHeightAt(x, z);
  const raised = raisedSurfaceAt(x, z);
  return raised && previousGroundY > raised.base + 0.55
    ? Math.max(terrain, raised.height)
    : terrain;
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
    if (inside) {
      // The rendered bridge deck is dry and walkable, not river water.
      if (isOnBridgeAt(x, z, 0.8)) continue;
      return { surfaceY: 0.08, depth: water.depth || 4 };
    }
  }
  return null;
}
function createGroundMesh(forest) {
  const size = MAP_HALF * 2 + 20;
  const segments = forest ? 320 : 1;
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
    case "road": {
      // Roads are rendered as flat surfaces and have no collision volume.
      const road = new THREE.Group();
      road.position.set(o.x, 0.095, o.z);
      road.rotation.y = o.yaw || 0;
      const deckY = o.bridge ? 0.205 : 0;
      const surface = (width, height, color, y) => {
        const geometry = new THREE.PlaneGeometry(width, height);
        geometry.rotateX(-Math.PI / 2);
        const mesh = new THREE.Mesh(geometry, makeMat(color));
        mesh.position.y = y;
        road.add(mesh);
      };
      surface(o.w + 2.2, o.length, forest ? "#827d68" : "#8d8068", deckY);
      surface(o.w, o.length, forest ? "#514f47" : "#5e594f", deckY + 0.012);
      if (o.bridge) {
        const rail = makeMat("#685d49");
        for (const side of [-1, 1]) {
          const beam = new THREE.Mesh(
            new THREE.BoxGeometry(0.22, 0.78, o.length),
            rail,
          );
          beam.position.set(side * (o.w / 2 - 0.15), deckY + 0.43, 0);
          road.add(beam);
          for (let z = -o.length / 2 + 1; z < o.length / 2; z += 3) {
            const post = new THREE.Mesh(
              new THREE.BoxGeometry(0.25, 0.82, 0.25),
              rail,
            );
            post.position.set(side * (o.w / 2 - 0.15), deckY + 0.43, z);
            road.add(post);
          }
        }
      }
      // Short center dashes repeat over each segment, leaving the edges clear.
      for (let z = -o.length / 2 + 1; z < o.length / 2 - 0.5; z += 3.2) {
        const dash = new THREE.Mesh(
          new THREE.PlaneGeometry(0.16, 1.7).rotateX(-Math.PI / 2),
          makeMat("#d9d0a8"),
        );
        dash.position.set(0, deckY + 0.026, z);
        road.add(dash);
      }
      scene.add(road);
      break;
    }
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
      const depth = o.length || w;
      const positions = [];
      const colors = [];
      const indices = [];
      const color = new THREE.Color();
      for (let iz = 0; iz <= divisions; iz++) {
        const z = (iz / divisions - 0.5) * depth;
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
    38400,
  );
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  let count = 0;
  for (let i = 0; i < 38400; i++) {
    const x = (rand() - 0.5) * (MAP_HALF * 2 - 4);
    const z = (rand() - 0.5) * (MAP_HALF * 2 - 4);
    if (isNearRoad(x, z, 1.25)) continue;
    if (Math.hypot(x, z - 8) < 10 || Math.hypot(x, z + 8) < 9) continue;
    const streamZ =
      (-7 + Math.sin((x + 12 * MAP_SCALE) / (13 * MAP_SCALE)) * 13) * MAP_SCALE;
    if (
      Math.abs(z - streamZ) < 3.1 * MAP_SCALE ||
      Math.hypot(x - 22 * MAP_SCALE, z + 3 * MAP_SCALE) < 12 * MAP_SCALE
    )
      continue;
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
// Match the road clearance used by server-side obstacle and loot placement.
function isNearRoad(x, z, clearance = 0) {
  return mapObstacles.some((road) => {
    if (road.type !== "road") return false;
    const dx = (Math.sin(road.yaw || 0) * road.length) / 2;
    const dz = (Math.cos(road.yaw || 0) * road.length) / 2;
    const ax = road.x - dx,
      az = road.z - dz;
    const bx = road.x + dx,
      bz = road.z + dz;
    const vx = bx - ax,
      vz = bz - az;
    const t = Math.max(
      0,
      Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz)),
    );
    return (
      Math.hypot(x - (ax + t * vx), z - (az + t * vz)) < road.w / 2 + clearance
    );
  });
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
  if (
    x < -MAP_HALF + 1 ||
    x > MAP_HALF - 1 ||
    z < -MAP_HALF + 1 ||
    z > MAP_HALF - 1
  )
    return true;
  const selfRadius = local.prone ? 1.15 : PLAYER_RADIUS;
  const obstacleRadius = local.prone ? 0.55 : PLAYER_RADIUS;
  // Dùng vị trí HIỆN TẠI (không phải điểm sắp tới) để biết người chơi đang
  // đứng trên mái nhà/đá nào — nhờ vậy khi bước qua mép để đi xuống, họ
  // không bị chặn lại như thể đang đi xuyên tường/đá từ bên ngoài.
  const support =
    local.groundY > 0.45 ? raisedSurfaceAt(local.x, local.z) : null;
  for (const o of mapObstacles) {
    if (o.solid === false) continue;
    if (o.type === "house" || o.type === "hut") {
      const isAboveThisRoof =
        local.groundY > groundHeightAt(o.x, o.z) + o.h * 0.72 + 0.1 &&
        support?.type === "roof" &&
        support.obstacle === o;
      if (isAboveThisRoof) continue;
      if (blockedByBuilding(o, x, z, obstacleRadius)) return true;
      continue;
    }
    const footprint = obstacleFootprintRadius(o);
    if (footprint !== null) {
      const rockTop =
        support?.type === "rock" &&
        support.obstacle === o &&
        // Rock collision is suspended while leaving its upper surface. The
        // visible crown falls to ~42% of rock height at the rim, so using a
        // higher threshold traps players against the side during the step down.
        local.groundY > support.base + o.h * 0.35;
      if (rockTop) continue;
      if (Math.hypot(x - o.x, z - o.z) < footprint + obstacleRadius)
        return true;
      continue;
    }
    const closestX = Math.max(o.x - o.w / 2, Math.min(x, o.x + o.w / 2));
    const closestZ = Math.max(o.z - o.w / 2, Math.min(z, o.z + o.w / 2));
    if (Math.hypot(x - closestX, z - closestZ) < obstacleRadius) return true;
  }
  for (const p of gameState?.players || []) {
    if (
      p.id === playerId ||
      !p.alive ||
      !(p.state === "ground" || p.state === "lobby")
    )
      continue;
    const otherRadius = p.prone ? 1.15 : PLAYER_RADIUS;
    if (Math.hypot(x - p.x, z - p.z) < selfRadius + otherRadius + 0.02)
      return true;
  }
  for (const vehicle of gameState?.vehicles || []) {
    const dx = x - vehicle.x,
      dz = z - vehicle.z;
    const c = Math.cos(vehicle.yaw),
      s = Math.sin(vehicle.yaw);
    if (
      Math.abs(c * dx - s * dz) < 1.03 + obstacleRadius &&
      Math.abs(s * dx + c * dz) < 1.84 + obstacleRadius
    )
      return true;
  }
  return false;
}

// Rừng khô hoàn toàn không có sương mù; khi mưa mới dùng lớp sương nhìn gần.
// Sa mạc vẫn có tầm nhìn xa khi trời quang và bị che mạnh trong bão cát.
// Trời quang: giữ vùng chơi rõ, làm mờ dần phần nền ngoài rìa map.
const FOG_CLEAR = { forest: [140, 360], desert: [140, 360] };
const FOG_STORM = { forest: [32, 125], desert: [8, 40] };
let fogBaseNear = 32,
  fogBaseFar = 125;
function applyBaseFog(forest, stormy) {
  const [near, far] = (stormy ? FOG_STORM : FOG_CLEAR)[
    forest ? "forest" : "desert"
  ];
  fogBaseNear = near;
  fogBaseFar = far;
  if (scene?.fog) {
    scene.fog.near = near;
    scene.fog.far = far;
  }
}

function buildCarMesh(vehicle, forest) {
  const root = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({
    color: vehicle.color || (forest ? "#426846" : "#a4763e"),
    roughness: 0.62,
    metalness: 0.22,
  });
  const trim = makeMat("#252923"),
    glass = new THREE.MeshStandardMaterial({
      color: "#9fc4c3",
      transparent: true,
      opacity: 0.38,
      roughness: 0.16,
    });
  const wheelMat = makeMat("#171916"),
    lampMat = new THREE.MeshBasicMaterial({ color: 0xffe2a1 });
  const addBox = (w, h, l, x, y, z, material, parent = root) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };
  addBox(1.72, 0.43, 3.25, 0, 0.53, 0, paint);
  addBox(1.56, 0.33, 1.08, 0, 0.78, -1.02, paint); // hood
  addBox(1.48, 0.27, 0.62, 0, 0.66, 1.25, paint); // trunk
  addBox(1.48, 0.12, 0.16, 0, 0.93, -0.35, trim); // windshield base
  const windshield = new THREE.Mesh(new THREE.PlaneGeometry(1.38, 0.44), glass);
  windshield.position.set(0, 1.02, -0.48);
  windshield.rotation.x = -0.22;
  windshield.rotation.y = Math.PI;
  root.add(windshield);
  // Open cabin keeps both seated players visible and targetable.
  for (const side of [-1, 1]) {
    addBox(0.14, 0.34, 1.42, side * 0.84, 0.63, 0.05, paint);
    const wheel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.32, 0.2, 12),
      wheelMat,
    );
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(side * 0.91, 0.34, -1.08);
    root.add(wheel);
    const rearWheel = wheel.clone();
    rearWheel.position.z = 1.08;
    root.add(rearWheel);
  }
  for (const x of [-0.45, 0.45]) {
    addBox(0.72, 0.18, 0.72, x, 0.5, 0.2, trim);
    addBox(0.72, 0.5, 0.13, x, 0.83, 0.47, trim);
  }
  addBox(1.35, 0.09, 0.12, 0, 0.9, -1.58, trim);
  for (const x of [-0.58, 0.58])
    addBox(0.28, 0.14, 0.06, x, 0.78, -1.58, lampMat);
  const steering = new THREE.Mesh(
    new THREE.TorusGeometry(0.22, 0.035, 8, 20),
    trim,
  );
  steering.position.set(-0.43, 1.03, -0.26);
  steering.rotation.y = Math.PI;
  root.add(steering);
  const smokeGroup = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const puff = new THREE.Mesh(
      new THREE.SphereGeometry(0.28 + i * 0.055, 8, 7),
      new THREE.MeshBasicMaterial({
        color: 0x343832,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
      }),
    );
    puff.position.set(
      (i % 2) * 0.2 - 0.1,
      1.2 + i * 0.34,
      -0.82 + (i % 2) * 0.2,
    );
    smokeGroup.add(puff);
  }
  root.add(smokeGroup);
  const fireGroup = new THREE.Group();
  for (let i = 0; i < 7; i++) {
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.22 + (i % 3) * 0.04, 0.75 + (i % 2) * 0.22, 6),
      new THREE.MeshBasicMaterial({
        color: i % 2 ? 0xff6b18 : 0xffca45,
        transparent: true,
        opacity: 0.9,
      }),
    );
    flame.position.set(
      Math.sin(i * 2.4) * 0.58,
      0.86,
      Math.cos(i * 2.4) * 1.12,
    );
    fireGroup.add(flame);
  }
  root.add(fireGroup);
  const explosion = new THREE.Mesh(
    new THREE.SphereGeometry(1, 10, 8),
    new THREE.MeshBasicMaterial({
      color: 0xff8c26,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    }),
  );
  explosion.visible = false;
  root.add(explosion);
  root.userData = {
    paint,
    smokeGroup,
    fireGroup,
    steering,
    explosion,
    explosionUntil: 0,
    destroyed: false,
    smoke: 0,
  };
  root.position.set(
    vehicle.x,
    groundHeightAt(vehicle.x, vehicle.z) - (vehicle.sinkDepth || 0),
    vehicle.z,
  );
  root.rotation.y = vehicle.yaw;
  smokeGroup.visible = Boolean(vehicle.smoke);
  fireGroup.visible = Boolean(vehicle.destroyed);
  root.userData.destroyed = Boolean(vehicle.destroyed);
  root.userData.smoke = vehicle.smoke || 0;
  return root;
}
function updateVehicleMeshes(dt) {
  const vehicles = gameState?.vehicles || [];
  const liveIds = new Set();
  for (const vehicle of vehicles) {
    liveIds.add(vehicle.id);
    let mesh = vehicleMeshes.get(vehicle.id);
    if (!mesh) {
      mesh = buildCarMesh(vehicle, mapId === "forest");
      scene.add(mesh);
      vehicleMeshes.set(vehicle.id, mesh);
    }
    const targetY =
      groundHeightAt(vehicle.x, vehicle.z) - (vehicle.sinkDepth || 0);
    mesh.position.x += (vehicle.x - mesh.position.x) * Math.min(12 * dt, 1);
    mesh.position.z += (vehicle.z - mesh.position.z) * Math.min(12 * dt, 1);
    mesh.position.y += (targetY - mesh.position.y) * Math.min(12 * dt, 1);
    const yawDelta = Math.atan2(
      Math.sin(vehicle.yaw - mesh.rotation.y),
      Math.cos(vehicle.yaw - mesh.rotation.y),
    );
    mesh.rotation.y += yawDelta * Math.min(12 * dt, 1);
    const ud = mesh.userData;
    ud.steering.rotation.z =
      local.vehicleId === vehicle.id && local.vehicleSeat === 0
        ? keys.KeyA
          ? 0.42
          : keys.KeyD
            ? -0.42
            : 0
        : 0;
    ud.smokeGroup.visible = !vehicle.destroyed && vehicle.smoke > 0;
    ud.fireGroup.visible = Boolean(vehicle.destroyed);
    if (vehicle.smoke > (ud.smoke || 0)) playVehicleSmokeAudio(vehicle);
    if (vehicle.destroyed && !ud.destroyed) {
      ud.destroyed = true;
      ud.paint.color.set("#242521");
      ud.explosionUntil = performance.now() + 850;
      ud.fireAudioAt = performance.now() + 850;
      playVehicleExplosionAudio(vehicle);
    }
    if (vehicle.destroyed && performance.now() >= (ud.fireAudioAt || 0))
      updateVehicleFireAudio(vehicle, targetY);
    const explosionLeft = ud.explosionUntil - performance.now();
    ud.explosion.visible = explosionLeft > 0;
    if (ud.explosion.visible) {
      const pulse = 1 + ((850 - explosionLeft) / 850) * 3.5;
      ud.explosion.scale.setScalar(pulse);
      ud.explosion.material.opacity = Math.max(0, (explosionLeft / 850) * 0.82);
    }
    ud.smoke = vehicle.smoke || 0;
    ud.smokeGroup.children.forEach((puff, i) => {
      puff.visible = vehicle.smoke > 0;
      puff.material.opacity = vehicle.smoke >= 2 ? 0.72 : 0.32;
      if (vehicle.smoke)
        puff.position.y =
          1.05 + i * 0.42 + Math.sin(performance.now() / 280 + i) * 0.12;
    });
    ud.fireGroup.children.forEach((flame, i) => {
      const pulse = 0.82 + 0.18 * Math.sin(performance.now() / 95 + i * 1.8);
      flame.scale.set(pulse, pulse, pulse);
    });
    updateVehicleEngineAudio(vehicle, targetY);
  }
  for (const [id, mesh] of vehicleMeshes) {
    if (liveIds.has(id)) continue;
    scene.remove(mesh);
    vehicleMeshes.delete(id);
  }
  updateLocalVehicleView();
}
function updateLocalVehicleView() {
  const vehicle = gameState?.vehicles?.find((v) => v.id === local.vehicleId);
  const hud = $("#vehicleHud");
  if (!vehicle) {
    hud?.classList.add("hidden");
    if (gun)
      gun.visible =
        !deathView &&
        local.state === "ground" &&
        (!scoped || local.weapon !== "sniper");
    if (steeringWheel) steeringWheel.visible = false;
    return;
  }
  const carMesh = vehicleMeshes.get(vehicle.id);
  const yaw = carMesh?.rotation.y ?? vehicle.yaw;
  const carX = carMesh?.position.x ?? vehicle.x;
  const carZ = carMesh?.position.z ?? vehicle.z;
  const seatX = local.vehicleSeat === 0 ? -0.43 : 0.43;
  const seatZ = 0.18;
  const x = carX + Math.cos(yaw) * seatX + Math.sin(yaw) * seatZ;
  const z = carZ - Math.sin(yaw) * seatX + Math.cos(yaw) * seatZ;
  local.x = x;
  local.z = z;
  local.groundY = carMesh?.position.y ?? groundHeightAt(vehicle.x, vehicle.z);
  camera.position.set(
    x,
    local.groundY + (local.vehicleSeat === 0 ? 1.32 : 1.28),
    z,
  );
  if (local.vehicleSeat === 0) local.yaw = yaw;
  camera.rotation.order = "YXZ";
  camera.rotation.y = local.yaw;
  if (local.vehicleSeat === 0) camera.rotation.x = 0;
  if (gun) gun.visible = false;
  if (steeringWheel) steeringWheel.visible = local.vehicleSeat === 0;
  if (hud) {
    hud.classList.remove("hidden");
    $("#vehicleSpeed").textContent = String(
      Math.round(Math.abs(vehicle.speed) * 3.6),
    );
    $("#vehicleHP").textContent = vehicle.submerged
      ? "XE CHÌM · ĐỘNG CƠ ĐÃ TẮT"
      : vehicle.destroyed
        ? "XE ĐÃ NỔ · CỐ ĐỊNH"
        : `XE ${Math.round(vehicle.hp)}/60 HP${vehicle.smoke >= 2 ? " · KHÓI DÀY" : vehicle.smoke ? " · ĐANG BỐC KHÓI" : ""}`;
    $("#vehicleStatus").textContent = vehicle.submerged
      ? "XE CHÌM · ĐỘNG CƠ ĐÃ TẮT"
      : vehicle.destroyed
        ? "XE ĐÃ CHÁY"
        : local.vehicleSeat === 0
          ? "TÀI XẾ · CLICK BÓP KÈN"
          : "HÀNH KHÁCH · F ĐỂ XUỐNG";
    $("#vehicleHud").classList.toggle("vehicle-damaged", vehicle.smoke > 0);
  }
}
function initWorld() {
  const host = $("#world");
  host.innerHTML = "";
  vehicleMeshes.clear();
  const forest = mapId === "forest";
  scene = new THREE.Scene();
  scene.background = new THREE.Color(forest ? "#879c88" : "#ad9367");
  scene.fog = new THREE.Fog(forest ? "#879c88" : "#ad9367", 1, 1);
  applyBaseFog(forest, false); // vào map luôn trời quang trước
  baseFov = 76;
  const viewport = host.getBoundingClientRect();
  camera = new THREE.PerspectiveCamera(
    baseFov,
    viewport.width / viewport.height,
    0.1,
    360,
  );
  camera.position.set(
    local.x,
    1.65 + groundHeightAt(local.x, local.z),
    local.z,
  );
  camera.rotation.order = "YXZ";
  camera.rotation.y = local.yaw;
  renderer = new THREE.WebGLRenderer({
    antialias: $("#quality").value === "High",
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(graphicsPixelRatio());
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

  if (!mapObstacles.length) {
    mapObstacles = gameState?.obstacles || [];
    mapHills = mapObstacles.filter((obstacle) => obstacle.type === "hill");
  }
  createGroundMesh(forest);
  addOutskirts(forest);
  addZoneBorder();
  addSafeZoneWall();
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
  const magazine = new THREE.Mesh(
    new THREE.BoxGeometry(0.09, 0.2, 0.12),
    makeMat("#45483f"),
  );
  magazine.position.set(0.28, -0.36, -0.55);
  gun.add(magazine);
  const rangerParts = [body, barrel, stock, magazine];
  // Open holographic sight on the Ranger-9 (clearly visible in first person).
  const sightBase = new THREE.Mesh(
    new THREE.BoxGeometry(0.13, 0.045, 0.18),
    makeMat("#161a16"),
  );
  sightBase.position.set(0.28, -0.145, -0.56);
  gun.add(sightBase);
  const holoFrame = new THREE.Mesh(
    new THREE.TorusGeometry(0.095, 0.012, 7, 24),
    makeMat("#111511"),
  );
  holoFrame.position.set(0.28, -0.075, -0.59);
  gun.add(holoFrame);
  const holoLens = new THREE.Mesh(
    new THREE.CircleGeometry(0.078, 20),
    new THREE.MeshBasicMaterial({
      color: 0x82abb0,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
    }),
  );
  holoLens.position.set(0.28, -0.075, -0.594);
  gun.add(holoLens);
  const holoDot = new THREE.Mesh(
    new THREE.SphereGeometry(0.0022, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff2929, toneMapped: false }),
  );
  holoDot.position.set(0.28, -0.075, -0.61);
  gun.add(holoDot);
  rangerParts.push(sightBase, holoFrame, holoLens, holoDot);
  const sniper = new THREE.Group();
  const sniperBody = new THREE.Mesh(
    new THREE.BoxGeometry(0.15, 0.15, 0.82),
    makeMat("#30332d"),
  );
  sniperBody.position.set(0.28, -0.24, -0.62);
  sniper.add(sniperBody);
  const sniperBarrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.03, 0.88, 8),
    makeMat("#171a16"),
  );
  sniperBarrel.rotation.x = Math.PI / 2;
  sniperBarrel.position.set(0.28, -0.2, -1.38);
  sniper.add(sniperBarrel);
  const sniperStock = new THREE.Mesh(
    new THREE.BoxGeometry(0.13, 0.17, 0.36),
    makeMat("#645a43"),
  );
  sniperStock.position.set(0.28, -0.25, -0.12);
  sniper.add(sniperStock);
  const sniperMag = new THREE.Mesh(
    new THREE.BoxGeometry(0.085, 0.19, 0.12),
    makeMat("#45483f"),
  );
  sniperMag.position.set(0.28, -0.36, -0.58);
  sniper.add(sniperMag);
  const scopeTube = new THREE.Mesh(
    new THREE.CylinderGeometry(0.075, 0.075, 0.42, 10),
    makeMat("#10130f"),
  );
  scopeTube.rotation.x = Math.PI / 2;
  scopeTube.position.set(0.28, -0.105, -0.66);
  sniper.add(scopeTube);
  for (const z of [-0.88, -0.44]) {
    const lens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.09, 0.055, 10),
      makeMat("#56727a"),
    );
    lens.rotation.x = Math.PI / 2;
    lens.position.set(0.28, -0.105, z);
    sniper.add(lens);
  }
  sniper.visible = false;
  gun.add(sniper);
  gun.userData.magazine = magazine;
  gun.userData.magazines = { ranger: magazine, sniper: sniperMag };
  gun.userData.rangerParts = rangerParts;
  gun.userData.sniper = sniper;
  gun.visible = false; // phòng chờ / máy bay / đang nhảy dù: tay không, chỉ cầm súng sau khi tiếp đất
  camera.add(gun);
  steeringWheel = new THREE.Group();
  const wheelMesh = new THREE.Mesh(
    new THREE.TorusGeometry(0.26, 0.026, 8, 24),
    makeMat("#20231e"),
  );
  wheelMesh.position.set(0, -0.42, -0.72);
  steeringWheel.add(wheelMesh);
  const wheelHub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 0.12, 8),
    makeMat("#77796d"),
  );
  wheelHub.rotation.x = Math.PI / 2;
  wheelHub.position.set(0, -0.42, -0.72);
  steeringWheel.add(wheelHub);
  for (const side of [-1, 1]) {
    const hand = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 8, 7),
      makeMat("#343830"),
    );
    hand.position.set(side * 0.22, -0.39, -0.7);
    steeringWheel.add(hand);
  }
  steeringWheel.visible = false;
  camera.add(steeringWheel);
  scene.add(camera);
  weatherActive = false; // vào map trời quang; server sẽ báo khi nào thời tiết thật sự bắt đầu
  planeObject = buildPlane();
  planeObject.visible = false;
  scene.add(planeObject);
  planeCloudField = buildPlaneCloudField();
  scene.add(planeCloudField);
  for (const item of lootItems.values()) {
    item.mesh = null;
    addLootMesh(item);
  }
  for (const crate of lootCrates.values()) {
    crate.mesh = null;
    addCrateMesh(crate);
  }
  for (const vehicle of gameState?.vehicles || []) {
    const mesh = buildCarMesh(vehicle, forest);
    scene.add(mesh);
    vehicleMeshes.set(vehicle.id, mesh);
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
function graphicsPixelRatio() {
  const caps = { Performance: 0.85, Balanced: 1.25, High: 1.75 };
  return Math.min(devicePixelRatio || 1, caps[$("#quality").value] || 1.25);
}
function applyGraphicsSettings() {
  if (!renderer) return;
  renderer.setPixelRatio(graphicsPixelRatio());
  const viewport = $("#world").getBoundingClientRect();
  renderer.setSize(viewport.width, viewport.height);
  renderer.domElement.style.imageRendering =
    $("#quality").value === "Performance" ? "pixelated" : "auto";
}

const remoteMeshes = new Map();
// Đầu mèo 3D dùng chung cho mọi nhân vật: 1 ảnh cho mỗi mặt (trước/sau/2 bên/trên/dưới)
// cắt ra từ đúng ảnh mèo người dùng gửi, để nhìn góc nào cũng ra hình con mèo đó
// chứ không phải một mặt phẳng dán phía trước.
const catHeadLoader = new THREE.TextureLoader();
const loadHeadTex = (name) => {
  const tex = catHeadLoader.load(`/cat-head-${name}.png`);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
};

// Tạo texture cho mặt bên phải
const sideRightTex = loadHeadTex("side");

// Tạo texture cho mặt bên trái và LẬT NGANG (Mirror)
const sideLeftTex = loadHeadTex("side").clone();
sideLeftTex.center.set(0.5, 0.5); // Đặt tâm xoay/lật vào giữa ảnh
sideLeftTex.repeat.x = -1; // Lật ngược chiều ngang (Horizontal Flip)
sideLeftTex.needsUpdate = true;

const topTex = loadHeadTex("top");
topTex.center.set(0.5, 0.5);
topTex.rotation = Math.PI; // Xoay 180° để mặt trước quay về phía trước

// Thứ tự material của THREE.BoxGeometry: [+X phải, -X trái, +Y trên, -Y dưới, +Z sau, -Z trước]
const catHeadMaterials = [
  new THREE.MeshStandardMaterial({ map: sideRightTex, roughness: 1 }), // +X: Bên phải
  new THREE.MeshStandardMaterial({ map: sideLeftTex, roughness: 1 }), // -X: Bên trái (đã lật)
  new THREE.MeshStandardMaterial({ map: topTex, roughness: 1 }),
  new THREE.MeshStandardMaterial({ map: loadHeadTex("bottom"), roughness: 1 }),
  new THREE.MeshStandardMaterial({
    map: loadHeadTex("back-zoom"),
    roughness: 1,
  }),
  new THREE.MeshStandardMaterial({
    map: loadHeadTex("face-zoom"),
    roughness: 1,
  }),
];
const catEarMat = makeMat("#8a8175");

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
function showDamageDirection(shooter) {
  let overlay = $("#damageDirection");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "damageDirection";
    overlay.className = "damage-direction";
    overlay.innerHTML = "<i></i>";
    $(".hud")?.append(overlay);
  }
  let bearing = 0;
  if (shooter) {
    const dx = shooter.x - local.x;
    const dz = shooter.z - local.z;
    bearing = Math.atan2(dx, -dz) - local.yaw;
  }
  overlay.style.setProperty("--damage-bearing", `${bearing}rad`);
  overlay.classList.remove("show");
  // Restart the short animation when several bullets hit in quick succession.
  void overlay.offsetWidth;
  overlay.classList.add("show");
}
// Đặt avatar người khác theo trạng thái. Trên máy bay thì updateRemoteMotion() đặt theo
// chỗ ngồi mỗi khung hình; đang bay thì lướt mượt tới vị trí mới nhất.
function placeRemote(mesh, p) {
  const ud = mesh.userData;
  const st = p.state || "lobby";
  ud.seat = p.seat || 0;
  if (p.vehicleId) {
    mesh.rotation.set(0, p.yaw, 0);
    mesh.position.set(p.x, (p.groundY || 0) + 0.08, p.z);
    if (ud.torso) ud.torso.position.y = 0.95;
    if (ud.head) ud.head.position.y = 1.47;
    if (ud.legs) {
      ud.legs.position.set(0, 0.43, -0.1);
      ud.legs.rotation.x = -Math.PI / 2;
    }
    if (ud.armNear && ud.armFar) {
      if (p.vehicleSeat === 0) {
        ud.armNear.position.set(-0.43, 0.97, -0.24);
        ud.armFar.position.set(0.18, 0.97, -0.24);
        ud.armNear.rotation.x = ud.armFar.rotation.x = -0.55;
      } else {
        ud.armNear.position.set(-0.2, 0.74, 0.02);
        ud.armFar.position.set(0.2, 0.74, 0.02);
        ud.armNear.rotation.x = ud.armFar.rotation.x = 0.18;
      }
    }
    mesh.scale.set(1, 1, 1);
    return;
  }
  if (ud.torso) ud.torso.position.y = 1.05;
  if (ud.head) ud.head.position.y = 1.72;
  if (ud.legs) {
    ud.legs.position.set(0, 0, 0);
    ud.legs.rotation.x = 0;
  }
  if (ud.armNear && ud.armFar) {
    ud.armNear.position.set(0.29, 1.19, -0.2);
    ud.armFar.position.set(0.49, 1.16, -0.22);
    ud.armNear.rotation.x = ud.armFar.rotation.x = -0.22;
  }
  if (st === "plane") {
    ud.airTarget = null;
    ud.inAir = false;
    mesh.rotation.set(0, p.yaw, 0);
    mesh.scale.set(1, 1, 1);
    return;
  }
  if (st === "freefall" || st === "parachute") {
    const target = {
      x: p.x,
      y: (p.y ?? 0) + (st === "freefall" ? 0.5 : 0),
      z: p.z,
    };
    if (!ud.inAir) mesh.position.set(target.x, target.y, target.z);
    ud.inAir = true;
    ud.airTarget = target;
    // Rơi tự do: nằm sấp, đầu hướng về phía trước (như tư thế nhảy dù); dù bung: đứng thẳng.
    mesh.rotation.set(st === "freefall" ? -1.35 : 0, p.yaw, 0);
    mesh.scale.set(1, 1, 1);
    return;
  }
  ud.airTarget = null;
  ud.inAir = false;
  // Negative X rotation lays local +Y toward local -Z, matching the server's
  // prone hitbox centers (head forward, legs behind).
  const peekRoll = p.prone ? 0 : -(Number(p.peek) || 0) * 0.18;
  mesh.rotation.set(p.prone ? -Math.PI / 2 : 0, p.yaw, peekRoll);
  mesh.position.set(
    p.x,
    p.swimming
      ? p.swimY || 0
      : (p.groundY || 0) + (p.prone ? 0.35 : p.jumpY || 0),
    p.z,
  );
  mesh.scale.set(1, p.crouching && !p.prone ? 0.68 : 1, 1);
}
function beginDeathView(position = local) {
  if (deathView || !renderer) return;
  stopFiring();
  if (scoped) setScope(false);
  if (gun) gun.visible = false;
  deathView = {
    x: Number(position.x) || 0,
    y: Number(position.groundY) || 0,
    z: Number(position.z) || 0,
    startedAt: performance.now(),
  };
  // Mark deathcam before releasing pointer lock: its change event must not
  // be interpreted as the player opening the pause menu.
  document.exitPointerLock?.();
  // Lock the camera vertically above the elimination point for a fixed top-down view.
  camera.up.set(0, 0, -1);
  renderer.domElement.style.filter = "grayscale(1)";
  $("#deathViewOverlay")?.classList.remove("hidden");
  if (deathResultTimer) clearTimeout(deathResultTimer);
  // Give the eliminated player time to see the battlefield from above.
  deathResultTimer = setTimeout(() => {
    deathResultTimer = null;
    showResult();
  }, 10000);
}

function renderPlayers(state) {
  $("#aliveCount").textContent = state.alive;
  $("#totalCount").textContent = state.total;
  if (state.lastElimination && state.lastElimination.id !== lastEliminationId) {
    const event = state.lastElimination;
    lastEliminationId = event.id;
    const row = document.createElement("div");
    row.className = "kill-feed-row";
    row.textContent =
      event.killerName === "Nổ xe"
        ? `Nổ xe đã đưa ${event.victimName} đến một nơi tốt hơn`
        : `${event.killerName} đã chịch ${event.victimName} đến chết`;
    $("#killFeed")?.prepend(row);
    const timer = setTimeout(() => row.remove(), 20000);
    killFeedTimers.push(timer);
    if (event.victimId === playerId) {
      localEliminationMessage =
        event.killerName === "Nổ xe"
          ? `Nổ xe đã đưa ${event.victimName} đến một nơi tốt hơn.`
          : `Bạn đã bị chịch đến chết bởi ${event.killerName}.`;
      $("#resultDetail").textContent = localEliminationMessage;
    }
    if (event.killerId === playerId && event.killerName !== "Nổ xe") {
      const notice = $("#killNotice");
      if (notice) {
        notice.replaceChildren(document.createTextNode("Bạn "));
        const action = document.createElement("span");
        action.className = "kill-notice-action";
        action.textContent = "đã chịch";
        notice.append(
          action,
          document.createTextNode(` ${event.victimName} đến chết.`),
        );
        notice.classList.remove("hidden");
        setTimeout(() => notice.classList.add("hidden"), 10000);
      }
    }
  }
  const living = new Set();
  const nowMs = Date.now();
  for (const p of state.players) {
    if (p.id === playerId) {
      const weaponChanged = local.weapon !== (p.weapon || "ranger");
      local.weapon = p.weapon || "ranger";
      if (weaponChanged) updateLocalWeaponVisual();
      local.hp = Math.round(Number(p.hp) || 0);
      local.kills = p.kills;
      local.placement = p.placement || 0;
      local.groundY = Number(p.groundY) || 0;
      if (local.hp <= 0 && !deathView) beginDeathView(p);
      const previousVehicleId = local.vehicleId;
      local.vehicleId = p.vehicleId || null;
      local.vehicleSeat = Number.isInteger(p.vehicleSeat) ? p.vehicleSeat : -1;
      if (local.vehicleId && local.vehicleId !== previousVehicleId) {
        local.peek = 0;
        peekBlend = 0;
        keys.KeyQ = false;
        keys.KeyE = false;
        if (camera) camera.rotation.z = 0;
        const vehicle = gameState?.vehicles?.find(
          (v) => v.id === local.vehicleId,
        );
        local.yaw = vehicle?.yaw ?? p.yaw;
        localFootstepDistance = 0;
        stopFiring();
        if (scoped) setScope(false);
        if (steeringWheel) steeringWheel.visible = local.vehicleSeat === 0;
      } else if (!local.vehicleId && previousVehicleId) {
        // Snap to the server-confirmed exit point beside the occupied seat.
        local.x = p.x;
        local.z = p.z;
        local.yaw = p.yaw;
        localFootstepDistance = 0;
        if (steeringWheel) steeringWheel.visible = false;
      }
      const serverReloading = Boolean(p.reloading);
      ammo = Math.max(0, Number(p.ammo) || 0);
      local.reserveAmmo = p.reserveAmmo;
      local.medkits = p.medkits || 0;
      local.healing = Boolean(p.healing);
      local.healEndsAt = local.healing
        ? performance.now() + (p.healLeftMs || 0)
        : 0;
      if (backpackOpen) renderBackpack();
      const wasLocalReloading = local.reloading;
      local.reloading = Boolean(p.reloading);
      if (local.reloading && !wasLocalReloading) {
        local.reloadStartedAt = performance.now();
        startReloadSounds(null);
      }
      if (!local.reloading) local.reloadStartedAt = 0;
      updateAmmoHud();
      $("#feed").textContent = local.reloading ? "⟳ ĐANG NẠP ĐẠN · R" : "";
      const reloadHud = $("#reloadHud");
      if (reloadHud)
        reloadHud.style.display = local.reloading ? "flex" : "none";
      syncLocalState(p);
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
      const head = new THREE.Group();
      const headBox = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.48, 0.44),
        catHeadMaterials,
      );
      head.add(headBox);
      // Tai 3D (hình nón dẹt) để nhìn từ mọi góc — trước/sau/2 bên/trên — đều
      // thấy đúng dáng đầu mèo tai vểnh, không chỉ là ảnh phẳng ở mặt trước.
      const earGeo = new THREE.ConeGeometry(0.1, 0.2, 4);
      const earLeft = new THREE.Mesh(earGeo, catEarMat);
      earLeft.rotation.y = Math.PI / 4;
      earLeft.rotation.z = 0.32;
      earLeft.position.set(-0.17, 0.32, -0.02);
      head.add(earLeft);
      const earRight = new THREE.Mesh(earGeo, catEarMat);
      earRight.rotation.y = Math.PI / 4;
      earRight.rotation.z = -0.32;
      earRight.position.set(0.17, 0.32, -0.02);
      head.add(earRight);
      head.position.y = 1.72;
      // Cosmetic helmet, deliberately oversized to read clearly at game distance.
      const helmetMat = makeMat("#66734a");
      const helmet = new THREE.Group();
      const helmetDome = new THREE.Mesh(
        new THREE.SphereGeometry(0.34, 12, 8),
        helmetMat,
      );
      helmetDome.scale.y = 0.72;
      helmetDome.position.y = 0.24;
      helmet.add(helmetDome);
      const helmetBrim = new THREE.Mesh(
        new THREE.CylinderGeometry(0.37, 0.37, 0.07, 12),
        makeMat("#3f4b32"),
      );
      helmetBrim.position.y = 0.16;
      helmet.add(helmetBrim);
      const helmetStripe = new THREE.Mesh(
        new THREE.BoxGeometry(0.09, 0.035, 0.48),
        makeMat("#d6b34a"),
      );
      helmetStripe.position.set(0, 0.39, -0.01);
      helmet.add(helmetStripe);
      head.add(helmet);
      mesh.add(head);
      // Oversized vest and shoulder plates are visual only; hitboxes stay unchanged.
      const armor = new THREE.Group();
      const armorMat = makeMat("#36463c");
      const vest = new THREE.Mesh(
        new THREE.BoxGeometry(0.78, 0.98, 0.48),
        armorMat,
      );
      vest.position.y = 1.08;
      armor.add(vest);
      for (const side of [-1, 1]) {
        const pad = new THREE.Mesh(
          new THREE.SphereGeometry(0.23, 8, 6),
          makeMat("#58654b"),
        );
        pad.scale.set(1.2, 0.75, 1);
        pad.position.set(side * 0.38, 1.46, 0);
        armor.add(pad);
      }
      const chestPlate = new THREE.Mesh(
        new THREE.BoxGeometry(0.47, 0.45, 0.08),
        makeMat("#74714e"),
      );
      chestPlate.position.set(0, 1.2, -0.255);
      armor.add(chestPlate);
      mesh.add(armor);
      const legMaterial = makeMat("#313b34");
      const legGeo = new THREE.BoxGeometry(0.2, 0.48, 0.25);
      const legs = new THREE.Group();
      const legLeft = new THREE.Mesh(legGeo, legMaterial);
      const legRight = new THREE.Mesh(legGeo, legMaterial);
      legLeft.position.set(-0.14, 0.35, 0);
      legRight.position.set(0.14, 0.35, 0);
      legs.add(legLeft, legRight);
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
      const sniperWeapon = new THREE.Group();
      const sniperReceiver = new THREE.Mesh(
        new THREE.BoxGeometry(0.18, 0.18, 0.68),
        makeMat("#30332d"),
      );
      sniperReceiver.position.set(0.39, 1.22, -0.43);
      sniperWeapon.add(sniperReceiver);
      const sniperBarrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.04, 1.15, 7),
        makeMat("#666b5e"),
      );
      sniperBarrel.rotation.x = Math.PI / 2;
      sniperBarrel.position.set(0.39, 1.24, -1.18);
      sniperWeapon.add(sniperBarrel);
      const remoteScope = new THREE.Mesh(
        new THREE.CylinderGeometry(0.075, 0.075, 0.38, 8),
        makeMat("#11140f"),
      );
      remoteScope.rotation.x = Math.PI / 2;
      remoteScope.position.set(0.39, 1.37, -0.48);
      sniperWeapon.add(remoteScope);
      mesh.add(sniperWeapon);
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
      const chute = buildChute(); // mái dù, chỉ hiện khi người đó đang thả dù
      chute.visible = false;
      mesh.add(chute);
      mesh.userData = {
        state: p.state || "lobby",
        seat: p.seat || 0,
        chute,
        airTarget: null,
        inAir: false,
        torso,
        head,
        armor,
        legs,
        legLeft,
        legRight,
        weapon,
        sniperWeapon,
        armNear,
        armFar,
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
        gaitPhase: 0,
      };
      scene.add(mesh);
      remoteMeshes.set(p.id, mesh);
    }
    mesh.rotation.order = "YXZ";
    placeRemote(mesh, p);
    const curState = p.state || "lobby";
    if (mesh.userData.state !== curState) {
      const prevState = mesh.userData.state;
      mesh.userData.state = curState;
      // Nghe thấy người khác bung dù / tiếp đất nếu ở đủ gần.
      if (curState === "parachute")
        playChuteOpen({ x: p.x, y: p.y ?? 0, z: p.z });
      if (
        curState === "ground" &&
        (prevState === "freefall" || prevState === "parachute")
      )
        playLanding({ x: p.x, y: (p.groundY || 0) + 0.3, z: p.z });
    }
    // Chỉ cầm súng sau khi tiếp đất; ở phòng chờ / máy bay / trên không thì tay không.
    mesh.userData.weapon.visible =
      curState === "ground" && !p.vehicleId && p.weapon !== "sniper";
    mesh.userData.sniperWeapon.visible =
      curState === "ground" && !p.vehicleId && p.weapon === "sniper";
    mesh.userData.chute.visible = curState === "parachute";
    mesh.userData.slowWalking = Boolean(p.slowWalking);
    mesh.userData.crouching = Boolean(p.crouching);
    mesh.userData.prone = Boolean(p.prone);
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
    const canStep =
      p.alive &&
      !p.vehicleId &&
      !p.prone &&
      !p.swimming &&
      (curState === "ground" || curState === "lobby");
    if (canStep && motionDistance < 1.5) {
      // Accumulate replicated movement distance so unrelated state packets
      // (such as firing/reloading) cannot break footstep timing.
      mesh.userData.footstepDistance += motionDistance;
      mesh.userData.gaitDistance = motionDistance > 0.0004 ? 1 : 0;
      const strideDistance = p.slowWalking ? 1.75 : p.crouching ? 1.9 : 1.85;
      const intensity = p.slowWalking ? 0.24 : p.crouching ? 0.38 : 1;
      while (mesh.userData.footstepDistance >= strideDistance) {
        const soundY = p.groundY || 0;
        playSpatialFootstep(p.x, soundY + 0.08, p.z, intensity, false);
        mesh.userData.footstepDistance -= strideDistance;
      }
    } else if (!canStep || motionDistance >= 1.5) {
      mesh.userData.footstepDistance = 0;
      mesh.userData.gaitDistance = 0;
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
                playSpatialGunshot(
                  { x: p.x, y: muzzleY, z: p.z },
                  0.78,
                  i * 0.12,
                  p.weapon === "sniper" ? "sniper" : "rifle",
                );        playSpatialGunshot(
                  { x: p.x, y: muzzleY, z: p.z },
                  0.78,
                  i * 0.12,
                  p.weapon === "sniper" ? "sniper" : "rifle",
                );
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
  if (state.lastHit && state.lastHit.id !== lastHitEventId) {
    lastHitEventId = state.lastHit.id;
    const point = state.lastHit.point;
    spawnBloodBurst(new THREE.Vector3(point.x, point.y, point.z));
    if (state.lastHit.targetId === playerId) {
      showBloodScreenFlash();
      const shooter = state.players.find(
        (player) => player.id === state.lastHit.shooterId,
      );
      showDamageDirection(shooter);
    }
  }
  if (local.hp <= 0 && !deathView) beginDeathView(local);
}
// ---------------------------------------------------------------------------
// VẬT PHẨM RƠI TRÊN MAP (đạn, bịch máu) · BALO (Tab) · HỒI MÁU
// ---------------------------------------------------------------------------
// Server sinh vật phẩm ngẫu nhiên khi bắt đầu trận và quyết định ai nhặt được.
// Client chỉ vẽ vật phẩm, hiện gợi ý "F" và gửi yêu cầu lên server.
function lootLabel(item) {
  if (item.type === "ammo") return `ĐẠN 5.56 (+${item.amount})`;
  if (item.type === "weapon")
    return `${item.weapon === "sniper" ? "SNIPER" : "RANGER-9"} · NHẤN F ĐỔI SÚNG`;
  return "BỊCH MÁU";
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
function addLootItem(item) {
  const previous = lootItems.get(item.id);
  if (previous) disposeLootMesh(previous);
  const entry = { ...item, mesh: null, body: null };
  lootItems.set(entry.id, entry);
  if (scene && renderer) addLootMesh(entry);
}
function syncLootCrates(crates) {
  const liveIds = new Set(crates.map((crate) => crate.id));
  for (const [id, crate] of lootCrates) {
    if (liveIds.has(id)) continue;
    disposeCrateMesh(crate);
    lootCrates.delete(id);
    if (crateOpenId === id) closeBackpack();
  }
  for (const data of crates) {
    const crate = lootCrates.get(data.id);
    if (crate) {
      const contentsChanged =
        crate.contents?.ammo !== data.contents?.ammo ||
        crate.contents?.medkit !== data.contents?.medkit;
      crate.x = data.x;
      crate.z = data.z;
      crate.contents = data.contents;
      if (contentsChanged && backpackOpen && crateOpenId === crate.id)
        renderBackpack();
      continue;
    }
    const entry = { ...data, mesh: null };
    lootCrates.set(entry.id, entry);
    if (scene && renderer) addCrateMesh(entry);
  }
}
function addCrateMesh(crate) {
  if (!scene || crate.mesh) return;
  const root = new THREE.Group();
  root.userData.interactionTarget = { kind: "crate", id: crate.id };
  const orange = makeMat("#e87520", 0.88);
  const dark = makeMat("#49301d", 0.95);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.62, 0.72), orange);
  body.position.y = 0.34;
  root.add(body);
  const lid = new THREE.Mesh(
    new THREE.BoxGeometry(1.02, 0.12, 0.78),
    makeMat("#ff922f", 0.8),
  );
  lid.position.y = 0.69;
  root.add(lid);
  for (const z of [-0.27, 0.27]) {
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.68, 0.8), dark);
    strap.position.set(0, 0.35, z);
    root.add(strap);
  }
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.035, 1.25, 6),
    dark,
  );
  pole.position.set(-0.12, 1.27, 0);
  root.add(pole);
  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(0.58, 0.38),
    new THREE.MeshBasicMaterial({ color: "#111111", side: THREE.DoubleSide }),
  );
  flag.position.set(0.18, 1.65, 0);
  root.add(flag);
  root.position.set(crate.x, groundHeightAt(crate.x, crate.z), crate.z);
  scene.add(root);
  crate.mesh = root;
}
function disposeCrateMesh(crate) {
  if (!crate.mesh) return;
  scene?.remove(crate.mesh);
  crate.mesh.traverse((object) => {
    object.geometry?.dispose();
    if (Array.isArray(object.material))
      object.material.forEach((mat) => mat.dispose());
    else object.material?.dispose();
  });
  crate.mesh = null;
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
  const isWeapon = item.type === "weapon";
  const root = new THREE.Group();
  root.userData.interactionTarget = { kind: "loot", id: item.id };
  const body = new THREE.Group();
  if (isWeapon) {
    const receiver = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.16, 0.55),
      makeMat("#33372f"),
    );
    body.add(receiver);
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(
        0.035,
        0.035,
        item.weapon === "sniper" ? 0.9 : 0.52,
        7,
      ),
      makeMat("#171a16"),
    );
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = -0.62;
    body.add(barrel);
    const stock = new THREE.Mesh(
      new THREE.BoxGeometry(0.13, 0.15, 0.3),
      makeMat("#594432"),
    );
    stock.position.z = 0.38;
    body.add(stock);
    if (item.weapon === "sniper") {
      const scope = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.07, 0.32, 8),
        makeMat("#151812"),
      );
      scope.rotation.x = Math.PI / 2;
      scope.position.set(0, 0.12, -0.16);
      body.add(scope);
    }
  } else if (isMed) {
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
  const color = isMed ? 0xff4d5e : isWeapon ? 0x7de5ff : 0xffd24a;
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
  if (type === "weapon") return true;
  return type === "ammo"
    ? (local.reserveAmmo ?? 0) < packLimits.ammo
    : (local.medkits || 0) < packLimits.medkits;
}
function nearestLoot() {
  // Vật phẩm chỉ nhặt được sau khi tiếp đất và không đang bơi.
  if (local.state !== "ground" || local.swimming) return null;
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
function nearestCrate() {
  if (local.state !== "ground" || local.swimming) return null;
  let best = null;
  let bestDistance = 4.5;
  for (const crate of lootCrates.values()) {
    const distance = Math.hypot(crate.x - local.x, crate.z - local.z);
    if (distance < bestDistance) {
      best = crate;
      bestDistance = distance;
    }
  }
  return best;
}
// Chỉ chọn vật thể mà tia giữa màn hình chạm trúng, thay vì vật gần nhất.
function aimedInteractable() {
  if (
    !camera ||
    !scene ||
    local.hp <= 0 ||
    deathView ||
    $("#result")?.classList.contains("active") ||
    local.state !== "ground" ||
    local.swimming
  )
    return null;
  const roots = [];
  for (const item of lootItems.values()) if (item.mesh) roots.push(item.mesh);
  for (const crate of lootCrates.values())
    if (crate.mesh) roots.push(crate.mesh);
  if (!roots.length) return null;
  camera.updateMatrixWorld(true);
  interactRaycaster.setFromCamera(crosshairNdc, camera);
  interactRaycaster.far = 5;
  for (const hit of interactRaycaster.intersectObjects(roots, true)) {
    let object = hit.object;
    while (object && !object.userData.interactionTarget) object = object.parent;
    if (object?.userData.interactionTarget) {
      const target = object.userData.interactionTarget;
      const data =
        target.kind === "crate"
          ? lootCrates.get(target.id)
          : lootItems.get(target.id);
      const maxReach = target.kind === "crate" ? 5 : PICKUP_RADIUS;
      if (data && Math.hypot(data.x - local.x, data.z - local.z) <= maxReach)
        return { kind: target.kind, data };
    }
  }
  return null;
}
function nearestVehicle() {
  if (
    !gameState?.vehicles ||
    local.hp <= 0 ||
    deathView ||
    $("#result")?.classList.contains("active") ||
    local.state !== "ground" ||
    local.swimming ||
    local.vehicleId
  )
    return null;
  return (
    gameState.vehicles
      .filter(
        (v) =>
          !v.destroyed &&
          !v.submerged &&
          Math.hypot(v.x - local.x, v.z - local.z) <= 3.25,
      )
      .sort(
        (a, b) =>
          Math.hypot(a.x - local.x, a.z - local.z) -
          Math.hypot(b.x - local.x, b.z - local.z),
      )[0] || null
  );
}
function onInteract() {
  // F is also the close key while the death crate is open.
  if (backpackOpen && crateOpenId) {
    closeBackpack();
    return;
  }
  // Người đã bị hạ hoặc đang xem bảng kết quả không thể loot/vào xe.
  if (local.hp <= 0 || deathView || $("#result")?.classList.contains("active"))
    return;
  if (local.state !== "ground") return; // chưa tiếp đất thì chưa nhặt được gì
  if (local.vehicleId) {
    send({ type: "vehicleInteract" });
    return;
  }
  // F: đang hồi máu thì hủy hồi máu, ngược lại nhặt vật phẩm gần nhất.
  if (local.healing) {
    send({ type: "cancelHeal" });
    return;
  }
  if (backpackOpen) return;
  if (nearestVehicle()) {
    send({ type: "vehicleInteract" });
    return;
  }
  const target = aimedInteractable();
  if (target?.kind === "crate" && target.data) {
    openBackpack(target.data.id);
    return;
  }
  if (target?.kind === "loot" && target.data && packHasRoom(target.data.type))
    send({ type: "pickup", itemId: target.data.id });
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
#backpack{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:min(760px,94vw);max-height:88vh;overflow:auto;pointer-events:auto;background:#171a14ed;border:1px solid #555b48;box-shadow:0 15px 60px #0009;padding:22px;color:#f3f3ed;font-family:'DM Mono',monospace;z-index:5}
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
#backpack .bp-row{flex-wrap:wrap}
#backpack .bp-actions{display:flex;align-items:center;gap:6px;margin-left:auto}
#backpack .bp-actions input{width:72px;padding:7px;background:#252920;border:1px solid #454b3d;color:#fff;font:12px 'DM Mono',monospace}
#backpack .bp-actions button{padding:8px 10px;background:#d6ff45;color:#14170f;font:bold 10px 'DM Mono',monospace}
#backpack .bp-actions button.secondary-action{background:#30352b;color:#f2f2e9;border:1px solid #555b48}
#backpack .bp-actions button:disabled{opacity:.4;cursor:not-allowed}
#backpack .bp-section{margin-top:16px;padding-top:12px;border-top:1px solid #454b3d}
#backpack .bp-section h3{margin:0 0 8px;color:#ff922f;font:900 20px 'Barlow Condensed',Arial,sans-serif;letter-spacing:2px}
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
    <div class="bp-head"><span id="bpTitle">BALO</span><small>F / TAB / ESC · ĐÓNG</small></div>
    <div class="bp-row"><b>▮</b><div><strong>ĐẠN 5.56 MM</strong><small>ĐANG LẮP TRONG SÚNG: <span id="bpMag">30</span> / 30</small></div><span class="bp-count" id="bpAmmoCount">0</span><div class="bp-actions"><input id="bpDropAmmo" type="number" min="1" value="1" aria-label="Số viên đạn muốn thả"><button data-drop-item="ammo">THẢ</button></div></div>
    <div class="bp-row" id="bpMed"><b>✚</b><div><strong>BỊCH MÁU</strong><small>+20 MÁU · HỒI TRONG 5 GIÂY</small></div><span class="bp-count" id="bpMedCount">0</span><div class="bp-actions"><input id="bpDropMedkit" type="number" min="1" value="1" aria-label="Số bịch máu muốn thả"><button class="secondary-action" data-use-medkit>DÙNG</button><button data-drop-item="medkit">THẢ</button></div></div>
    <div id="crateSection" class="bp-section hidden"><h3>HÒM TIẾP TẾ</h3><div id="crateRows"></div></div>
    <div class="bp-foot">F · MỞ HÒM / NHẶT ĐỒ · NHẬP SỐ LƯỢNG ĐỂ THẢ HOẶC LẤY ĐỒ</div>`;
  $(".hud").append(panel);
  panel.addEventListener("click", (event) => {
    const useButton = event.target.closest("[data-use-medkit]");
    if (useButton) {
      useMedkit();
      return;
    }
    const dropButton = event.target.closest("[data-drop-item]");
    if (dropButton) {
      const type = dropButton.dataset.dropItem;
      const input = $(type === "ammo" ? "#bpDropAmmo" : "#bpDropMedkit");
      const amount = Math.floor(Number(input.value));
      const owned =
        type === "ammo" ? local.reserveAmmo || 0 : local.medkits || 0;
      if (!Number.isFinite(amount) || amount <= 0 || amount > owned) {
        showLootToast(`NHẬP SỐ LƯỢNG TỪ 1 ĐẾN ${owned}`);
        return;
      }
      send({ type: "dropItem", itemType: type, amount });
      return;
    }
    const takeButton = event.target.closest("[data-take-item]");
    if (takeButton && crateOpenId) {
      const type = takeButton.dataset.takeItem;
      const amount = Math.floor(Number($(`#crateAmount-${type}`)?.value));
      const crate = lootCrates.get(crateOpenId);
      const capacity =
        type === "ammo"
          ? packLimits.ammo - (local.reserveAmmo || 0)
          : packLimits.medkits - (local.medkits || 0);
      const available = crate?.contents?.[type] || 0;
      if (
        !Number.isFinite(amount) ||
        amount <= 0 ||
        amount > Math.min(capacity, available)
      ) {
        showLootToast("SỐ LƯỢNG KHÔNG HỢP LỆ HOẶC BALO ĐÃ ĐẦY");
        return;
      }
      if (
        send({
          type: "transferCrate",
          crateId: crateOpenId,
          itemType: type,
          amount,
        })
      )
        showLootToast("ĐANG LẤY VẬT PHẨM...");
    }
  });
  const hud = document.createElement("div");
  hud.id = "lootHud";
  hud.innerHTML = `<div class="lh-toast hidden"></div><div class="lh-prompt hidden"></div><div class="lh-heal hidden"><span></span><div><i></i></div></div>`;
  $(".hud").append(hud);
}
function renderBackpack() {
  if (!$("#backpack")) return;
  const enteredAmounts = new Map(
    [...$("#backpack").querySelectorAll("input[type=number]")].map((input) => [
      input.id,
      input.value,
    ]),
  );
  $("#bpAmmoCount").innerHTML =
    `${local.reserveAmmo ?? 0}<small>/${packLimits.ammo}</small>`;
  $("#bpMag").textContent = ammo;
  $("#bpMedCount").innerHTML =
    `${local.medkits || 0}<small>/${packLimits.medkits}</small>`;
  $("#bpAmmoCount").classList.toggle("full", !packHasRoom("ammo"));
  $("#bpMedCount").classList.toggle("full", !packHasRoom("medkit"));
  const ammoDrop = $("#bpDropAmmo");
  const medkitDrop = $("#bpDropMedkit");
  for (const [input, count] of [
    [ammoDrop, local.reserveAmmo || 0],
    [medkitDrop, local.medkits || 0],
  ]) {
    input.max = count;
    input.disabled = count <= 0;
    const nextValue = String(
      Math.min(count, Math.max(1, Number(enteredAmounts.get(input.id) || 1))),
    );
    if (input.value !== nextValue) input.value = nextValue;
  }
  const crateSection = $("#crateSection");
  const crateRows = $("#crateRows");
  const crate = crateOpenId ? lootCrates.get(crateOpenId) : null;
  $("#bpTitle").textContent = crate ? "BALO / HÒM TIẾP TẾ" : "BALO";
  crateSection.classList.toggle("hidden", !crate);
  if (!crate) {
    if (crateRows.innerHTML) crateRows.innerHTML = "";
    delete crateRows.dataset.renderKey;
    return;
  }
  const specs = [
    {
      type: "ammo",
      name: "ĐẠN 5.56 MM",
      space: packLimits.ammo - (local.reserveAmmo || 0),
    },
    {
      type: "medkit",
      name: "BỊCH MÁU",
      space: packLimits.medkits - (local.medkits || 0),
    },
  ];
  const renderKey = JSON.stringify({
    id: crate.id,
    items: specs.map(({ type, space }) => [
      type,
      crate.contents?.[type] || 0,
      space,
    ]),
  });
  // State snapshots arrive repeatedly. Keep the same buttons/inputs in the DOM
  // between actual inventory changes so a click cannot be interrupted mid-flight.
  if (crateRows.dataset.renderKey === renderKey) return;
  crateRows.innerHTML = specs
    .map(({ type, name, space }) => {
      const available = crate.contents?.[type] || 0;
      const maximum = Math.max(0, Math.min(available, space));
      const inputId = `crateAmount-${type}`;
      const desired = Math.max(
        1,
        Number(enteredAmounts.get(inputId) || maximum || 1),
      );
      return `<div class="bp-row"><b>${type === "ammo" ? "▮" : "✚"}</b><div><strong>${name}</strong><small>CÒN TRONG HÒM: ${available}</small></div><span class="bp-count">${available}</span><div class="bp-actions"><input id="${inputId}" type="number" min="1" max="${maximum}" value="${Math.min(maximum, desired)}" ${maximum <= 0 ? "disabled" : ""} aria-label="Số lượng muốn lấy"><button data-take-item="${type}" ${maximum <= 0 ? "disabled" : ""}>LẤY</button></div></div>`;
    })
    .join("");
  crateRows.dataset.renderKey = renderKey;
}
function openBackpack(forCrateId = null) {
  if (
    backpackOpen ||
    paused ||
    local.state !== "ground" ||
    !$("#game").classList.contains("active")
  )
    return;
  backpackOpen = true;
  crateOpenId = forCrateId;
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
  crateOpenId = null;
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
  lootToastTimer = setTimeout(() => el.classList.add("hidden"), 10000);
}
// Súng hạ/gập khi hồi máu và có động tác tháo lắp băng đạn khi nạp.
function updateGunPose(dt) {
  if (!gun) return;
  if (deathView) {
    gun.visible = false;
    if (steeringWheel) steeringWheel.visible = false;
    return;
  }
  const aimTarget =
    scoped && local.weapon !== "sniper" && local.state === "ground" ? 1 : 0;
  gunAimBlend += (aimTarget - gunAimBlend) * Math.min(12 * dt, 1);
  if (Math.abs(aimTarget - gunAimBlend) < 0.002) gunAimBlend = aimTarget;
  const target = local.healing ? 1 : 0;
  gunBusy += (target - gunBusy) * Math.min(10 * dt, 1);
  if (Math.abs(target - gunBusy) < 0.002) gunBusy = target;
  const reloadProgress =
    local.reloading && local.reloadStartedAt
      ? clamp((performance.now() - local.reloadStartedAt) / 1800, 0, 1)
      : 0;
  const reloadDip = local.reloading ? Math.sin(reloadProgress * Math.PI) : 0;
  gun.rotation.set(0.15 * gunBusy, 1.35 * gunBusy, -0.12 * gunBusy);
  gun.position.set(
    0.3 * gunBusy - 0.28 * gunAimBlend,
    -0.14 * gunBusy + 0.075 * gunAimBlend,
    0.05 * gunBusy,
  );
  const magazine = gun.userData.magazine;
  if (magazine) {
    const down = local.reloading
      ? clamp((reloadProgress - 0.12) / 0.2, 0, 1) *
        (1 - clamp((reloadProgress - 0.56) / 0.22, 0, 1))
      : 0;
    magazine.position.set(0.28 - 0.04 * down, -0.36 - 0.34 * down, -0.55);
  }
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
  if (
    local.hp <= 0 ||
    deathView ||
    $("#result")?.classList.contains("active")
  ) {
    heal.classList.add("hidden");
    prompt.classList.add("hidden");
    return;
  }
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
  if (local.vehicleId) {
    prompt.innerHTML = `<b>F</b>RỜI KHỎI XE`;
    prompt.classList.remove("hidden");
    return;
  }
  if (nearestVehicle()) {
    prompt.innerHTML = `<b>F</b>VÀO LÁI XE · TỐI ĐA 2 NGƯỜI`;
    prompt.classList.remove("hidden");
    return;
  }
  const target = aimedInteractable();
  if (target?.kind === "crate" && target.data) {
    prompt.innerHTML = `<b>F</b>MỞ HÒM TIẾP TẾ`;
    prompt.classList.remove("hidden");
  } else if (target?.kind === "loot" && target.data) {
    const item = target.data;
    prompt.innerHTML = packHasRoom(item.type)
      ? `<b>F</b>NHẶT ${lootLabel(item)}`
      : `<b>✕</b>BALO ĐẦY · KHÔNG NHẶT ĐƯỢC ${item.type === "ammo" ? "ĐẠN" : "BỊCH MÁU"}`;
    prompt.classList.remove("hidden");
  } else {
    prompt.classList.add("hidden");
  }
}
function beginGame() {
  inMatch = true;
  readySent = false;
  jumpRequestedAt = 0;
  envBlend = 0;
  lastCountdownNumber = null;
  airState = { vx: 0, vz: 0, fall: 0, time: 0 };
  local.state = "lobby";
  local.vehicleId = null;
  local.vehicleSeat = -1;
  pendingLocalShots = [];
  lastLocalShotAckId = 0;
  local.y = 0;
  lastHitEventId = 0;
  lastEliminationId = 0;
  localEliminationMessage = "";
  local.placement = 0;
  $("#killFeed").replaceChildren();
  local.hp = 100;
  deathView = null;
  recoilPitch = 0;
  recoilYaw = 0;
  camera?.up.set(0, 1, 0);
  if (deathResultTimer) clearTimeout(deathResultTimer);
  deathResultTimer = null;
  $("#deathViewOverlay")?.classList.add("hidden");
  local.kills = 0;
  verticalSpeed = 0;
  grounded = true;
  jumpOffset = 0;
  local.crouching = false;
  local.prone = false;
  local.peek = 0;
  peekBlend = 0;
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
  updateAmmoHud();
  show("game");
  initWorld();
  // Phòng hờ thêm: đảm bảo trận mới luôn sạch, không còn scope/ESC từ trận trước.
  setScope(false);
  $("#gameMessage").classList.add("hidden");
  $("#pauseSettings").classList.add("hidden");
  $("#pauseMain").classList.remove("hidden");
  if (!$("#chuteOverlay").innerHTML)
    $("#chuteOverlay").innerHTML = buildChuteOverlay();
  setMode("lobby"); // vào map chờ: tay không, không vật phẩm
  $("#world").onclick = () => {
    if (paused || backpackOpen) return;
    // Bật fullscreen/keyboard lock từ cú click của người chơi. Đây là cách
    // trình duyệt hỗ trợ để gửi các tổ hợp như Ctrl+W về game khi có thể.
    enterGameInputMode();
  };
  $("#world").oncontextmenu = (e) => e.preventDefault();
  document.addEventListener("pointerlockchange", onPointerLockChange);
  document.addEventListener("mousemove", onMouse);
  document.addEventListener("mousedown", onFire);
  document.addEventListener("wheel", onScopeWheel, { passive: false });
  document.addEventListener("mouseup", onMouseUp);
  window.addEventListener("blur", onGameWindowBlur);
  document.addEventListener("contextmenu", blockContextMenu);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keydown", blockBrowserShortcuts, true);
  document.addEventListener("keyup", onKeyUp);
  installReloadHud();
  installLootUi();
  installZoneHud();
  installZoneGrayOverlay();
  $("#resumeBtn").onclick = resumeGame;
  $("#openPauseSettings").onclick = openPauseSettings;
  $("#closePauseSettings").onclick = closePauseSettings;
  $("#leaveMatchBtn").onclick = leaveMatch;
}

// Keyboard Lock chỉ được hỗ trợ ở một số trình duyệt và thường cần fullscreen.
// Ctrl+W sẽ vẫn đặt KeyW cho điều khiển đi chậm, nhưng không đóng tab nếu browser
// cho phép khóa phím. Các trình duyệt/OS vẫn có thể giữ lại một số shortcut.
const GAME_KEY_CODES = [
  "KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "KeyR", "KeyZ", "KeyF",
  "Space", "Tab", "Escape", "F5", "F6", "F11", "F12",
];

function enterGameInputMode() {
  const canvas = renderer?.domElement;
  const game = $("#game");
  if (!canvas || !game) return;

  // Gọi cả hai API đồng bộ trong cùng thao tác click để đáp ứng user activation.
  try {
    const lockRequest = canvas.requestPointerLock?.();
    lockRequest?.catch?.(() => {});
  } catch {}

  if (!document.fullscreenElement && game.requestFullscreen) {
    try {
      const fullscreenRequest = game.requestFullscreen({
        navigationUI: "hide",
        keyboardLock: "browser",
      });
      fullscreenRequest?.then(() => lockGameKeys()).catch(() => {
        // Hỗ trợ browser không nhận tùy chọn keyboardLock nhưng vẫn có fullscreen.
        game.requestFullscreen?.().then(() => lockGameKeys()).catch(() => {});
      });
    } catch {
      // Tiếp tục chơi dạng cửa sổ nếu fullscreen không được hỗ trợ.
    }
  } else if (document.fullscreenElement === game) {
    lockGameKeys();
  }
}

function lockGameKeys() {
  try {
    const request = navigator.keyboard?.lock?.(GAME_KEY_CODES);
    request?.catch?.(() => {});
  } catch {
    // Fallback: blockBrowserShortcuts vẫn ngăn được các sự kiện trình duyệt.
  }
}

function releaseGameInputMode() {
  try { navigator.keyboard?.unlock?.(); } catch {}
  if (document.fullscreenElement === $("#game")) {
    document.exitFullscreen?.().catch?.(() => {});
  }
}

function blockBrowserShortcuts(e) {
  const game = $("#game");
  const editing = e.target?.closest?.("input, textarea, select, [contenteditable='true']");
  if (!game?.classList.contains("active") || editing) return;
  if (document.pointerLockElement !== renderer?.domElement) return;

  // Không stopPropagation: các phím điều khiển của game vẫn nhận được sự kiện.
  // preventDefault chặn các shortcut có thể chặn bằng trang web.
  if (e.ctrlKey || e.metaKey || e.altKey || ["F5", "F6", "F11", "F12"].includes(e.code)) {
    e.preventDefault();
  }
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
function installZoneHud() {
  document.querySelector("#zoneHud")?.remove();
  document.querySelector("#zoneDangerTint")?.remove();
  const hud = document.createElement("div");
  hud.id = "zoneHud";
  Object.assign(hud.style, {
    position: "absolute",
    left: "50%",
    top: "44px",
    transform: "translateX(-50%)",
    padding: "6px 16px",
    // borderRadius: "8px",
    // background: "rgba(10,14,10,.55)",
    color: "#8fd4ff",
    font: "bold 13px 'DM Mono', monospace",
    letterSpacing: ".5px",
    textShadow: "0 1px 4px #000",
    textAlign: "center",
    pointerEvents: "none",
    zIndex: 5,
    whiteSpace: "nowrap",
  });
  $("#game").append(hud);
  const tint = document.createElement("div");
  tint.id = "zoneDangerTint";
  Object.assign(tint.style, {
    position: "absolute",
    inset: "0",
    pointerEvents: "none",
    background:
      "radial-gradient(ellipse at center, transparent 55%, rgba(200,10,10,.55) 100%)",
    opacity: "0",
    transition: "opacity .3s",
    zIndex: 4,
  });
  $("#game").append(tint);
}
function installZoneGrayOverlay() {
  if ($("#zoneGrayOverlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "zoneGrayOverlay";

  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(90, 90, 90, 0.48)",
    pointerEvents: "none",
    opacity: "0",
    transition: "opacity 0.2s ease",
    zIndex: "4",
  });

  document.body.appendChild(overlay);
}
function updateZoneHud() {
  const hud = $("#zoneHud");
  const tint = $("#zoneDangerTint");
  const grayOverlay = $("#zoneGrayOverlay");
  if (!hud) return;
  const zone = gameState?.zone;
  if (!zone || local.state === "lobby") {
    if (grayOverlay) grayOverlay.style.opacity = "0";
    hud.textContent = "";
    if (tint) tint.style.opacity = "0";
    return;
  }
  const circle = zoneCircleNow();
  let statusText = "VÒNG BO CUỐI CÙNG";
  if (zone.phase === "wait") {
    const secs = Math.max(0, Math.ceil((zone.waitEndsAt - serverNow()) / 1000));
    statusText = `VÒNG AN TOÀN · THU HẸP SAU ${secs}S`;
  } else if (zone.phase === "shrink") {
    const secs = Math.max(
      0,
      Math.ceil((zone.shrinkEndsAt - serverNow()) / 1000),
    );
    statusText = `VÒNG ĐANG THU HẸP · ${secs}S`;
  }
  const distOutside =
    circle && local.state === "ground"
      ? Math.hypot(local.x - circle.x, local.z - circle.z) - circle.radius
      : -1;
  if (distOutside > 0) {
    if (grayOverlay) grayOverlay.style.opacity = "1";

    hud.textContent = `NGOÀI VÒNG AN TOÀN · CÒN ${Math.round(distOutside)}M · -${zone.damage}HP/S`;
    hud.style.color = "#ff5252";

    if (tint) tint.style.opacity = "1";
  } else {
    if (grayOverlay) grayOverlay.style.opacity = "0";

    hud.textContent = statusText;
    hud.style.color = "#8fd4ff";

    if (tint) tint.style.opacity = "0";
  }
}
function updateZoneWorld() {
  if (!zoneWallMesh) return;
  const edgeLine = zoneWallMesh.userData.edgeLine;
  const circle = zoneCircleNow();
  if (!circle || local.state === "lobby") {
    zoneWallMesh.visible = false;
    if (edgeLine) edgeLine.visible = false;
    if (zoneTargetLine) zoneTargetLine.visible = false;
    return;
  }
  const isOutside =
    Math.hypot(local.x - circle.x, local.z - circle.z) > circle.radius;
  zoneWallMesh.visible = true;
  zoneWallMesh.position.set(circle.x, 35, circle.z);
  zoneWallMesh.scale.set(circle.radius, 1, circle.radius);
  zoneWallMesh.material.color.set(isOutside ? 0xff5252 : 0x66ccff);
  zoneWallMesh.material.opacity = isOutside ? 0.3 : 0.16;
  if (edgeLine) {
    edgeLine.visible = true;
    edgeLine.position.set(circle.x, 0.18, circle.z);
    edgeLine.scale.set(circle.radius, 1, circle.radius);
    edgeLine.material.color.set(isOutside ? 0xff8f6f : 0x8fe0ff);
  }
  const zone = gameState?.zone;
  if (zoneTargetLine) {
    if (zone?.phase === "shrink") {
      zoneTargetLine.visible = true;
      zoneTargetLine.position.set(zone.toCenter.x, 0.2, zone.toCenter.z);
      zoneTargetLine.scale.set(zone.toRadius, 1, zone.toRadius);
    } else {
      zoneTargetLine.visible = false;
    }
  }
}
function blockContextMenu(e) {
  if ($("#game").classList.contains("active")) e.preventDefault();
}
function onPointerLockChange() {
  if (document.pointerLockElement !== renderer?.domElement) stopFiring();
  if (deathView || $("#result")?.classList.contains("active")) return;
  if (backpackOpen) return; // đang mở balo: thả chuột là chủ ý, không tạm dừng
  if (
    document.pointerLockElement !== renderer?.domElement &&
    $("#game").classList.contains("active") &&
    !paused
  )
    pauseGame();
}
function onKeyDown(e) {
  const modifierKey = ["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"].includes(e.code);
  const ctrlWalkKey = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && ["KeyW", "KeyS"].includes(e.code);
  if (!modifierKey && !ctrlWalkKey && (e.ctrlKey || e.metaKey || e.altKey)) {
    // Ctrl+R, Ctrl+T, Alt+Left... không được kích hoạt thao tác game.
    e.preventDefault();
    return;
  }

  if (e.code === "Escape") {
    e.preventDefault();

    // Deathcam is a spectator state, not a playable pause state.
    if (deathView || $("#result")?.classList.contains("active")) return;

    if (backpackOpen) {
      closeBackpack();
      return;
    }
    if (paused && !$("#pauseSettings").classList.contains("hidden"))
      closePauseSettings();
    else if (paused) resumeGame();
    else pauseGame();

    return;
  }

  if (e.code === "KeyQ" || e.code === "KeyE") {
    e.preventDefault();
    if (
      !paused &&
      !backpackOpen &&
      !deathView &&
      !local.vehicleId &&
      local.state === "ground" &&
      grounded &&
      !local.jumping &&
      !local.swimming &&
      !local.prone &&
      $("#game").classList.contains("active")
    ) {
      keys[e.code] = true;
      lastMove = 0;
    }
    return;
  }

  if (local.vehicleId && e.code === "Space") {
    e.preventDefault();
    keys.Space = true; // phanh gấp; không dùng Space để nhảy khi đang ngồi trong xe
    return;
  }

  // Trên máy bay: Space / F nhảy dù. Đang rơi tự do: Space / F bung dù.
  if (
    (e.code === "Space" || e.code === "KeyF") &&
    !paused &&
    $("#game").classList.contains("active")
  ) {
    if (local.state === "plane") {
      e.preventDefault();
      if (!e.repeat) requestJump();
      return;
    }
    if (local.state === "freefall") {
      e.preventDefault();
      if (!e.repeat) deployChute(false);
      return;
    }
    if (local.state === "parachute") {
      e.preventDefault();
      return;
    }
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
    local.state === "ground" &&
    $("#game").classList.contains("active")
  ) {
    e.preventDefault();
    if (!local.healing) {
      stopFiring();
      send({ type: "reload" });
    }
    return;
  }

  if (
    e.code === "KeyZ" &&
    !e.repeat &&
    !paused &&
    (local.state === "ground" || local.state === "lobby") &&
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
    (local.state === "ground" || local.state === "lobby") &&
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
  if (e.code === "KeyQ" || e.code === "KeyE") lastMove = 0;
}
function onGameWindowBlur() {
  stopFiring();
  keys.KeyQ = false;
  keys.KeyE = false;
  lastMove = 0;
}
function pauseGame() {
  if (
    paused ||
    deathView ||
    $("#result")?.classList.contains("active") ||
    !$("#game").classList.contains("active")
  )
    return;
  closeBackpack(false);
  paused = true;
  stopFiring();
  if (local.vehicleId && local.vehicleSeat === 0)
    send({ type: "vehicleControl", throttle: 0, steer: 0, brake: true });
  keys = {};
  scoped = false;
  setScope(false);
  $("#pauseMain").classList.remove("hidden");
  $("#pauseSettings").classList.add("hidden");
  $("#gameMessage").classList.remove("hidden");
  if (document.pointerLockElement) document.exitPointerLock();
}
function openPauseSettings() {
  syncPauseSettings();
  $("#pauseMain").classList.add("hidden");
  $("#pauseSettings").classList.remove("hidden");
}
function closePauseSettings() {
  $("#pauseSettings").classList.add("hidden");
  $("#pauseMain").classList.remove("hidden");
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
  $("#status").textContent = "● ONLINE";
  $("#gameMessage").classList.add("hidden");
  show("menu");
}
function cleanupGame() {
  releaseGameInputMode();
  if (deathResultTimer) clearTimeout(deathResultTimer);
  deathResultTimer = null;
  deathView = null;
  camera?.up.set(0, 1, 0);
  $("#deathViewOverlay")?.classList.add("hidden");
  const grayOverlay = $("#zoneGrayOverlay");
  if (grayOverlay) {
    grayOverlay.style.opacity = "0";
  }
  document.removeEventListener("mousemove", onMouse);
  document.removeEventListener("mousedown", onFire);
  document.removeEventListener("wheel", onScopeWheel);
  document.removeEventListener("mouseup", onMouseUp);
  window.removeEventListener("blur", onGameWindowBlur);
  stopFiring();
  document.removeEventListener("pointerlockchange", onPointerLockChange);
  document.removeEventListener("contextmenu", blockContextMenu);
  document.removeEventListener("keydown", onKeyDown);
  document.removeEventListener("keydown", blockBrowserShortcuts, true);
  document.removeEventListener("keyup", onKeyUp);
  closeBackpack(false);
  for (const item of lootItems.values()) disposeLootMesh(item);
  lootItems.clear();
  for (const crate of lootCrates.values()) disposeCrateMesh(crate);
  lootCrates.clear();
  crateOpenId = null;
  stopLoop("plane", 0.05);
  stopLoop("wind", 0.05);
  stopLoop("weather", 0.12);
  stopVehicleEngineAudio(0.03);
  stopVehicleFireAudio(0.03);
  weatherActive = false;
  if (weatherFx?.mesh) {
    scene?.remove(weatherFx.mesh);
    weatherFx.geometry.dispose();
    weatherFx.material.dispose();
  }
  weatherFx = null;
  inMatch = false;
  plane = null;
  planeObject = null;
  renderer?.dispose();
  renderer = null;
  remoteMeshes.clear();
}
function onMouse(e) {
  // While driving, steering controls the car and the POV follows its heading.
  if (local.vehicleId && local.vehicleSeat === 0) return;
  if (document.pointerLockElement !== renderer?.domElement) return;
  const sniperZoomScale =
    scoped && local.weapon === "sniper"
      ? clamp(sniperZoomFov / baseFov, 0.12, 1)
      : 1;
  local.yaw -=
    e.movementX *
    (Number($("#sensitivity").value) || 50) *
    0.000055 *
    sniperZoomScale;
  camera.rotation.order = "YXZ";
  camera.rotation.y = local.yaw + recoilYaw;
  camera.rotation.x = Math.max(
    -1.35,
    Math.min(1.35, camera.rotation.x - e.movementY * 0.0018),
  );
}
function onFire(e) {
  if (e.button === 2) {
    if (
      !deathView &&
      local.state === "ground" &&
      !local.vehicleId &&
      $("#game").classList.contains("active") &&
      !paused &&
      !local.healing &&
      document.pointerLockElement === renderer?.domElement
    )
      setScope(!scoped);
    return;
  }
  if (e.button === 0 && local.vehicleId) {
    if (
      !paused &&
      local.vehicleSeat === 0 &&
      document.pointerLockElement === renderer?.domElement
    ) {
      playCarHorn();
      send({ type: "horn" });
    }
    return;
  }
  if (
    e.button !== 0 ||
    deathView ||
    paused ||
    local.state !== "ground" ||
    !$("#game").classList.contains("active") ||
    document.pointerLockElement !== renderer?.domElement
  )
    return;
  if (triggerHeld) return;
  // Clicking repeatedly must not bypass the bolt-action cooldown.
  if (
    local.weapon === "sniper" &&
    Date.now() - lastClientShotAt < SNIPER_FIRE_INTERVAL_MS
  )
    return;
  triggerHeld = true;
  shootOnce();
  fireInterval = setInterval(
    shootOnce,
    local.weapon === "sniper" ? SNIPER_FIRE_INTERVAL_MS : FIRE_INTERVAL_MS,
  );
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
    deathView ||
    local.vehicleId ||
    paused ||
    local.state !== "ground" ||
    !$("#game").classList.contains("active") ||
    document.pointerLockElement !== renderer?.domElement
  ) {
    stopFiring();
    return;
  }
  if (local.reloading || local.healing) return;
  const now = Date.now();
  if (
    local.weapon === "sniper" &&
    now - lastClientShotAt < SNIPER_FIRE_INTERVAL_MS
  )
    return;
  if (ammo <= 0) {
    tone(120, 0.07, "square", 0.015);
    stopFiring();
    return;
  }
    lastClientShotAt = now;
    playSpatialGunshot(
      null,
      0.65,
      0,
      local.weapon === "sniper" ? "sniper" : "rifle",
    );
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
    x: eye.x,
    z: eye.z,
    eyeY: eye.y,
  });
  // This shot follows the current reticle exactly; recoil is applied just
  // afterward so it moves the aim for the next shot instead of deflecting this one.
  const stanceScale = local.prone ? 0.35 : local.crouching ? 0.65 : 1;
  const recoilScale = (scoped ? 0.72 : 1) * stanceScale;
  const pitchKick = (local.weapon === "sniper" ? 0.105 : 0.05) * recoilScale;
  const yawKick =
    (Math.random() - 0.5) *
    (local.weapon === "sniper" ? 0.018 : 0.04) *
    recoilScale;
  camera.rotation.x = clamp(camera.rotation.x + pitchKick, -1.35, 1.35);
  recoilPitch += pitchKick;
  recoilYaw += yawKick;
  camera.rotation.y = local.yaw + recoilYaw;
}
function setScope(enabled) {
  scoped = enabled;
  camera.fov = scoped
    ? local.weapon === "sniper"
      ? sniperZoomFov
      : 58
    : baseFov;
  camera.updateProjectionMatrix();
  gun.visible =
    local.state === "ground" && (!scoped || local.weapon !== "sniper");
  $(".crosshair").classList.toggle("scope-hidden", scoped);
  const overlay = $("#scopeOverlay");
  overlay.classList.toggle("hidden", !scoped);
  overlay.classList.toggle("reflex", scoped && local.weapon !== "sniper");
  overlay.classList.toggle("sniper", scoped && local.weapon === "sniper");
  overlay.querySelector("small").textContent =
    scoped && local.weapon !== "sniper"
      ? "RED DOT / HOLO · RIGHT CLICK ĐỂ THOÁT"
      : "ỐNG NGẮM SNIPER · RIGHT CLICK ĐỂ THOÁT";
}
function onScopeWheel(event) {
  if (!scoped || local.weapon !== "sniper") return;
  event.preventDefault();
  sniperZoomFov = clamp(sniperZoomFov + Math.sign(event.deltaY) * 2, 5, 24);
  camera.fov = sniperZoomFov;
  camera.updateProjectionMatrix();
}
function updateLocalWeaponVisual() {
  if (!gun) return;
  const sniper = local.weapon === "sniper";
  for (const part of gun.userData.rangerParts || []) part.visible = !sniper;
  if (gun.userData.sniper) gun.userData.sniper.visible = sniper;
  gun.userData.magazine =
    gun.userData.magazines?.[sniper ? "sniper" : "ranger"] ||
    gun.userData.magazine;
  const small = $(".weapon small"),
    name = $(".weapon b");
  if (small)
    small.textContent = sniper
      ? "RIFLE / SNIPER · BOLT ACTION"
      : "RIFLE / ASSAULT";
  if (name) name.textContent = sniper ? "SNIPER" : "RANGER-9";
  if (scoped) setScope(true);
}
function makeTracer() {
  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);
  const eye = new THREE.Vector3();
  camera.getWorldPosition(eye);
  const muzzle = new THREE.Vector3();
  if (scoped) {
    // While aiming, start the visible tracer on the camera's center ray so it
    // stays aligned with the reticle instead of streaking in from the hip-fire muzzle.
    muzzle.copy(eye).addScaledVector(direction, 0.25);
  } else {
    camera.localToWorld(
      muzzle.set(0.28, -0.2, local.weapon === "sniper" ? -1.65 : -1),
    );
  }
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
// ---------------------------------------------------------------------------
// LUỒNG TRẬN (client): phòng chờ trong map → đếm ngược → máy bay → nhảy dù → tiếp đất
// Server quyết định pha và thời điểm (staging / countdown / plane / playing).
// Client mô phỏng chuyển động của chính mình và gửi lên server ("air", "chute", "land").
// Trạng thái người chơi: lobby → plane → freefall → parachute → ground.
// Chỉ ở trạng thái "ground" mới có súng, nhặt đồ, bắn, nạp đạn.
// ---------------------------------------------------------------------------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const planeYaw = () => (plane ? Math.atan2(-plane.dx, -plane.dz) : 0);
const serverNow = () => Date.now() + serverOffset;
const planeTime = () => (plane ? (serverNow() - plane.startedAt) / 1000 : 0);
function planePosAt(t) {
  return {
    x: plane.sx + plane.dx * plane.speed * t,
    z: plane.sz + plane.dz * plane.speed * t,
  };
}
// Vòng bo hiện tại (nội suy nếu đang thu hẹp) — dùng chung cho minimap và HUD.
function zoneCircleNow() {
  const zone = gameState?.zone;
  if (!zone) return null;
  if (zone.phase !== "shrink")
    return { x: zone.toCenter.x, z: zone.toCenter.z, radius: zone.toRadius };
  const span = Math.max(1, zone.shrinkEndsAt - zone.shrinkStartAt);
  const t = clamp((serverNow() - zone.shrinkStartAt) / span, 0, 1);
  return {
    x: zone.fromCenter.x + (zone.toCenter.x - zone.fromCenter.x) * t,
    z: zone.fromCenter.z + (zone.toCenter.z - zone.fromCenter.z) * t,
    radius: zone.fromRadius + (zone.toRadius - zone.fromRadius) * t,
  };
}
// Vị trí (thế giới) của một chỗ đứng trong khoang máy bay tại thời điểm t.
function seatWorld(seat, t) {
  const p = planePosAt(t);
  const [lx, lz] = PLANE_SEATS[seat % PLANE_SEATS.length];
  const yaw = planeYaw();
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { x: p.x + lx * c + lz * s, z: p.z - lx * s + lz * c };
}
function setMode(state) {
  local.state = state;
  $("#game").dataset.mode = state;
  if (scoped) setScope(false);
  if (gun)
    gun.visible = state === "ground" && (!scoped || local.weapon !== "sniper");
  $("#chuteOverlay").classList.toggle("hidden", state !== "parachute");
  // Keep the top-down minimap visible after landing; flight instructions are contextual.
  $("#flightHud").classList.remove("hidden");
  $("#flightInfo").classList.toggle(
    "hidden",
    !(state === "plane" || state === "freefall" || state === "parachute"),
  );
  $("#swimHint")?.classList.add("hidden");
  $("#underwaterTint")?.classList.remove("active");
}
// Server luôn là bên quyết định chuyển pha tiến lên (lobby → plane → freefall).
// Các bước bung dù và tiếp đất do client báo lên trước, server chỉ xác nhận lại.
function syncLocalState(p) {
  const target = p.state || "lobby";
  if ((STATE_ORDER[target] ?? 0) <= (STATE_ORDER[local.state] ?? 0)) return;
  if (target === "plane") enterPlane(p);
  else if (target === "freefall" || target === "parachute")
    enterFreefall(p, target);
}
function enterPlane(p) {
  if (!plane) return;
  local.seat = p.seat || 0;
  local.peek = 0;
  peekBlend = 0;
  keys.KeyQ = false;
  keys.KeyE = false;
  jumpCuePlayed = false;
  local.prone = false;
  local.crouching = false;
  local.jumping = false;
  grounded = true;
  verticalSpeed = 0;
  jumpOffset = 0;
  stopFiring();
  closeBackpack(false);
  setMode("plane");
  local.yaw = planeYaw();
  camera.rotation.order = "YXZ";
  camera.rotation.y = local.yaw;
  camera.rotation.x = -0.12;
  camera.rotation.z = 0;
  startedAt = Date.now();
  jumpRequestedAt = 0;
  startPlaneSound();
  showLootToast("LÊN MÁY BAY · NHẢY KHI ĐÈN XANH");
}
function enterFreefall(p, state) {
  local.peek = 0;
  peekBlend = 0;
  keys.KeyQ = false;
  keys.KeyE = false;
  camera.rotation.z = 0;
  local.x = p.x;
  local.z = p.z;
  local.y = p.y ?? (plane ? plane.alt : 200);
  // Giữ đà bay của máy bay lúc mới nhảy, tắt dần khi người chơi tự điều khiển.
  airState = {
    vx: plane ? plane.dx * plane.speed : 0,
    vz: plane ? plane.dz * plane.speed : 0,
    fall: 0,
    time: 0,
  };
  camera.rotation.x = -0.75; // nhìn xuống map
  setMode(state === "parachute" ? "parachute" : "freefall");
  stopLoop("plane", 3);
  startWind();
  if (state === "parachute") playChuteOpen(null);
  else playJumpWhoosh();
}
function requestJump() {
  if (!plane || local.state !== "plane") return;
  if (planeTime() < plane.tEnter) {
    showLootToast("CHƯA TỚI VÙNG NHẢY");
    return;
  }
  if (Date.now() - jumpRequestedAt < 500) return;
  jumpRequestedAt = Date.now();
  send({ type: "jump" });
}
function deployChute(auto) {
  if (local.state !== "freefall") return;
  if (!auto && airState.time < 0.8) return;
  setMode("parachute");
  send({ type: "chute" });
  playChuteOpen(null);
  showLootToast(auto ? "TỰ ĐỘNG BUNG DÙ" : "ĐÃ BUNG DÙ");
}
// Đẩy người chơi ra khỏi cây / đá / tường nếu tiếp đất trúng chúng.
function findFreeSpotLocal(x, z, landingY = local.groundY) {
  x = clamp(x, -MAP_HALF + 1.5, MAP_HALF - 1.5);
  z = clamp(z, -MAP_HALF + 1.5, MAP_HALF - 1.5);
  const raised = raisedSurfaceAt(x, z);
  if (raised && landingY >= raised.height - 0.35) return { x, z };
  if (!isBlockedAt(x, z)) return { x, z };
  for (let r = 0.5; r <= 12; r += 0.5) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const nx = x + Math.cos(a) * r;
      const nz = z + Math.sin(a) * r;
      if (!isBlockedAt(nx, nz)) return { x: nx, z: nz };
    }
  }
  return { x, z };
}
function landNow() {
  local.peek = 0;
  peekBlend = 0;
  camera.rotation.z = 0;
  const spot = findFreeSpotLocal(local.x, local.z, local.groundY);
  local.x = spot.x;
  local.z = spot.z;
  local.groundY = standingHeightAt(local.x, local.z, local.groundY);
  stopLoop("wind", 0.6);
  setMode("ground");
  grounded = true;
  verticalSpeed = 0;
  jumpOffset = 0;
  local.jumping = false;
  camera.rotation.z = 0;
  camera.rotation.x = clamp(camera.rotation.x, -0.25, 0.25);
  camera.fov = baseFov;
  camera.updateProjectionMatrix();
  send({ type: "land", x: local.x, y: local.groundY, z: local.z });
  playLanding(null);
  showLootToast("ĐÃ TIẾP ĐẤT · CẦM SÚNG SẴN SÀNG");
}
// Đang ngồi trên máy bay: camera đứng đúng chỗ của mình trong khoang, tự do nhìn quanh.
function updatePlane() {
  if (!plane) return;
  const pos = seatWorld(local.seat, planeTime());
  local.x = pos.x;
  local.z = pos.z;
  local.y = plane.alt;
  const now = performance.now();
  const shake = Math.sin(now / 38) * 0.006 + Math.sin(now / 210) * 0.012;
  camera.position.set(local.x, local.y + 1.62 + shake, local.z);
  camera.rotation.z = 0;
  setLoopGain(audioLoops.plane, 0.75 * sfxLevel(), 0.2);
}
// Rơi tự do và dù: WASD bay ngang theo hướng nhìn, Shift lao nhanh, Space bung dù.
function updateAir(dt) {
  const chute = local.state === "parachute";
  airState.time += dt;
  const input = !paused;
  const f = input ? (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0) : 0;
  const r = input ? (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0) : 0;
  const dive = !chute && input && Boolean(keys.ShiftLeft || keys.ShiftRight);
  const cap = chute ? AIR.chuteHoriz : dive ? AIR.diveHoriz : AIR.freefallHoriz;
  const fx = -Math.sin(local.yaw),
    fz = -Math.cos(local.yaw),
    rx = Math.cos(local.yaw),
    rz = -Math.sin(local.yaw);
  const dx = fx * f + rx * r,
    dz = fz * f + rz * r;
  const len = Math.hypot(dx, dz);
  const follow = Math.min(1, (chute ? 1.8 : 2.6) * dt);
  airState.vx += ((len ? (dx / len) * cap : 0) - airState.vx) * follow;
  airState.vz += ((len ? (dz / len) * cap : 0) - airState.vz) * follow;
  // Vận tốc rơi: tăng dần tới tốc độ rơi tự do; bung dù thì giảm mượt xuống rất chậm.
  const targetFall = chute
    ? AIR.chuteFall
    : dive
      ? AIR.diveFall
      : AIR.freefallFall;
  if (chute) {
    airState.fall += (targetFall - airState.fall) * Math.min(1, 2.4 * dt);
  } else {
    const diff = targetFall - airState.fall;
    const accel = diff > 0 ? AIR.gravity : 30;
    airState.fall += Math.sign(diff) * Math.min(Math.abs(diff), accel * dt);
  }
  local.x = clamp(local.x + airState.vx * dt, -MAP_HALF + 0.5, MAP_HALF - 0.5);
  local.z = clamp(local.z + airState.vz * dt, -MAP_HALF + 0.5, MAP_HALF - 0.5);
  const previousY = local.y;
  const approachGround = landingHeightAt(local.x, local.z, previousY);
  if (
    !chute &&
    local.y - approachGround <= AIR.autoDeployAlt &&
    airState.time > 0.4
  )
    deployChute(true);
  local.y -= airState.fall * dt;
  const ground = landingHeightAt(local.x, local.z, previousY);
  if (local.y <= ground) {
    local.y = ground;
    local.groundY = ground;
    camera.position.set(local.x, local.y + 1.6, local.z);
    landNow();
    return;
  }
  camera.position.set(local.x, local.y + 1.6, local.z);
  camera.rotation.z = chute
    ? Math.sin(performance.now() / 900) * 0.03 - r * 0.05
    : -r * 0.08;
  const targetFov = chute ? baseFov : baseFov + (dive ? 18 : 9);
  camera.fov += (targetFov - camera.fov) * Math.min(1, 5 * dt);
  camera.updateProjectionMatrix();
  updateWind(chute);
  if (Date.now() - lastMove > 50) {
    send({ type: "air", x: local.x, y: local.y, z: local.z, yaw: local.yaw });
    lastMove = Date.now();
  }
}
// Máy bay bay thẳng theo đường server đã chốt; cánh quạt quay, đèn nhảy đổi xanh khi vào zone.
function updatePlaneObject(dt) {
  if (planeCloudField) planeCloudField.visible = local.state === "plane";
  if (!planeObject) return;
  if (!plane) {
    planeObject.visible = false;
    return;
  }
  const t = planeTime();
  if (local.state === "plane" && t >= plane.tEnter && !jumpCuePlayed) {
    jumpCuePlayed = true;
    playJumpReadyBell();
  }
  planeObject.visible = t < plane.tExit + 25;
  if (!planeObject.visible) return;
  const pos = planePosAt(t);
  planeObject.position.set(pos.x, plane.alt, pos.z);
  planeObject.rotation.y = planeYaw();
  if (planeCloudField) {
    // Keep a dense cloud bank centered around the moving aircraft so every
    // direction outside the open cabin remains inside the cloud layer.
    planeCloudField.position.set(pos.x, plane.alt, pos.z);
  }
  for (const prop of planeObject.userData.props) prop.rotation.z += dt * 40;
  const canJump = t >= plane.tEnter && t < plane.tExit;
  const color = canJump ? 0x39ff6a : 0xff3028;
  const pulse =
    0.5 + 0.5 * Math.sin(performance.now() * (canJump ? 0.009 : 0.004));
  const { jumpLight, jumpGlow, jumpRing, jumpPointLight } =
    planeObject.userData;
  jumpLight.material.color.set(color);
  jumpLight.scale.setScalar(canJump ? 1.1 + pulse * 0.12 : 1);
  jumpGlow.material.color.set(color);
  jumpGlow.material.opacity = canJump
    ? 0.3 + pulse * 0.22
    : 0.12 + pulse * 0.08;
  jumpRing.material.color.set(canJump ? 0xd9ffe2 : 0xffd6cf);
  jumpPointLight.color.set(color);
  jumpPointLight.intensity = canJump ? 22 + pulse * 18 : 7 + pulse * 5;
}
// Người chơi khác: đứng trong khoang theo chỗ ngồi, hoặc lướt mượt tới vị trí bay mới nhất.
function updateRemoteMotion(dt) {
  const t = plane ? planeTime() : 0;
  const k = 1 - Math.exp(-14 * dt);
  for (const mesh of remoteMeshes.values()) {
    const ud = mesh.userData;
    if (ud.state === "plane" && plane) {
      const seat = seatWorld(ud.seat || 0, t);
      mesh.position.set(seat.x, plane.alt, seat.z);
      mesh.rotation.set(0, planeYaw(), 0);
    } else if (ud.airTarget) {
      mesh.position.x += (ud.airTarget.x - mesh.position.x) * k;
      mesh.position.y += (ud.airTarget.y - mesh.position.y) * k;
      mesh.position.z += (ud.airTarget.z - mesh.position.z) * k;
    }
    if (ud.chute?.visible)
      ud.chute.rotation.z = Math.sin(performance.now() / 700 + mesh.id) * 0.06;
  }
}

// Bản đồ vào trận luôn quang đãng; thời tiết (mưa rừng / bão cát sa mạc) chỉ
// xuất hiện sau một khoảng chờ ngẫu nhiên, kéo dài một khoảng ngẫu nhiên rồi
// tắt hẳn — không lặp lại — để mỗi trận là một mốc thời gian khác nhau.
const WEATHER_START_DELAY_RANGE = [25, 75]; // giây chờ trước khi thời tiết bắt đầu
const WEATHER_DURATION_RANGE = [30, 70]; // giây thời tiết kéo dài trước khi kết thúc

function randomBetween([min, max]) {
  return min + Math.random() * (max - min);
}

function scheduleWeather(forest) {
  clearTimeout(weatherTimer);
  weatherTimer = setTimeout(
    () => beginWeather(forest),
    randomBetween(WEATHER_START_DELAY_RANGE) * 1000,
  );
}

// Bản đồ vào trận luôn quang đãng; server quyết định lúc nào thời tiết (mưa
// rừng / bão cát sa mạc) bắt đầu và kết thúc, gửi qua cờ weatherActive trong
// state để mọi người trong phòng cùng thấy — không còn mỗi máy tự hẹn giờ
// riêng gây lệch nhau giữa các người chơi.
function beginWeather(forest) {
  if (!scene) return; // đã rời map trước khi state kịp tới
  createWeather(forest);
  startWeatherSound(forest ? "rain" : "sandstorm");
  applyBaseFog(forest, true);
}

function endWeather(forest) {
  stopLoop("weather", 0.6);
  if (weatherFx?.mesh) {
    scene?.remove(weatherFx.mesh);
    weatherFx.geometry.dispose();
    weatherFx.material.dispose();
  }
  weatherFx = null;
  applyBaseFog(forest, false);
}

// Trời xanh + sương mù xa khi ở trên cao; về màu đất và sương mù gần khi sắp chạm đất.
function createWeather(forest) {
  if (weatherFx?.mesh) {
    scene?.remove(weatherFx.mesh);
    weatherFx.geometry.dispose();
    weatherFx.material.dispose();
  }
  const count = forest ? 1000 : 1450;
  const itemSize = forest ? 6 : 3;
  const positions = new Float32Array(count * itemSize);
  const speed = new Float32Array(count);
  const drift = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const x = (Math.random() - 0.5) * 90;
    const y = forest ? Math.random() * 48 - 12 : Math.random() * 36 - 12;
    const z = (Math.random() - 0.5) * 90;
    const n = i * itemSize;
    positions[n] = x;
    positions[n + 1] = y;
    positions[n + 2] = z;
    if (forest) {
      positions[n + 3] = x + 0.18;
      positions[n + 4] = y - 0.9;
      positions[n + 5] = z + 0.12;
    }
    speed[i] = forest ? 32 + Math.random() * 20 : 5 + Math.random() * 17;
    drift[i] = forest ? 1.5 + Math.random() * 2.5 : 0.4 + Math.random() * 1.3;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.attributes.position.setUsage(THREE.DynamicDrawUsage);
  const material = forest
    ? new THREE.LineBasicMaterial({
        color: 0xc8d9dc,
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
      })
    : new THREE.PointsMaterial({
        color: 0xe0c79a,
        size: 0.12,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        sizeAttenuation: true,
      });
  const mesh = forest
    ? new THREE.LineSegments(geometry, material)
    : new THREE.Points(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  scene.add(mesh);
  weatherFx = {
    forest,
    count,
    positions,
    speed,
    drift,
    geometry,
    material,
    mesh,
  };
}
function updateWeather(dt) {
  if (!weatherFx || !camera) return;
  const { forest, count, positions, speed, drift, geometry, mesh } = weatherFx;
  mesh.position.copy(camera.position);
  for (let i = 0; i < count; i++) {
    const step = i * (forest ? 6 : 3);
    let x = positions[step],
      y = positions[step + 1],
      z = positions[step + 2];
    if (forest) {
      y -= speed[i] * dt;
      x += drift[i] * dt;
      if (y < -14) {
        x = (Math.random() - 0.5) * 90;
        y = 34 + Math.random() * 20;
        z = (Math.random() - 0.5) * 90;
      }
      positions[step] = x;
      positions[step + 1] = y;
      positions[step + 2] = z;
      positions[step + 3] = x + 0.18;
      positions[step + 4] = y - 0.9;
      positions[step + 5] = z + 0.12;
    } else {
      x += speed[i] * dt;
      y += Math.sin(performance.now() * 0.0007 + i) * drift[i] * dt;
      z += drift[i] * dt;
      if (x > 48) x -= 96;
      if (z > 48) z -= 96;
      positions[step] = x;
      positions[step + 1] = y;
      positions[step + 2] = z;
    }
  }
  geometry.attributes.position.needsUpdate = true;
}
function updateEnvironment(dt) {
  if (!scene || !camera) return;
  let target = 0;
  if (local.state === "plane") target = 1;
  else if (local.state === "freefall" || local.state === "parachute")
    target = clamp(
      (local.y - groundHeightAt(local.x, local.z) - 12) / 70,
      0,
      1,
    );
  envBlend += (target - envBlend) * Math.min(1, 4 * dt);
  const forest = mapId === "forest";
  tmpColorA.set(forest ? "#879c88" : "#ad9367");
  tmpColorB.set("#9cc9ea");
  scene.background.lerpColors(tmpColorA, tmpColorB, envBlend);
  scene.fog.color.copy(scene.background);
  scene.fog.near = fogBaseNear + (forest ? 260 : 170) * envBlend;
  scene.fog.far = fogBaseFar + (forest ? 700 : 430) * envBlend;
  const far = envBlend > 0.02 ? 1300 : 400;
  if (local.state === "plane") {
    // At 200 m altitude, a short pale fog range hides the terrain beneath the
    // aircraft while leaving nearby cabin details and nearby players visible.
    scene.background.set("#dce5e9");
    scene.fog.color.set("#dce5e9");
    scene.fog.near = 7;
    scene.fog.far = 86;
  }
  if (camera.far !== far) {
    camera.far = far;
    camera.updateProjectionMatrix();
  }
}
function updatePhaseOverlay() {
  const box = $("#phaseOverlay");
  if (!box) return;
  const waiting =
    (matchPhase === "staging" || matchPhase === "countdown") &&
    local.state === "lobby";
  box.classList.toggle("hidden", !waiting);
  if (!waiting) {
    lastCountdownNumber = null;
    return;
  }
  if (matchPhase === "staging") {
    const players = gameState?.players || [];
    const ready = players.filter((p) => p.ready).length;
    $("#phaseSmall").textContent = "PHÒNG CHỜ · ĐANG VÀO TRẬN";
    $("#phaseBig").textContent = "…";
    $("#phaseSub").textContent =
      `ĐÃ VÀO ${ready}/${players.length} NGƯỜI CHƠI · WASD DI CHUYỂN · CLICK ĐỂ KHÓA CHUỘT`;
    lastCountdownNumber = null;
    return;
  }
  const n = Math.max(1, Math.ceil((countdownEndsAt - serverNow()) / 1000));
  $("#phaseSmall").textContent = "TRẬN ĐẤU BẮT ĐẦU SAU";
  $("#phaseBig").textContent = n;
  $("#phaseSub").textContent = "CHUẨN BỊ LÊN MÁY BAY";
  if (n !== lastCountdownNumber) {
    lastCountdownNumber = n;
    tone(
      n === 1 ? 900 : 620,
      0.14,
      "sine",
      0.2 * ((Number($("#sfx").value) || 0) / 100),
    );
  }
}
function updateMatchClock() {
  const el = $("#matchClock");
  if (!el) return;
  if (local.state === "lobby") {
    el.textContent = "PHÒNG CHỜ";
    return;
  }
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  el.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
}
function updateFlightHud() {
  const hud = $("#flightHud");
  if (!hud || hud.classList.contains("hidden")) return;
  const st = local.state;
  const airborne = ["plane", "freefall", "parachute"].includes(st);
  $("#flightInfo").classList.toggle("hidden", !airborne);
  if (!airborne) {
    drawFlightMap();
    return;
  }
  const alt = Math.max(
    0,
    st === "plane"
      ? plane?.alt || 0
      : local.y - groundHeightAt(local.x, local.z),
  );
  $("#flightState").textContent =
    st === "plane"
      ? "TRÊN MÁY BAY"
      : st === "freefall"
        ? "ĐANG RƠI TỰ DO"
        : "ĐANG DÙ";
  $("#flightAlt").textContent =
    st === "plane"
      ? `ĐỘ CAO ${Math.round(alt)} M`
      : `ĐỘ CAO ${Math.round(alt)} M · ${Math.round(airState.fall)} M/S`;
  const hint = $("#flightHint");
  let text = "";
  let ok = false;
  if (st === "plane" && plane) {
    const t = planeTime();
    if (t < plane.tEnter)
      text = `CHƯA TỚI VÙNG NHẢY · ${(plane.tEnter - t).toFixed(1)}S`;
    else if (t < plane.tExit) {
      ok = true;
      text = `[SPACE] NHẢY DÙ · TỰ NHẢY SAU ${(plane.tExit - t).toFixed(1)}S`;
    } else text = "ĐANG TỰ ĐỘNG NHẢY...";
  } else if (st === "freefall")
    text = "[SPACE] BUNG DÙ · [SHIFT] LAO NHANH · WASD BAY NGANG";
  else text = "WASD ĐIỀU KHIỂN DÙ · TỰ HẠ CÁNH";
  hint.textContent = text;
  hint.classList.toggle("ok", ok);
  drawFlightMap();
}
function drawFlightMap() {
  // The map is detailed and only needs refreshing a few times per second.
  if (performance.now() - lastFlightMapDraw < 150) return;
  lastFlightMapDraw = performance.now();
  const canvas = $("#flightMap");
  const ctx = canvas?.getContext("2d");
  if (!ctx) return;
  const S = canvas.width;
  const k = S / (MAP_HALF * 2);
  const X = (x) => S / 2 + x * k;
  const Y = (z) => S / 2 + z * k;
  ctx.clearRect(0, 0, S, S);
  const forest = mapId === "forest";
  ctx.fillStyle = forest ? "#527d45" : "#b99a62";
  ctx.fillRect(0, 0, S, S);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, S, S);
  ctx.clip();
  // Subtle seeded terrain patches give the map a real overhead land texture.
  let seed = (gameState?.mapSeed || 1) >>> 0;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 90; i++) {
    const x = random() * S;
    const y = random() * S;
    const r = 3 + random() * 15;
    ctx.fillStyle = forest
      ? i % 2
        ? "rgba(144,181,91,.18)"
        : "rgba(29,77,43,.17)"
      : i % 2
        ? "rgba(238,207,133,.2)"
        : "rgba(106,78,46,.12)";
    ctx.beginPath();
    ctx.ellipse(
      x,
      y,
      r,
      r * (0.42 + random() * 0.38),
      random() * Math.PI,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  if (forest) {
    // Draw the same winding river and lake used by the forest level generator.
    const riverZ = (x) =>
      (-7 + Math.sin((x + 12 * MAP_SCALE) / (13 * MAP_SCALE)) * 13) * MAP_SCALE;
    ctx.lineCap = "round";
    for (const [color, width] of [
      ["#8a9b61", 15],
      ["#31899a", 9],
      ["#54b7b8", 3],
    ]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let i = 0; i <= 80; i++) {
        const x = -MAP_HALF + (i / 80) * MAP_HALF * 2;
        if (!i) ctx.moveTo(X(x), Y(riverZ(x)));
        else ctx.lineTo(X(x), Y(riverZ(x)));
      }
      ctx.stroke();
    }
    ctx.fillStyle = "#31899a";
    ctx.beginPath();
    ctx.ellipse(
      X(22 * MAP_SCALE),
      Y(-3 * MAP_SCALE),
      12 * MAP_SCALE * k,
      17 * MAP_SCALE * k,
      0.12,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  } else {
    // Curving contour bands represent the desert dunes from overhead.
    for (let band = 0; band < 7; band++) {
      ctx.strokeStyle =
        band % 2 ? "rgba(245,219,156,.28)" : "rgba(110,81,48,.18)";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let i = 0; i <= 60; i++) {
        const x = (i / 60) * S;
        const y = band * (S / 6) + Math.sin(i * 0.16 + band) * 5;
        if (!i) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
  const terrain = mapObstacles || [];
  // Roads appear as continuous clean tracks on the tactical map.
  ctx.lineCap = "round";
  for (const [color, factor] of [
    ["#b2a98c", 1.28],
    ["#4f514b", 1],
  ]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, 9 * k * factor);
    ctx.beginPath();
    for (const road of terrain) {
      if (road.type !== "road") continue;
      const dx = (Math.sin(road.yaw || 0) * road.length) / 2;
      const dz = (Math.cos(road.yaw || 0) * road.length) / 2;
      ctx.moveTo(X(road.x - dx), Y(road.z - dz));
      ctx.lineTo(X(road.x + dx), Y(road.z + dz));
    }
    ctx.stroke();
  }
  // Elevation contours are underneath buildings, trees and rocks.
  for (const o of terrain)
    if (o.type === "hill") {
      const cx = X(o.x),
        cy = Y(o.z),
        rx = Math.max(4, o.w * k * 0.52),
        ry = Math.max(4, (o.length || o.w) * k * 0.52);
      // Opaque relief covers any road track below a mountain ridge.
      ctx.fillStyle = forest ? "#3f6838" : "#96764e";
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, o.yaw || 0, 0, Math.PI * 2);
      ctx.fill();
      for (let ring = 0; ring < 3; ring++) {
        ctx.strokeStyle = forest
          ? "rgba(218,226,153,.35)"
          : "rgba(230,199,139,.38)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(
          cx,
          cy,
          rx * (0.78 - ring * 0.18),
          ry * (0.78 - ring * 0.18),
          o.yaw || 0,
          0,
          Math.PI * 2,
        );
        ctx.stroke();
      }
    }
  for (const o of terrain) {
    const x = X(o.x),
      y = Y(o.z),
      size = Math.max(1.5, (o.w || 1) * k);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(o.yaw || 0);
    if (o.type === "road") {
      const coveredByHill = terrain.some(
        (hill) =>
          hill.type === "hill" &&
          Array.from({ length: 9 }, (_, i) => {
            const along = (i / 8 - 0.5) * o.length;
            const x = o.x + Math.sin(o.yaw || 0) * along;
            const z = o.z + Math.cos(o.yaw || 0) * along;
            return (
              ((x - hill.x) / (hill.w / 2)) ** 2 +
                ((z - hill.z) / ((hill.length || hill.w) / 2)) ** 2 <
              1
            );
          }).some(Boolean),
      );
      if (!coveredByHill) {
        ctx.strokeStyle = "rgba(226,216,179,.82)";
        ctx.lineWidth = Math.max(0.7, 0.8 * k);
        ctx.setLineDash([2.4 * k, 2.2 * k]);
        ctx.beginPath();
        const dx = Math.sin(o.yaw || 0) * o.length * 0.36;
        const dz = Math.cos(o.yaw || 0) * o.length * 0.36;
        ctx.moveTo(-dx, -dz);
        ctx.lineTo(dx, dz);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    } else if (o.type === "house" || o.type === "hut") {
      ctx.fillStyle = o.type === "house" ? "#675443" : "#8b704b";
      ctx.fillRect(-size * 0.48, -size * 0.38, size * 0.96, size * 0.76);
      ctx.strokeStyle = "#e4c895";
      ctx.lineWidth = 0.8;
      ctx.strokeRect(-size * 0.48, -size * 0.38, size * 0.96, size * 0.76);
      ctx.fillStyle = "#302e28";
      ctx.fillRect(-size * 0.08, size * 0.12, size * 0.16, size * 0.26);
    } else if (o.type === "tree") {
      ctx.fillStyle = "#234d31";
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.68, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#528746";
      ctx.beginPath();
      ctx.arc(-size * 0.18, -size * 0.2, size * 0.37, 0, Math.PI * 2);
      ctx.fill();
    } else if (o.type === "cactus" || o.type === "deadTree") {
      ctx.strokeStyle = o.type === "cactus" ? "#41663d" : "#514b3d";
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(0, size * 0.45);
      ctx.lineTo(0, -size * 0.5);
      ctx.moveTo(0, 0);
      ctx.lineTo(-size * 0.35, -size * 0.18);
      ctx.moveTo(0, size * 0.12);
      ctx.lineTo(size * 0.34, -size * 0.1);
      ctx.stroke();
    } else if (o.type === "rock") {
      ctx.fillStyle = forest ? "#737a61" : "#75664e";
      ctx.beginPath();
      ctx.ellipse(0, 0, size * 0.62, size * 0.43, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.2)";
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }
    ctx.restore();
  }
  // A light coordinate grid and the border show the playable map limits.
  ctx.strokeStyle = "rgba(236,239,209,.12)";
  ctx.lineWidth = 0.7;
  for (let n = -1; n <= 1; n++) {
    ctx.beginPath();
    ctx.moveTo(X((n * MAP_HALF) / 2), 0);
    ctx.lineTo(X((n * MAP_HALF) / 2), S);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, Y((n * MAP_HALF) / 2));
    ctx.lineTo(S, Y((n * MAP_HALF) / 2));
    ctx.stroke();
  }
  ctx.strokeStyle = forest ? "#c8f27a" : "#f3d38c";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, S - 2, S - 2);
  const zoneCircle = zoneCircleNow();
  if (zoneCircle) {
    const zx = X(zoneCircle.x),
      zy = Y(zoneCircle.z),
      zr = Math.max(0, zoneCircle.radius * k);
    // Vùng ngoài vòng an toàn tô đỏ mờ.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, S, S);
    ctx.moveTo(zx + zr, zy);
    ctx.arc(zx, zy, zr, 0, Math.PI * 2, true);
    ctx.closePath();
    ctx.fillStyle = "rgba(150,20,20,.38)";
    ctx.fill("evenodd");
    ctx.restore();
    ctx.beginPath();
    ctx.arc(zx, zy, zr, 0, Math.PI * 2);
    ctx.strokeStyle = "#6fd8ff";
    ctx.lineWidth = 2;
    ctx.stroke();
    // Show the upcoming circle during the waiting phase as well, before it starts shrinking.
    const nextZone = gameState.zone?.nextCenter
      ? { center: gameState.zone.nextCenter, radius: gameState.zone.nextRadius }
      : gameState.zone?.phase === "shrink"
        ? { center: gameState.zone.toCenter, radius: gameState.zone.toRadius }
        : null;
    if (nextZone) {
      const tx = X(nextZone.center.x),
        ty = Y(nextZone.center.z),
        tr = Math.max(0, nextZone.radius * k);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = gameState.zone.phase === "wait" ? "#d6ff45" : "#ffffff";
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      ctx.arc(tx, ty, tr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  const dot = (x, z, radius, color) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(
      clamp(X(x), 5, S - 5),
      clamp(Y(z), 5, S - 5),
      radius,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  };
  const line = (t0, t1, color, width, dash) => {
    const a = planePosAt(t0);
    const b = planePosAt(t1);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(X(a.x), Y(a.z));
    ctx.lineTo(X(b.x), Y(b.z));
    ctx.stroke();
    ctx.setLineDash([]);
  };
  const planeMarker = (x, z) => {
    const angle = Math.atan2(plane.dx, -plane.dz);
    ctx.save();
    ctx.translate(clamp(X(x), 7, S - 7), clamp(Y(z), 7, S - 7));
    ctx.rotate(angle);
    ctx.beginPath();
    // Aircraft silhouette points forward along local -Y.
    ctx.moveTo(0, -8);
    ctx.lineTo(2, -2);
    ctx.lineTo(7, 2);
    ctx.lineTo(7, 4);
    ctx.lineTo(1.5, 3);
    ctx.lineTo(1.5, 7);
    ctx.lineTo(4, 8);
    ctx.lineTo(4, 9);
    ctx.lineTo(0, 8);
    ctx.lineTo(-4, 9);
    ctx.lineTo(-4, 8);
    ctx.lineTo(-1.5, 7);
    ctx.lineTo(-1.5, 3);
    ctx.lineTo(-7, 4);
    ctx.lineTo(-7, 2);
    ctx.lineTo(-2, -2);
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#172016";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  };
  if (plane) {
    line(0, plane.tExit + 8, "rgba(255,255,255,.35)", 1, [3, 3]);
    line(plane.tEnter, plane.tExit, "#5dff8a", 2.5, []);
    const pos = planePosAt(planeTime());
    planeMarker(pos.x, pos.z);
  }
  for (const p of gameState?.players || [])
    if (
      p.id !== playerId &&
      (p.state === "freefall" || p.state === "parachute")
    )
      dot(p.x, p.z, 3, "#ff7a5c");
  const me =
    local.state === "plane" && plane
      ? planePosAt(planeTime())
      : { x: local.x, z: local.z };

  // Cone thể hiện vùng nhìn của người chơi trên minimap.
  if (local.state === "ground") {
    const viewDistance = 18; // độ dài vùng nhìn, mét
    const viewAngle = Math.PI / 3; // góc nhìn tổng cộng = 60°

    // local.yaw = 0 nhìn về -Z.
    // Trên canvas minimap: X -> ngang, Z -> dọc.
    const forwardX = -Math.sin(local.yaw);
    const forwardZ = -Math.cos(local.yaw);

    // Góc hướng nhìn trên canvas.
    const centerAngle = Math.atan2(forwardZ, forwardX);

    const startAngle = centerAngle - viewAngle / 2;
    const endAngle = centerAngle + viewAngle / 2;

    const px = X(me.x);
    const py = Y(me.z);
    const radius = viewDistance * k;

    ctx.save();

    // Vùng nhìn
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.arc(px, py, radius, startAngle, endAngle);
    ctx.closePath();

    ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
    ctx.fill();

    // Viền cone nhẹ
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.arc(px, py, radius, startAngle, endAngle);
    ctx.closePath();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.65)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.restore();
  }

  if (local.state !== "plane") dot(me.x, me.z, 3.5, "#ffffff");
  ctx.restore();
}
// Dây dù góc nhìn thứ nhất: hai bó dây từ tay nắm (2 bên, gần) toả lên hai bên khung
// hình rồi khuất khỏi mép trên, đúng như một người đang treo mình dưới tán dù nhìn ra.
// Tán dù thật vẫn được dựng trong cảnh 3D (buildChute) để người chơi khác nhìn thấy.
function buildChuteOverlay() {
  const W = 1000,
    H = 560;
  // Tứ giác thon dần mô phỏng một sợi dây có độ dày (to ở tay, mảnh dần lên cao).
  const cord = (p0, p1, w0, w1, fill, opacity) => {
    const dx = p1[0] - p0[0],
      dz = p1[1] - p0[1];
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * 0.5,
      nz = (dx / len) * 0.5;
    const a = [p0[0] + nx * w0, p0[1] + nz * w0];
    const b = [p1[0] + nx * w1, p1[1] + nz * w1];
    const c = [p1[0] - nx * w1, p1[1] - nz * w1];
    const d = [p0[0] - nx * w0, p0[1] - nz * w0];
    return `<polygon points="${a[0].toFixed(1)},${a[1].toFixed(1)} ${b[0].toFixed(1)},${b[1].toFixed(1)} ${c[0].toFixed(1)},${c[1].toFixed(1)} ${d[0].toFixed(1)},${d[1].toFixed(1)}" fill="${fill}" opacity="${opacity}"/>`;
  };
  const side = (mirror) => {
    // Tay nắm (toggle) đặt gần mép dưới, lệch hẳn về một bên khung hình.
    const hand = [mirror ? W - 175 : 175, H - 55];
    const wristA = [mirror ? W - 40 : 40, H + 60];
    const wristB = [mirror ? W - 235 : 235, H + 90];
    let out = "";
    // Cẳng tay khuất dần xuống mép dưới, giữ cảm giác đang nắm dây bằng hai tay.
    out += cord(hand, wristA, 46, 70, "#171913", 0.9);
    out += cord(hand, wristB, 46, 70, "#171913", 0.9);
    out += `<ellipse cx="${hand[0]}" cy="${hand[1]}" rx="30" ry="20" fill="#2a2d24"/>`;
    out += `<rect x="${(mirror ? hand[0] - 34 : hand[0] - 2).toFixed(1)}" y="${(hand[1] - 12).toFixed(1)}" width="36" height="24" rx="6" fill="#e8622c" opacity=".92"/>`;
    // Bó dây chính: nhiều sợi từ tay toả lên, khuất khỏi mép trên màn hình.
    const n = 7;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const spread = mirror ? W - (60 + t * 260) : 60 + t * 260;
      const top = [spread, -30 - t * 40];
      out += cord(hand, top, 7, 1, "#20221c", 0.85);
      out += cord(hand, top, 2.4, 0.4, "#efe9d8", 0.5);
    }
    // Mép tán dù màu cam thấp thoáng ở góc trên, gợi ý tán dù đang căng phía trên đầu.
    out += `<polygon points="${mirror ? `${W},-20 ${W - 260},-20 ${W - 60},70` : `0,-20 260,-20 60,70`}" fill="#e8622c" opacity=".22"/>`;
    return out;
  };
  return (
    `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMax slice">` +
    side(false) +
    side(true) +
    `</svg>`
  );
}
function buildChute() {
  const g = new THREE.Group();
  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(1.9, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({
      color: "#e8622c",
      roughness: 0.8,
      side: THREE.DoubleSide,
    }),
  );
  canopy.scale.y = 0.62;
  canopy.position.y = 3.9;
  g.add(canopy);
  const points = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    points.push(
      new THREE.Vector3(Math.cos(a) * 1.9, 3.9, Math.sin(a) * 1.9),
      new THREE.Vector3(0, 1.5, 0),
    );
  }
  g.add(
    new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: 0xf1f1e6 }),
    ),
  );
  return g;
}
// Máy bay vận tải đơn giản: khoang hở hai bên (thấp) để nhìn ra map, cánh cao, hai cánh quạt.
function buildPlaneCloudField() {
  const field = new THREE.Group();
  const count = 168;
  const puffs = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 10, 7),
    new THREE.MeshStandardMaterial({
      color: "#f1f5f6",
      roughness: 1,
      transparent: true,
      opacity: 0.94,
      depthWrite: false,
      fog: true,
    }),
    count,
  );
  const dummy = new THREE.Object3D();
  // Fixed seeded placement avoids rebuilding random clouds every frame.
  let seed = 0x51f15e;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    const angle = random() * Math.PI * 2;
    // Leave an aircraft-sized opening around the center so cloud geometry
    // stays outside the open cabin instead of clipping through its floor.
    const radius = 55 + Math.sqrt(random()) * 100;
    dummy.position.set(
      Math.cos(angle) * radius,
      -23 + random() * 58,
      Math.sin(angle) * radius,
    );
    dummy.rotation.set(0, random() * Math.PI, 0);
    const broad = 17 + random() * 23;
    dummy.scale.set(broad, 7 + random() * 8, 15 + random() * 22);
    dummy.updateMatrix();
    puffs.setMatrixAt(i, dummy.matrix);
  }
  puffs.instanceMatrix.needsUpdate = true;
  puffs.computeBoundingSphere();
  puffs.renderOrder = 2;
  field.add(puffs);
  field.visible = false;
  return field;
}

function buildPlane() {
  const g = new THREE.Group();
  const hull = makeMat("#c9cdc4"),
    dark = makeMat("#3a3f36"),
    wing = makeMat("#aeb3a8"),
    accent = makeMat("#d9a441"),
    metal = makeMat("#6a6f66");
  const box = (w, h, d, x, y, z, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  box(3.4, 0.2, 10.4, 0, -0.1, 1.9, dark); // sàn khoang
  box(3.4, 0.14, 10.4, 0, 2.6, 1.9, hull); // trần
  for (const side of [-1, 1]) {
    box(0.14, 0.95, 10.4, side * 1.7, 0.47, 1.9, hull); // thành thấp
    box(0.16, 0.16, 10.4, side * 1.7, 0.95, 1.9, accent); // thanh vịn
    for (const z of [-3.2, -0.2, 2.8, 5.8])
      box(0.14, 2.6, 0.14, side * 1.7, 1.3, z, hull); // cột
  }
  box(3.4, 2.6, 0.14, 0, 1.3, 7.05, hull); // vách sau
  box(3.4, 2.6, 0.14, 0, 1.3, -3.3, hull); // vách trước (buồng lái)
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(2.4, 0.9, 0.05),
    new THREE.MeshBasicMaterial({
      color: 0x9fd4ff,
      transparent: true,
      opacity: 0.55,
    }),
  );
  glass.position.set(0, 1.55, -3.4);
  g.add(glass);
  const noseGeo = new THREE.CylinderGeometry(0.7, 2.4, 5, 4);
  noseGeo.rotateY(Math.PI / 4);
  noseGeo.scale(1, 1, 0.8);
  const nose = new THREE.Mesh(noseGeo, hull);
  nose.rotation.x = -Math.PI / 2;
  nose.position.set(0, 1.25, -5.8);
  g.add(nose);
  const tailGeo = new THREE.CylinderGeometry(0.6, 1.7, 5, 4);
  tailGeo.rotateY(Math.PI / 4);
  tailGeo.scale(1, 1, 0.8);
  const tail = new THREE.Mesh(tailGeo, hull);
  tail.rotation.x = Math.PI / 2;
  tail.position.set(0, 1.25, 9.6);
  g.add(tail);
  box(0.22, 3.2, 2.4, 0, 3.4, 11.2, hull); // vây đuôi đứng
  box(7.2, 0.18, 1.6, 0, 2.6, 11.4, wing); // cánh đuôi ngang
  box(17, 0.28, 3.6, 0, 3.05, 0.8, wing); // cánh chính (cao)
  box(0.3, 0.45, 3, -0.9, 2.85, 0.8, metal);
  box(0.3, 0.45, 3, 0.9, 2.85, 0.8, metal);
  const props = [];
  for (const side of [-1, 1]) {
    const nacelle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.42, 2.2, 10),
      metal,
    );
    nacelle.rotation.x = Math.PI / 2;
    nacelle.position.set(side * 5.2, 3.0, -0.8);
    g.add(nacelle);
    const prop = new THREE.Group();
    prop.position.set(side * 5.2, 3.0, -1.95);
    prop.add(
      new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.8, 0.06), dark),
      new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.2, 0.06), dark),
      new THREE.Mesh(
        new THREE.CircleGeometry(1.4, 20),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.12,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      ),
    );
    g.add(prop);
    props.push(prop);
  }
  const jumpLight = new THREE.Mesh(
    new THREE.BoxGeometry(0.48, 0.48, 0.16),
    new THREE.MeshBasicMaterial({ color: 0xff3028, toneMapped: false }),
  );
  jumpLight.position.set(0, 2.3, -3.2);
  g.add(jumpLight);
  const jumpGlow = new THREE.Mesh(
    new THREE.SphereGeometry(0.72, 12, 10),
    new THREE.MeshBasicMaterial({
      color: 0xff3028,
      transparent: true,
      opacity: 0.18,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  jumpGlow.position.copy(jumpLight.position);
  g.add(jumpGlow);
  const jumpRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.48, 0.045, 8, 24),
    new THREE.MeshBasicMaterial({ color: 0xffd6cf, toneMapped: false }),
  );
  jumpRing.position.copy(jumpLight.position);
  g.add(jumpRing);
  const jumpPointLight = new THREE.PointLight(0xff3028, 10, 24, 2);
  jumpPointLight.position.copy(jumpLight.position);
  g.add(jumpPointLight);
  g.userData = { props, jumpLight, jumpGlow, jumpRing, jumpPointLight };
  return g;
}
// Đất quanh map (chỉ để nhìn từ trên cao) và bức tường zone mờ bao quanh khu chơi.
function addOutskirts(forest) {
  const mat = makeMat(forest ? "#2f5232" : "#8f7650");
  const far = 1600,
    edge = MAP_HALF + 5;
  const strip = (w, d, x, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, -0.02, z);
    scene.add(m);
  };
  const mid = edge + (far - edge) / 2;
  strip(far * 2, far - edge, 0, -mid);
  strip(far * 2, far - edge, 0, mid);
  strip(far - edge, edge * 2, -mid, 0);
  strip(far - edge, edge * 2, mid, 0);
}
function addZoneBorder() {
  const mat = new THREE.MeshBasicMaterial({
    color: 0x66ccff,
    transparent: true,
    opacity: 0.1,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const wall = (x, z, ry) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(MAP_HALF * 2, 40), mat);
    m.position.set(x, 20, z);
    m.rotation.y = ry;
    scene.add(m);
  };
  wall(0, -MAP_HALF, 0);
  wall(0, MAP_HALF, 0);
  wall(-MAP_HALF, 0, Math.PI / 2);
  wall(MAP_HALF, 0, Math.PI / 2);
  const corners = [
    [-MAP_HALF, -MAP_HALF],
    [MAP_HALF, -MAP_HALF],
    [MAP_HALF, MAP_HALF],
    [-MAP_HALF, MAP_HALF],
    [-MAP_HALF, -MAP_HALF],
  ].map(([x, z]) => new THREE.Vector3(x, 0.15, z));
  scene.add(
    new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(corners),
      new THREE.LineBasicMaterial({ color: 0x8fe0ff }),
    ),
  );
}
// Vòng bo an toàn: tường trụ trong suốt đặt đúng vị trí/bán kính thật của vòng
// (không chỉ trên minimap), cùng viền sáng sát đất cho dễ thấy khi tới gần.
// Vị trí/kích thước được chỉnh lại mỗi khung hình trong updateZoneWorld().
function addSafeZoneWall() {
  zoneWallMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 70, 96, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0x66ccff,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  zoneWallMesh.position.y = 35;
  zoneWallMesh.visible = false;
  scene.add(zoneWallMesh);
  const ringPoints = [];
  for (let i = 0; i <= 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    ringPoints.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
  }
  const ringGeometry = new THREE.BufferGeometry().setFromPoints(ringPoints);
  const edgeLine = new THREE.LineLoop(
    ringGeometry,
    new THREE.LineBasicMaterial({ color: 0x8fe0ff }),
  );
  edgeLine.position.y = 0.18;
  edgeLine.visible = false;
  scene.add(edgeLine);
  zoneWallMesh.userData.edgeLine = edgeLine;
  // Viền vòng đích (đang thu hẹp tới đâu) — nét đứt trắng, nằm sát mặt đất.
  zoneTargetLine = new THREE.LineLoop(
    ringGeometry,
    new THREE.LineDashedMaterial({
      color: 0xffffff,
      dashSize: 2,
      gapSize: 1.4,
    }),
  );
  zoneTargetLine.computeLineDistances();
  zoneTargetLine.position.y = 0.2;
  zoneTargetLine.visible = false;
  scene.add(zoneTargetLine);
}
// ---------------------------------------------------------------------------
// ÂM THANH TRÊN KHÔNG: tiếng máy bay, gió, bung dù, tiếp đất
// ---------------------------------------------------------------------------
// Tiếng máy bay và tiếng gió là âm lặp liên tục (loop) nên tạo bằng node riêng,
// âm lượng bám theo thanh "Âm lượng hiệu ứng". Bung dù / tiếp đất dùng lại spatialAudio.
function ensureAudio() {
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}
function playCarHorn(position = null) {
  const audio = spatialAudio(position, { volume: 0.78, ref: 5, max: 85 });
  if (!audio) return;
  const ctx = ensureAudio();
  for (const [frequency, detune] of [
    [350, 0],
    [440, -7],
  ]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(frequency, audio.t0);
    osc.detune.setValueAtTime(detune, audio.t0);
    gain.gain.setValueAtTime(0.0001, audio.t0);
    gain.gain.linearRampToValueAtTime(0.42, audio.t0 + 0.045);
    gain.gain.setValueAtTime(0.36, audio.t0 + 0.48);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.t0 + 0.72);
    osc.connect(gain);
    gain.connect(audio.input);
    osc.start(audio.t0);
    osc.stop(audio.t0 + 0.74);
  }
}
function updateVehicleEngineAudio(vehicle, groundY) {
  // Không tạo lại âm thanh sau khi trận đã kết thúc.
  if (gameState?.phase === "finished") return;
  if (!audioCtx) return;
  let nodes = vehicleAudioNodes.get(vehicle.id);
  if (!nodes) {
    const ctx = audioCtx;
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "linear";
    panner.rolloffFactor = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 650;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const low = ctx.createOscillator(),
      high = ctx.createOscillator();
    low.type = "sawtooth";
    high.type = "triangle";
    low.frequency.value = 55;
    high.frequency.value = 83;
    low.connect(filter);
    high.connect(filter);
    filter.connect(panner);
    panner.connect(gain);
    gain.connect(ctx.destination);
    low.start();
    high.start();
    nodes = { panner, filter, gain, low, high };
    vehicleAudioNodes.set(vehicle.id, nodes);
  }
  const cameraPosition =
    camera?.getWorldPosition(new THREE.Vector3()) || new THREE.Vector3();
  const distance = Math.hypot(
    vehicle.x - cameraPosition.x,
    groundY + 0.5 - cameraPosition.y,
    vehicle.z - cameraPosition.z,
  );
  const occupied = gameState?.players?.some(
    (player) => player.vehicleId === vehicle.id,
  );
  const loudness =
    !soundOn || vehicle.destroyed || vehicle.submerged || !occupied
      ? 0
      : (0.34 + Math.min(0.28, Math.abs(vehicle.speed) * 0.014)) *
        sfxLevel() *
        distanceGain(distance, 5, 85);
  const now = audioCtx.currentTime;
  nodes.gain.gain.setTargetAtTime(loudness, now, 0.08);
  nodes.low.frequency.setTargetAtTime(
    48 + Math.abs(vehicle.speed) * 5.8,
    now,
    0.08,
  );
  nodes.high.frequency.setTargetAtTime(
    76 + Math.abs(vehicle.speed) * 8.2,
    now,
    0.08,
  );
  nodes.filter.frequency.setTargetAtTime(
    360 + Math.abs(vehicle.speed) * 42,
    now,
    0.08,
  );
  if (nodes.panner.positionX) {
    nodes.panner.positionX.setTargetAtTime(vehicle.x, now, 0.08);
    nodes.panner.positionY.setTargetAtTime(groundY + 0.5, now, 0.08);
    nodes.panner.positionZ.setTargetAtTime(vehicle.z, now, 0.08);
  } else nodes.panner.setPosition(vehicle.x, groundY + 0.5, vehicle.z);
}
function playVehicleSmokeAudio(vehicle) {
  const position = {
    x: vehicle.x,
    y: groundHeightAt(vehicle.x, vehicle.z) + 1.2,
    z: vehicle.z,
  };
  const audio = spatialAudio(position, { volume: 0.55, ref: 5, max: 75 });
  if (!audio) return;
  noiseBurst(audio, {
    duration: 0.62,
    filter: "lowpass",
    freq: 520,
    q: 0.7,
    gain: 0.9,
  });
  toneBurst(audio, {
    duration: 0.42,
    type: "triangle",
    from: 78,
    to: 48,
    gain: 0.45,
  });
}
function playVehicleExplosionAudio(vehicle) {
  const position = {
    x: vehicle.x,
    y: groundHeightAt(vehicle.x, vehicle.z) + 0.8,
    z: vehicle.z,
  };
  const audio = spatialAudio(position, { volume: 1, ref: 9, max: 120 });
  if (!audio) return;
  noiseBurst(audio, {
    duration: 0.78,
    filter: "lowpass",
    freq: 420,
    gain: 1.2,
  });
  noiseBurst(audio, {
    duration: 0.22,
    filter: "highpass",
    freq: 1100,
    gain: 0.85,
  });
  toneBurst(audio, {
    duration: 0.7,
    type: "sawtooth",
    from: 92,
    to: 28,
    gain: 0.9,
  });
}
function updateVehicleFireAudio(vehicle, y) {
  if (gameState?.phase === "finished") return;
  if (!audioCtx && (!soundOn || sfxLevel() <= 0)) return;
  const ctx = ensureAudio();
  let nodes = vehicleFireAudioNodes.get(vehicle.id);
  if (!nodes) {
    if (!soundOn || sfxLevel() <= 0) return;
    const source = ctx.createBufferSource();
    source.buffer = ensureNoiseBuffer(ctx);
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1150;
    filter.Q.value = 0.42;
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "linear";
    panner.rolloffFactor = 0;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(filter);
    filter.connect(panner);
    panner.connect(gain);
    gain.connect(ctx.destination);
    source.start();
    nodes = { source, filter, panner, gain };
    vehicleFireAudioNodes.set(vehicle.id, nodes);
  }
  const cameraPosition =
    camera?.getWorldPosition(new THREE.Vector3()) || new THREE.Vector3();
  const distance = Math.hypot(
    vehicle.x - cameraPosition.x,
    y + 1 - cameraPosition.y,
    vehicle.z - cameraPosition.z,
  );
  const loudness = soundOn
    ? 0.13 * sfxLevel() * distanceGain(distance, 5, 95)
    : 0;
  const now = ctx.currentTime;
  nodes.gain.gain.setTargetAtTime(loudness, now, 0.12);
  if (nodes.panner.positionX) {
    nodes.panner.positionX.setTargetAtTime(vehicle.x, now, 0.12);
    nodes.panner.positionY.setTargetAtTime(y + 1, now, 0.12);
    nodes.panner.positionZ.setTargetAtTime(vehicle.z, now, 0.12);
  } else nodes.panner.setPosition(vehicle.x, y + 1, vehicle.z);
}
function stopVehicleFireAudio(fade = 0.08) {
  const now = audioCtx?.currentTime ?? 0;
  for (const nodes of vehicleFireAudioNodes.values()) {
    try {
      nodes.gain.gain.cancelScheduledValues(now);
      nodes.gain.gain.setTargetAtTime(0, now, Math.max(0.005, fade / 4));
      nodes.source.stop(now + fade);
      setTimeout(
        () => {
          try {
            nodes.source.disconnect();
            nodes.filter.disconnect();
            nodes.panner.disconnect();
            nodes.gain.disconnect();
          } catch {}
        },
        Math.max(50, fade * 1000 + 30),
      );
    } catch {}
  }
  vehicleFireAudioNodes.clear();
}
function stopVehicleEngineAudio(fade = 0.08) {
  if (!vehicleAudioNodes.size) return;
  const stopAt = audioCtx?.currentTime ?? 0;
  for (const nodes of vehicleAudioNodes.values()) {
    try {
      nodes.gain.gain.cancelScheduledValues(stopAt);
      nodes.gain.gain.setTargetAtTime(0, stopAt, Math.max(0.005, fade / 4));
      const stopOscillator = (oscillator) => {
        try {
          oscillator.stop(stopAt + fade);
          oscillator.onended = () => oscillator.disconnect();
        } catch {}
      };
      stopOscillator(nodes.low);
      stopOscillator(nodes.high);
      setTimeout(
        () => {
          try {
            nodes.low.disconnect();
            nodes.high.disconnect();
            nodes.filter.disconnect();
            nodes.panner.disconnect();
            nodes.gain.disconnect();
          } catch {}
        },
        Math.max(50, fade * 1000 + 30),
      );
    } catch {}
  }
  vehicleAudioNodes.clear();
}
const sfxLevel = () =>
  soundOn
    ? ((Number($("#sfx").value) || 0) / 100) *
      ((Number($("#masterVolume").value) || 0) / 100)
    : 0;
function applyAudioSettings() {
  syncHomeMusic();
  setLoopGain(audioLoops.plane, 0.55 * sfxLevel(), 0.1);
  if (audioLoops.weather)
    setLoopGain(
      audioLoops.weather,
      (audioLoops.weather.kind === "rain" ? 0.2 : 0.25) * sfxLevel(),
      0.12,
    );
  if (audioLoops.wind) updateWind(local.state === "parachute");
}
syncPauseSettings();
saveSettings();
applyGraphicsSettings();
applyAudioSettings();
function loopBuffer(kind) {
  if (loopBuffers[kind]) return loopBuffers[kind];
  const ctx = ensureAudio();
  const length = Math.floor(ctx.sampleRate * 3);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    if (kind === "brown") {
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    } else data[i] = white;
  }
  loopBuffers[kind] = buffer;
  return buffer;
}
function setLoopGain(loop, value, timeConstant = 0.15) {
  if (loop)
    loop.master.gain.setTargetAtTime(
      Math.max(0, value),
      audioCtx.currentTime,
      timeConstant,
    );
}
function stopLoop(name, fade = 1) {
  const loop = audioLoops[name];
  if (!loop) return;
  audioLoops[name] = null;
  loop.master.gain.setTargetAtTime(
    0,
    audioCtx.currentTime,
    Math.max(0.02, fade / 4),
  );
  setTimeout(
    () => {
      for (const node of loop.sources) {
        try {
          node.stop();
        } catch {
          /* đã dừng */
        }
      }
      try {
        loop.master.disconnect();
      } catch {
        /* đã ngắt */
      }
    },
    fade * 1000 + 250,
  );
}
function startWeatherSound(kind) {
  if (audioLoops.weather?.kind === kind) return;
  if (audioLoops.weather) stopLoop("weather", 0.08);
  const ctx = ensureAudio();
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);
  const sources = [];
  if (kind === "rain") {
    const rain = ctx.createBufferSource();
    rain.buffer = loopBuffer("white");
    rain.loop = true;
    const high = ctx.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 700;
    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = 7600;
    rain.connect(high);
    high.connect(low);
    low.connect(master);
    rain.start();
    sources.push(rain);
  } else {
    const gustNoise = ctx.createBufferSource();
    gustNoise.buffer = loopBuffer("brown");
    gustNoise.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 420;
    band.Q.value = 0.55;
    const gustGain = ctx.createGain();
    gustGain.gain.value = 1.4;
    const gustLayer = ctx.createGain();
    gustLayer.gain.value = 0.9;
    gustNoise.connect(band);
    band.connect(gustGain);
    gustGain.connect(gustLayer);
    gustLayer.connect(master);
    gustNoise.start();
    const oscillator = ctx.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.value = 0.22;
    const depth = ctx.createGain();
    depth.gain.value = 0.16;
    oscillator.connect(depth);
    depth.connect(gustLayer.gain);
    oscillator.start();
    sources.push(gustNoise, oscillator);
  }
  audioLoops.weather = { kind, master, sources };
  setLoopGain(
    audioLoops.weather,
    (kind === "rain" ? 0.2 : 0.25) * sfxLevel(),
    0.8,
  );
}
// Tiếng máy bay: tiếng ù trầm (brown noise) + hai dao động lệch tần số bị "băm" nhịp cánh quạt.
function startPlaneSound() {
  if (audioLoops.plane) return;
  const ctx = ensureAudio();
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);
  const sources = [];
  const rumble = ctx.createBufferSource();
  rumble.buffer = loopBuffer("brown");
  rumble.loop = true;
  const rumbleLow = ctx.createBiquadFilter();
  rumbleLow.type = "lowpass";
  rumbleLow.frequency.value = 260;
  const rumbleGain = ctx.createGain();
  rumbleGain.gain.value = 1.7;
  rumble.connect(rumbleLow);
  rumbleLow.connect(rumbleGain);
  rumbleGain.connect(master);
  sources.push(rumble);
  const drone = ctx.createGain();
  drone.gain.value = 0.2;
  const droneLow = ctx.createBiquadFilter();
  droneLow.type = "lowpass";
  droneLow.frequency.value = 420;
  for (const freq of [58, 61.3]) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = freq;
    osc.connect(droneLow);
    sources.push(osc);
  }
  droneLow.connect(drone);
  drone.connect(master);
  const chop = ctx.createOscillator();
  chop.frequency.value = 17;
  const chopDepth = ctx.createGain();
  chopDepth.gain.value = 0.12;
  chop.connect(chopDepth);
  chopDepth.connect(drone.gain);
  sources.push(chop);
  const draft = ctx.createBufferSource();
  draft.buffer = loopBuffer("white");
  draft.loop = true;
  const draftBand = ctx.createBiquadFilter();
  draftBand.type = "bandpass";
  draftBand.frequency.value = 900;
  draftBand.Q.value = 0.6;
  const draftGain = ctx.createGain();
  draftGain.gain.value = 0.09;
  draft.connect(draftBand);
  draftBand.connect(draftGain);
  draftGain.connect(master);
  sources.push(draft);
  for (const s of sources) s.start();
  audioLoops.plane = { master, sources };
  setLoopGain(audioLoops.plane, 0.55 * sfxLevel(), 0.4);
}
// Tiếng gió: nhiễu trắng qua bộ lọc dải, càng rơi nhanh càng to và chói; dù bung thì dịu lại.
function startWind() {
  if (audioLoops.wind) return;
  const ctx = ensureAudio();
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);
  const src = ctx.createBufferSource();
  src.buffer = loopBuffer("white");
  src.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 800;
  band.Q.value = 0.55;
  const low = ctx.createBiquadFilter();
  low.type = "lowpass";
  low.frequency.value = 5000;
  const gust = ctx.createOscillator();
  gust.frequency.value = 0.35;
  const gustDepth = ctx.createGain();
  gustDepth.gain.value = 180;
  gust.connect(gustDepth);
  gustDepth.connect(band.frequency);
  src.connect(band);
  band.connect(low);
  low.connect(master);
  src.start();
  gust.start();
  audioLoops.wind = { master, band, sources: [src, gust] };
}
function updateWind(chute) {
  const loop = audioLoops.wind;
  if (!loop) return;
  const speed = clamp(airState.fall / 45, 0, 1);
  const drift = clamp(Math.hypot(airState.vx, airState.vz) / 20, 0, 1);
  const intensity = chute
    ? 0.12 + speed * 0.25 + drift * 0.05
    : 0.1 + speed * 0.48;
  loop.band.frequency.setTargetAtTime(
    450 + 1900 * intensity,
    audioCtx.currentTime,
    0.1,
  );
  setLoopGain(
    loop,
    (0.1 + 0.9 * intensity * intensity) * 1.2 * sfxLevel(),
    0.12,
  );
}
function playChuteOpen(position) {
  const a = spatialAudio(position, { volume: 0.9, ref: 6, max: 80 });
  if (!a) return;
  noiseBurst(a, { duration: 0.08, filter: "highpass", freq: 2200, gain: 1.1 }); // tiếng vải dù bật mạnh
  toneBurst(a, { at: 0.01, duration: 0.11, from: 180, to: 95, gain: 0.85 }); // tiếng giật bung khóa dù
  noiseBurst(a, {
    at: 0.03,
    duration: 0.4,
    filter: "bandpass",
    freq: 700,
    q: 0.8,
    gain: 1,
  }); // vải phồng lên
  noiseBurst(a, {
    at: 0.2,
    duration: 0.25,
    filter: "bandpass",
    freq: 1400,
    q: 1.2,
    gain: 0.45,
  }); // vải sột soạt
  toneBurst(a, { at: 0.04, duration: 0.3, from: 140, to: 55, gain: 0.7 }); // cú giật nặng
}
function playLanding(position) {
  const a = spatialAudio(position, { volume: 0.9, ref: 3, max: 45 });
  if (!a) return;
  toneBurst(a, { duration: 0.22, from: 110, to: 42, gain: 0.95 }); // tiếng chạm đất
  noiseBurst(a, { duration: 0.2, filter: "lowpass", freq: 900, gain: 1 });
  noiseBurst(a, {
    at: 0.08,
    duration: 0.3,
    filter: "bandpass",
    freq: 500,
    q: 0.7,
    gain: 0.35,
  }); // dù xẹp xuống
}
function playJumpWhoosh() {
  const a = spatialAudio(null, { volume: 0.6 });
  if (!a) return;
  noiseBurst(a, {
    duration: 0.4,
    filter: "bandpass",
    freq: 1000,
    q: 0.6,
    gain: 1,
  });
}
function playJumpReadyBell() {
  if (!soundOn || sfxLevel() <= 0) return;
  const ctx = ensureAudio();
  const overall = sfxLevel();
  // Three bright ascending notes announce that the door is over the map.
  for (const [offset, frequency] of [
    [0, 880],
    [0.16, 1174],
    [0.34, 1568],
  ]) {
    const start = ctx.currentTime + offset;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(
      frequency * 0.985,
      start + 0.65,
    );
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(0.22 * overall, start + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.72);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.75);
  }
}
function frame() {
  if (!renderer || !$("#game").classList.contains("active")) return;
  const dt = Math.min(clock.getDelta(), 0.05);
  for (const mesh of remoteMeshes.values()) {
    const animTime = performance.now() / 1000;
    const ud = mesh.userData;
    const moving = ud.gaitDistance > 0.001;
    const gaitRate = ud.prone
      ? 0
      : ud.crouching
        ? 5
        : ud.slowWalking
          ? 5.2
          : 9.5;
    if (moving) ud.gaitPhase = (ud.gaitPhase || 0) + dt * gaitRate;
    const legSwing = moving
      ? Math.sin(ud.gaitPhase) * (ud.crouching ? 0.28 : 0.56)
      : 0;
    if (ud.legLeft)
      ud.legLeft.rotation.x +=
        (legSwing - ud.legLeft.rotation.x) * Math.min(12 * dt, 1);
    if (ud.legRight)
      ud.legRight.rotation.x +=
        (-legSwing - ud.legRight.rotation.x) * Math.min(12 * dt, 1);
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
  if (deathView) {
    if (gun) gun.visible = false;
    if (steeringWheel) steeringWheel.visible = false;
  }
  updatePhaseOverlay();
  updatePlaneObject(dt);
  updateRemoteMotion(dt);
  updateVehicleMeshes(dt);
  // Trên máy bay / đang nhảy dù thì mô phỏng riêng; chỉ ở phòng chờ hoặc mặt đất mới đi bộ.
  if (local.state === "plane") updatePlane();
  else if (local.state === "freefall" || local.state === "parachute")
    updateAir(dt);
  updateEnvironment(dt);
  updateWeather(dt);
  updateFlightHud();
  updateMatchClock();
  updateZoneHud();
  updateZoneWorld();
  if (!paused && local.vehicleId) {
    const now = Date.now();
    if (local.vehicleSeat === 0 && now - lastVehicleControlAt > 45) {
      send({
        type: "vehicleControl",
        throttle: keys.KeyW ? 1 : keys.KeyS ? -1 : 0,
        steer: (keys.KeyA ? 1 : 0) - (keys.KeyD ? 1 : 0),
        brake: Boolean(keys.Space),
      });
      lastVehicleControlAt = now;
    }
  } else if (!paused && (local.state === "ground" || local.state === "lobby")) {
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
    const previousX = local.x;
    const previousZ = local.z;
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
      !isBlockedAt(x, z) &&
      (!stayInWaterWhileSubmerged || waterAt(x, z) || isOnBridgeAt(x, z, 0.8));
    if (canMoveTo(local.x + moveX, local.z)) local.x += moveX;
    if (canMoveTo(local.x, local.z + moveZ)) local.z += moveZ;
    const traveled = Math.hypot(local.x - previousX, local.z - previousZ);
    const isMoving = traveled > 0.0005;
    const crouchWalking = isCrouching;
    const gaitRate = isProne
      ? 0
      : crouchWalking
        ? 5
        : isSlowWalking
          ? 5.2
          : 9.5;
    localGaitPhase =
      (localGaitPhase + dt * gaitRate * (isMoving ? 1 : 0)) % (Math.PI * 2);
    const swingAmount = isMoving ? (crouchWalking ? 0.25 : 0.52) : 0;
    if (localLegLeft)
      localLegLeft.rotation.x +=
        (Math.sin(localGaitPhase) * swingAmount - localLegLeft.rotation.x) *
        Math.min(12 * dt, 1);
    if (localLegRight)
      localLegRight.rotation.x +=
        (-Math.sin(localGaitPhase) * swingAmount - localLegRight.rotation.x) *
        Math.min(12 * dt, 1);
    if (isMoving && !currentlyInWater && !local.jumping) {
      localFootstepDistance += traveled;
      const stride = isProne
        ? 99
        : crouchWalking
          ? 1.8
          : isSlowWalking
            ? 2.1
            : 1.65;
      const intensity = crouchWalking ? 0.34 : isSlowWalking ? 0.22 : 0.82;
      while (localFootstepDistance >= stride) {
        playSpatialFootstep(
          local.x,
          local.groundY + 0.08,
          local.z,
          intensity,
          true,
        );
        localFootstepDistance -= stride;
      }
    } else if (!isMoving || currentlyInWater || local.jumping) {
      if (!isMoving)
        localFootstepDistance = Math.min(localFootstepDistance, 0.4);
    }
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
      if (keys.ShiftLeft || keys.ShiftRight) local.swimDepth += 2.2 * dt;
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
        (local.groundY = standingHeightAt(local.x, local.z, local.groundY)) +
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
    const peekTarget =
      !paused &&
      !backpackOpen &&
      !deathView &&
      !local.vehicleId &&
      local.state === "ground" &&
      grounded &&
      !local.jumping &&
      !local.swimming &&
      !local.prone
        ? keys.KeyE
          ? 1
          : keys.KeyQ
            ? -1
            : 0
        : 0;
    peekBlend += (peekTarget - peekBlend) * Math.min(1, 12 * dt);
    local.peek = peekBlend;
    if (local.state === "ground" && !local.vehicleId) {
      camera.position.x += Math.cos(local.yaw) * peekBlend * 0.28;
      camera.position.z -= Math.sin(local.yaw) * peekBlend * 0.28;
      camera.rotation.z = -peekBlend * 0.18;
    }
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
        peek: local.peek,
      });
      lastMove = Date.now();
    }
  }
  // if (recoilPitch > 0) {
  //   const recover = Math.min(recoilPitch, dt * 0.15);
  //   camera.rotation.x = Math.max(-1.35, camera.rotation.x - recover);
  //   recoilPitch -= recover;
  // }
  if (Math.abs(recoilYaw) > 0.0001) {
    const recoverYaw =
      Math.sign(recoilYaw) * Math.min(Math.abs(recoilYaw), dt * 0.06);
    recoilYaw -= recoverYaw;
    camera.rotation.y = local.yaw + recoilYaw;
  }
  if (deathView) {
    const focus = new THREE.Vector3(deathView.x, deathView.y, deathView.z);
    camera.position.set(deathView.x, deathView.y + 45, deathView.z);
    camera.lookAt(focus);
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
function showResult() {
  if (!$("#game").classList.contains("active")) return;
  if ($("#result").classList.contains("active")) return;
  if (deathResultTimer) clearTimeout(deathResultTimer);
  deathResultTimer = null;
  deathView = null;
  camera?.up.set(0, 1, 0);
  if (renderer?.domElement) renderer.domElement.style.filter = "";
  $("#deathViewOverlay")?.classList.add("hidden");
  closeBackpack(false);
  // Tắt scope và đóng menu ESC ngay khi trận kết thúc — không mang trạng thái
  // này sang trận sau.
  if (scoped) setScope(false);
  if (paused) {
    paused = false;
    $("#pauseSettings").classList.add("hidden");
    $("#pauseMain").classList.remove("hidden");
  }
  $("#gameMessage").classList.add("hidden");
  document.exitPointerLock?.();
  $("#killsResult").textContent = local.kills;
  const finalPlace = local.placement || (local.hp > 0 ? 1 : 0);
  $("#placeResult").textContent = finalPlace ? `TOP ${finalPlace}` : "TOP —";
  const e = Math.floor((Date.now() - startedAt) / 1000);
  $("#surviveResult").textContent =
    `${String(Math.floor(e / 60)).padStart(2, "0")}:${String(e % 60).padStart(2, "0")}`;
  const resultMessage =
    local.hp > 0
      ? "Bạn là người sống sót cuối cùng!"
      : localEliminationMessage ||
        "Bạn đã bị hạ. Hãy xem lại chiến thuật và thử thêm lần nữa.";
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
  // Trận đấu đang chạy ở fullscreen; thoát ra trước khi hiện bảng kết quả
  // vì bảng kết quả nằm ngoài phần tử #game đang được fullscreen.
  releaseGameInputMode();
  show("result");
  resultCountdown = setInterval(updateCountdown, 250);
  resultTimeout = setTimeout(returnHome, 20000);
}
function returnHome() {
  clearTimeout(resultTimeout);
  clearInterval(resultCountdown);
  resultTimeout = null;
  resultCountdown = null;
  localEliminationMessage = "";
  lastEliminationId = 0;
  cleanupGame();
  if (socket) socket.close();
  socket = null;
  $("#status").textContent = "● ONLINE";
  show("menu");
}
$("#returnBtn").onclick = returnHome;
