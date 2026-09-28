// Client prototype: Three.js scene, FPS controls and WebSocket room connection.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  buildAug,
  buildKar98,
  makeMuzzleFlash,
  fireMuzzleFlash,
  weaponToColoredGeometry,
  buildBakedWeapon,
  buildBeryl,
} from "./weapons.js";
import { buildAvatar, poseAvatar } from "./avatar.js";

// querySelector được gọi hàng chục lần MỖI khung hình (HUD, vòng bo, loot...).
// Nhớ lại phần tử đã tìm; nếu phần tử đó bị gỡ khỏi trang thì tìm lại.
const domCache = new Map();
const $ = (s) => {
  const cached = domCache.get(s);
  if (cached?.isConnected) return cached;
  const el = document.querySelector(s);
  if (el) domCache.set(s, el);
  else domCache.delete(s);
  return el;
};
// Chỉ ghi DOM khi nội dung thực sự đổi — ghi textContent/innerHTML/style mỗi
// khung hình (kể cả cùng giá trị) buộc trình duyệt tính lại layout/paint.
const setText = (el, text) => {
  if (!el) return;
  text = String(text);
  // Đọc textContent không gây tính layout nên so sánh trực tiếp là an toàn.
  if (el.textContent !== text) el.textContent = text;
};
const setHtml = (el, html) => {
  if (!el) return;
  if (el._lastHtml !== html || el.textContent !== el._lastHtmlText) {
    el.innerHTML = html;
    el._lastHtml = html;
    el._lastHtmlText = el.textContent;
  }
};
const setStyle = (el, prop, value) => {
  if (!el) return;
  const key = "_style_" + prop;
  if (el[key] !== value) {
    el[key] = value;
    el.style[prop] = value;
  }
};
const screens = [...document.querySelectorAll(".screen")];
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
  ) || 4200;
// Màn nạp: thanh tiến trình, trạng thái và mẹo chơi bằng tiếng Việt.
const LOAD_STEPS = [
  [0, "Đang khởi tạo đấu trường…"],
  [22, "Đang dựng địa hình rừng núi và sa mạc…"],
  [48, "Đang lau súng AUG và Kar98k…"],
  [72, "Đang nạp nhiên liệu cho máy bay thả dù…"],
  [92, "Sẵn sàng nhảy dù!"],
];
const LOAD_TIPS = [
  "Mẹo: nằm sấp giúp bạn khó bị phát hiện giữa bãi cỏ cao.",
  "Mẹo: bắn trúng nón vẫn tính là trúng đầu — ngắm cao lên một chút.",
  "Mẹo: cầu có lan can, nhưng lao xe xuống sông thì xe sẽ chìm.",
  "Mẹo: vật phẩm chỉ nằm trong nhà — hãy lục soát từng khu dân cư.",
  "Mẹo: với Kar98k, cuộn chuột để đổi ống ngắm 4x – 8x.",
];
function runLoader(duration) {
  const started = performance.now();
  $("#loadTip").textContent =
    LOAD_TIPS[Math.floor(Math.random() * LOAD_TIPS.length)];
  const tick = () => {
    const t = Math.min(1, (performance.now() - started) / duration);
    const pct = Math.round((1 - Math.pow(1 - t, 2.2)) * 100);
    $("#loadBar").style.width = pct + "%";
    setText($("#loadPercent"), pct + "%");
    setText($("#loadStatus"), LOAD_STEPS.filter(([at]) => pct >= at).pop()[1]);
    if (t < 1) requestAnimationFrame(tick);
  };
  tick();
}
setTimeout(() => {
  companySplash.classList.add("hidden");
  loading.classList.remove("hidden");
  runLoader(loadingDurationMs);
  setTimeout(() => {
    loading.classList.add("hidden");
    app.classList.remove("hidden");
  }, loadingDurationMs + 250);
}, 4200);

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
    weapon: "none", // tiếp đất tay không, phải vào nhà tìm súng
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
  lastMoveKey = "",
  paused = false,
  scoped = false,
  verticalSpeed = 0,
  grounded = true,
  jumpOffset = 0,
  baseFov = 76,
  sniperZoomFov = 76 / 8, // ống ngắm 8x
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

  lastVehicleControlAt = 0,
  lastVehicleControlKey = "",
  cameraBaseY = 1.65,
  headBob = 0,
  snapshotServerTime = 0;
// Slightly above the server's 120 ms cadence so timer/network jitter won't
// cause valid automatic shots to be rejected by the server.
const FIRE_INTERVAL_MS = 80;
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
const audioLoops = {
  plane: null,
  wind: null /* weather loop temporarily disabled */,
};
// let weatherFx = null; // weather particles disabled for performance profiling
// let weatherActive = false; // weather synchronization disabled for profiling

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
// Tầm nghe đủ xa để phát hiện đối thủ TRƯỚC khi chạm mặt: tiếng súng vọng
// khắp một vùng lớn (xa thì nhỏ + đục đi), tiếng chạy nghe được từ ~40 m.
const AUDIO_RANGE = {
  footstep: { ref: 3, max: 40 }, // chạy bộ; đi chậm/khom tự nhỏ hơn (nhân theo intensity)
  gunshot: { ref: 12, max: 320 },
  reload: { ref: 1.5, max: 14 },
  loot: { ref: 1.5, max: 18 },
};
let gunshotVoiceWindow = 0, // giới hạn số tiếng súng người khác phát cùng lúc
  gunshotVoiceCount = 0;
// Thời điểm (ms, tính từ lúc bắt đầu nạp) của từng tiếng trong 1.8 giây nạp đạn.
// Thời điểm (ms, tính từ lúc bắt đầu nạp) của từng tiếng trong 1.8 giây nạp đạn,
// theo đúng thao tác của từng khẩu:
//  AUG:    bấm lẫy + rút băng → đập băng mới vào → kéo tay kéo lên đạn.
//  Kar98k: mở khóa nòng → nhét từng viên qua kẹp → rút kẹp → đóng khóa nòng.
const RELOAD_STAGES = {
  ranger: [
    { at: 180, kind: "magRelease" },
    { at: 300, kind: "magOut" },
    { at: 930, kind: "magIn" },
    { at: 1380, kind: "charge" },
  ],
  sniper: [
    { at: 80, kind: "boltOpen" },
    { at: 420, kind: "round" },
    { at: 640, kind: "round" },
    { at: 860, kind: "round" },
    { at: 1080, kind: "round" },
    { at: 1300, kind: "round" },
    { at: 1470, kind: "clipOut" },
    { at: 1640, kind: "boltClose" },
  ],
};

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
  // Giảm chậm hơn đường bậc 2 cũ ở tầm trung (cũ: nửa tầm chỉ còn 25%) nên
  // âm ở xa vẫn nghe rõ, nhưng vẫn tắt êm về 0 ở mép tầm nghe.
  return Math.pow(1 - t, 1.6);
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
    // HRTF tốn CPU: chỉ dùng cho âm ở gần (cần định vị chính xác); âm ở xa
    // (tiếng súng vọng từ xa) dùng equalpower rẻ hơn nhiều, vẫn đủ trái/phải.
    panner.panningModel = farness < 0.2 ? "HRTF" : "equalpower";
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
const distortionCurves = new Map();
function makeDistortionCurve(amount = 20) {
  // Chỉ vài giá trị amount cố định → tính một lần, dùng lại (trước đây mỗi
  // tiếng súng cấp phát mảng mới).
  const cached = distortionCurves.get(amount);
  if (cached) return cached;
  const curve = buildDistortionCurve(amount);
  distortionCurves.set(amount, curve);
  return curve;
}
function buildDistortionCurve(amount) {
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
// - "rifle" (AUG, súng tự động): dựa theo AUG — tiếng "tách" sắc, gọn,
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
// AUG (súng tự động AUG): tách nhanh-sắc kiểu bullpup nòng ngắn, có grit,
// dội trầm gọn — to và đanh nhưng không kéo dài/vang xa bằng súng bolt-action.
function playAugShot(a) {
  // AUG trong PUBG: phát nổ đanh, "chát" ở dải trung cao, thân tiếng dày,
  // đuôi ngắn dội nhẹ — nghe gọn và nhanh khi xả liên thanh.
  noiseBurst(a, {
    duration: 0.012,
    filter: "highpass",
    freq: 5200,
    gain: 1.2,
    drive: 24,
  }); // tiếng nổ siêu thanh
  noiseBurst(a, {
    at: 0.002,
    duration: 0.09,
    filter: "bandpass",
    freq: 1900,
    q: 0.9,
    gain: 1.35,
    drive: 14,
  }); // thân tiếng "chát"
  noiseBurst(a, {
    at: 0.004,
    duration: 0.18,
    filter: "lowpass",
    freq: 900,
    gain: 0.9,
    drive: 6,
  }); // hơi nổ
  toneBurst(a, { duration: 0.08, from: 190, to: 70, gain: 1.0 }); // cú đấm ngực
  toneBurst(a, { duration: 0.12, from: 90, to: 38, gain: 0.55 }); // sub
  noiseBurst(a, {
    at: 0.11,
    duration: 0.16,
    filter: "bandpass",
    freq: 700,
    q: 0.8,
    gain: 0.22,
  }); // dội ngắn
  toneBurst(a, {
    at: 0.004,
    duration: 0.03,
    type: "triangle",
    from: 3200,
    to: 2400,
    gain: 0.05,
  }); // tiếng kim loại khóa nòng
  gunshotReverbTail(a, { wet: 0.26, tone: 2400, predelay: 0.008 });
}
function playKarShot(a) {
  // Kar98k trong PUBG: "đoàng" cực to, trầm, vang xa, có tiếng vọng đập vào
  // địa hình rồi dội lại hai nhịp.
  noiseBurst(a, {
    duration: 0.02,
    filter: "highpass",
    freq: 3600,
    gain: 1.3,
    drive: 26,
  });
  noiseBurst(a, {
    at: 0.004,
    duration: 0.34,
    filter: "lowpass",
    freq: 1500,
    gain: 1.7,
    drive: 22,
  });
  noiseBurst(a, {
    at: 0.004,
    duration: 0.12,
    filter: "bandpass",
    freq: 1200,
    q: 0.8,
    gain: 0.9,
    drive: 10,
  });
  toneBurst(a, { duration: 0.38, from: 95, to: 28, gain: 1.4 });
  toneBurst(a, { at: 0.015, duration: 0.45, from: 48, to: 18, gain: 0.95 });
  noiseBurst(a, {
    at: 0.22,
    duration: 0.42,
    filter: "lowpass",
    freq: 520,
    gain: 0.45,
  }); // vọng lần 1
  noiseBurst(a, {
    at: 0.55,
    duration: 0.6,
    filter: "lowpass",
    freq: 380,
    gain: 0.22,
  }); // vọng lần 2
  gunshotReverbTail(a, { wet: 0.6, tone: 1100, predelay: 0.018 });
}
// Kéo khóa nòng Kar98k: "cách" mở, "rẹt" kéo lùi (vỏ đạn văng), "rẹt" đẩy, "cạch" khóa.
function playKarBolt(position, delay = 0) {
  const a = spatialAudio(position, {
    volume: 0.75,
    ...AUDIO_RANGE.reload,
    delay,
  });
  if (!a) return;
  noiseBurst(a, {
    duration: 0.025,
    filter: "bandpass",
    freq: 3200,
    q: 3,
    gain: 0.9,
  });
  noiseBurst(a, {
    at: 0.09,
    duration: 0.09,
    filter: "bandpass",
    freq: 2100,
    q: 1.4,
    gain: 0.8,
  });
  toneBurst(a, {
    at: 0.2,
    duration: 0.05,
    type: "triangle",
    from: 2600,
    to: 1900,
    gain: 0.08,
  }); // vỏ đạn leng keng
  toneBurst(a, {
    at: 0.26,
    duration: 0.05,
    type: "triangle",
    from: 2300,
    to: 1700,
    gain: 0.05,
  });
  noiseBurst(a, {
    at: 0.3,
    duration: 0.08,
    filter: "bandpass",
    freq: 2300,
    q: 1.4,
    gain: 0.8,
  });
  noiseBurst(a, {
    at: 0.42,
    duration: 0.03,
    filter: "bandpass",
    freq: 2800,
    q: 3,
    gain: 1,
  });
  toneBurst(a, { at: 0.42, duration: 0.06, from: 210, to: 100, gain: 0.35 });
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
  const isBeryl = weapon === "beryl";
  // Giới hạn "giọng" cho tiếng súng NGƯỜI KHÁC: tầm nghe rất xa nên nhiều
  // trận đánh xa xả đạn cùng lúc có thể tạo hàng trăm audio node/giây. Mỗi
  // cửa sổ 100 ms chỉ phát tối đa 6 tiếng; súng của mình luôn được phát.
  if (position) {
    const nowMs = performance.now();
    if (nowMs - gunshotVoiceWindow > 100) {
      gunshotVoiceWindow = nowMs;
      gunshotVoiceCount = 0;
    }
    if (++gunshotVoiceCount > 6) return;
  }
  const a = spatialAudio(position, {
    volume: volume * (isSniper ? 1.5 : isBeryl ? 1.35 : 1.15),
    ...AUDIO_RANGE.gunshot,
    max: AUDIO_RANGE.gunshot.max * (isSniper ? 1.5 : isBeryl ? 1.2 : 1),
    delay,
  });
  if (!a) return;
  if (isSniper) playKarShot(a);
  else if (isBeryl) playBerylShot(a);
  else playAugShot(a);
}
// Beryl M762 (7.62): tiếng nổ dày, trầm và "đấm" hơn AUG rõ rệt, có tiếng dội
// dài hơn — nghe là biết súng hạng nặng.
function playBerylShot(a) {
  noiseBurst(a, { duration: 0.014, filter: "highpass", freq: 4200, gain: 1.35, drive: 28 }); // nổ siêu thanh
  noiseBurst(a, { at: 0.002, duration: 0.12, filter: "bandpass", freq: 1300, q: 0.8, gain: 1.6, drive: 18 }); // thân tiếng dày
  noiseBurst(a, { at: 0.004, duration: 0.25, filter: "lowpass", freq: 700, gain: 1.2, drive: 9 }); // hơi nổ nặng
  toneBurst(a, { duration: 0.1, from: 160, to: 55, gain: 1.3 }); // cú đấm ngực
  toneBurst(a, { duration: 0.18, from: 72, to: 30, gain: 0.95 }); // sub rung sàn
  noiseBurst(a, { at: 0.12, duration: 0.22, filter: "bandpass", freq: 600, q: 0.8, gain: 0.35 }); // dội vách
  toneBurst(a, { at: 0.005, duration: 0.035, type: "triangle", from: 2800, to: 2100, gain: 0.06 }); // khóa nòng thép
  gunshotReverbTail(a, { wet: 0.34, tone: 1900, predelay: 0.01 });
}
// Tiếng đấm: vung tay "vút" + tiếng vải áo; nghe được trong vài mét.
function playPunchWhoosh(position) {
  const a = spatialAudio(position, { volume: position ? 0.7 : 0.45, ref: 2, max: 14 });
  if (!a) return;
  noiseBurst(a, { duration: 0.16, filter: "bandpass", freq: 900, q: 0.9, gain: 0.8 });
  noiseBurst(a, { at: 0.04, duration: 0.1, filter: "highpass", freq: 2600, gain: 0.25 });
  toneBurst(a, { at: 0.1, duration: 0.05, from: 140, to: 80, gain: 0.25 });
}
// Âm thanh nhặt / thả đồ, mỗi loại một chất liệu riêng:
//  đạn  — vỏ đạn đồng lách cách trong hộp kim loại
//  máu  — túi nhựa/vải sột soạt + xé khoá dán
//  AUG  — thân nhựa polymer nhẹ "cạch", dây đeo sột soạt
//  Beryl— thép nặng "cạch" trầm + kéo tay kéo khoá nòng
//  Kar  — báng gỗ "cộc" + khoá nòng thép
// position = null: của chính mình (không pan, không suy giảm).
function playLootSound(sound, position) {
  const a = spatialAudio(position, { volume: position ? 0.9 : 0.6, ...AUDIO_RANGE.loot });
  if (!a) return;
  const r = () => 0.9 + Math.random() * 0.2;
  const [action, kind] = sound.split("-");
  if (action === "pickup") {
    if (kind === "ammo") {
      noiseBurst(a, { duration: 0.05, filter: "lowpass", freq: 700, gain: 0.5 }); // nhấc hộp
      for (let i = 0; i < 7; i++) {
        const at = 0.03 + i * 0.035 + Math.random() * 0.02;
        toneBurst(a, { at, duration: 0.05, type: "triangle", from: 3600 * r(), to: 3000 * r(), gain: 0.07 });
        noiseBurst(a, { at, duration: 0.02, filter: "bandpass", freq: 5200 * r(), q: 4, gain: 0.25 });
      }
      toneBurst(a, { at: 0.3, duration: 0.09, type: "triangle", from: 620, to: 480, gain: 0.12 }); // nắp hộp thiếc
      noiseBurst(a, { at: 0.3, duration: 0.05, filter: "bandpass", freq: 1800, q: 2, gain: 0.35 });
    } else if (kind === "medkit") {
      noiseBurst(a, { duration: 0.22, filter: "bandpass", freq: 1900 * r(), q: 0.6, gain: 0.45 }); // túi sột soạt
      for (let i = 0; i < 6; i++)
        noiseBurst(a, { at: 0.2 + i * 0.022, duration: 0.018, filter: "highpass", freq: 3200, gain: 0.3 }); // khoá dán
      noiseBurst(a, { at: 0.38, duration: 0.07, filter: "lowpass", freq: 500, gain: 0.35 }); // bỏ vào balo
    } else if (kind === "beryl") {
      noiseBurst(a, { duration: 0.08, filter: "bandpass", freq: 850, q: 1.2, gain: 0.7 });
      toneBurst(a, { duration: 0.12, type: "triangle", from: 240, to: 150, gain: 0.25 }); // thép nặng
      noiseBurst(a, { at: 0.22, duration: 0.03, filter: "highpass", freq: 2600, gain: 0.55 }); // kéo khoá nòng
      toneBurst(a, { at: 0.22, duration: 0.04, type: "square", from: 1500, to: 1100, gain: 0.05 });
      noiseBurst(a, { at: 0.33, duration: 0.035, filter: "bandpass", freq: 1700, q: 2, gain: 0.7 }); // nhả về
      toneBurst(a, { at: 0.33, duration: 0.06, type: "triangle", from: 900, to: 650, gain: 0.12 });
    } else if (kind === "sniper") {
      noiseBurst(a, { duration: 0.07, filter: "lowpass", freq: 600, gain: 0.6 }); // gỗ cộc
      toneBurst(a, { duration: 0.08, from: 190, to: 120, gain: 0.3 });
      noiseBurst(a, { at: 0.2, duration: 0.04, filter: "bandpass", freq: 2200, q: 2, gain: 0.5 }); // khoá nòng
      noiseBurst(a, { at: 0.3, duration: 0.03, filter: "bandpass", freq: 2800, q: 3, gain: 0.45 });
    } else {
      // AUG: nhựa nhẹ, tiếng "cạch" cao và khô, dây đeo sột soạt.
      noiseBurst(a, { duration: 0.12, filter: "bandpass", freq: 2400, q: 0.7, gain: 0.35 });
      noiseBurst(a, { at: 0.05, duration: 0.03, filter: "bandpass", freq: 1500, q: 2.5, gain: 0.6 });
      noiseBurst(a, { at: 0.24, duration: 0.025, filter: "highpass", freq: 3400, gain: 0.5 }); // lẫy an toàn
      toneBurst(a, { at: 0.24, duration: 0.03, type: "triangle", from: 2300, to: 1900, gain: 0.06 });
    }
    return;
  }
  // Thả xuống đất: cú chạm + nảy nhẹ, chất liệu theo loại.
  if (kind === "ammo") {
    noiseBurst(a, { duration: 0.06, filter: "lowpass", freq: 500, gain: 0.6 });
    for (let i = 0; i < 4; i++)
      toneBurst(a, { at: 0.02 + i * 0.03, duration: 0.05, type: "triangle", from: 3300 * r(), to: 2800, gain: 0.06 });
  } else if (kind === "medkit") {
    noiseBurst(a, { duration: 0.1, filter: "lowpass", freq: 420, gain: 0.55 });
    noiseBurst(a, { duration: 0.14, filter: "bandpass", freq: 1500, q: 0.6, gain: 0.25 });
  } else if (kind === "beryl") {
    noiseBurst(a, { duration: 0.09, filter: "lowpass", freq: 400, gain: 0.9 });
    toneBurst(a, { duration: 0.1, from: 110, to: 55, gain: 0.35 });
    noiseBurst(a, { at: 0.01, duration: 0.07, filter: "bandpass", freq: 800, q: 1.5, gain: 0.6 }); // thép va đất
    toneBurst(a, { at: 0.01, duration: 0.2, type: "triangle", from: 520, to: 470, gain: 0.07 }); // ngân kim loại
    noiseBurst(a, { at: 0.16, duration: 0.05, filter: "bandpass", freq: 900, q: 1.5, gain: 0.3 }); // nảy
  } else if (kind === "sniper") {
    noiseBurst(a, { duration: 0.08, filter: "lowpass", freq: 450, gain: 0.8 });
    toneBurst(a, { duration: 0.09, from: 150, to: 90, gain: 0.3 }); // gỗ cộc
    noiseBurst(a, { at: 0.15, duration: 0.04, filter: "lowpass", freq: 700, gain: 0.35 });
  } else {
    noiseBurst(a, { duration: 0.06, filter: "lowpass", freq: 550, gain: 0.6 });
    noiseBurst(a, { at: 0.01, duration: 0.05, filter: "bandpass", freq: 1600, q: 1.5, gain: 0.5 }); // nhựa lách cách
    noiseBurst(a, { at: 0.12, duration: 0.04, filter: "bandpass", freq: 1900, q: 1.5, gain: 0.3 });
    noiseBurst(a, { at: 0.2, duration: 0.03, filter: "bandpass", freq: 2100, q: 1.5, gain: 0.15 });
  }
}
// Bề mặt dưới chân quyết định tiếng bước.
function footSurface(x, z) {
  if (waterAt(x, z)) return "water";
  if (mapId === "forest" && inSwamp(x, z)) return "mud";
  for (const o of obstaclesNear(x, z)) {
    if (o.type !== "house" && o.type !== "hut") continue;
    const dx = x - o.x,
      dz = z - o.z,
      c = Math.cos(o.yaw || 0),
      sn = Math.sin(o.yaw || 0);
    if (
      Math.abs(c * dx - sn * dz) < o.w / 2 &&
      Math.abs(sn * dx + c * dz) < o.w / 2
    )
      return "wood";
  }
  if (isNearRoad(x, z, 0)) return "road";
  return mapId === "forest" ? "grass" : "sand";
}
function playSpatialFootstep(x, y, z, intensity = 1, ownPlayer = false) {
  if (ownPlayer && local.vehicleId) return;
  // Đi chậm / khom người có tầm nghe ngắn hơn chạy.
  const max = AUDIO_RANGE.footstep.max * intensity;
  const ref = Math.min(AUDIO_RANGE.footstep.ref, max * 0.3);
  const a = spatialAudio(
    { x, y, z },
    { volume: (ownPlayer ? 0.22 : 0.6) * (0.5 + 0.5 * intensity), ref, max },
  );
  if (!a) return;
  const v = 0.92 + Math.random() * 0.16; // mỗi bước hơi khác nhau
  const surface = footSurface(x, z);
  // Gót chạm trước, mũi chân tiếp đất ngay sau (~55 ms).
  for (const [at, g] of [
    [0, 1],
    [0.055, 0.55],
  ]) {
    if (surface === "grass") {
      toneBurst(a, { at, duration: 0.06, from: 95 * v, to: 55, gain: 0.3 * g });
      noiseBurst(a, {
        at,
        duration: 0.13,
        filter: "bandpass",
        freq: 2600 * v,
        q: 0.7,
        gain: 0.42 * g,
      }); // cỏ sột soạt
      noiseBurst(a, {
        at,
        duration: 0.06,
        filter: "lowpass",
        freq: 520,
        gain: 0.5 * g,
      });
    } else if (surface === "sand") {
      noiseBurst(a, {
        at,
        duration: 0.15,
        filter: "highpass",
        freq: 2800 * v,
        gain: 0.3 * g,
      }); // cát lạo xạo
      noiseBurst(a, {
        at,
        duration: 0.08,
        filter: "lowpass",
        freq: 420,
        gain: 0.55 * g,
      });
    } else if (surface === "road") {
      noiseBurst(a, {
        at,
        duration: 0.03,
        filter: "bandpass",
        freq: 1900 * v,
        q: 2,
        gain: 0.8 * g,
      }); // đế giày gõ nhựa đường
      toneBurst(a, {
        at,
        duration: 0.05,
        from: 120 * v,
        to: 70,
        gain: 0.3 * g,
      });
      noiseBurst(a, {
        at: at + 0.02,
        duration: 0.05,
        filter: "highpass",
        freq: 3500,
        gain: 0.15 * g,
      });
    } else if (surface === "wood") {
      toneBurst(a, {
        at,
        duration: 0.09,
        from: 190 * v,
        to: 120,
        gain: 0.55 * g,
      }); // sàn gỗ rỗng
      noiseBurst(a, {
        at,
        duration: 0.05,
        filter: "bandpass",
        freq: 900 * v,
        q: 3,
        gain: 0.6 * g,
      });
    } else if (surface === "mud") {
      noiseBurst(a, {
        at,
        duration: 0.14,
        filter: "lowpass",
        freq: 480 * v,
        gain: 0.8 * g,
      }); // bùn nhóp nhép
      noiseBurst(a, {
        at: at + 0.03,
        duration: 0.08,
        filter: "bandpass",
        freq: 320,
        q: 2,
        gain: 0.5 * g,
      });
    } else {
      noiseBurst(a, {
        at,
        duration: 0.24,
        filter: "lowpass",
        freq: 1700 * v,
        gain: 0.75 * g,
      }); // lội nước
      noiseBurst(a, {
        at: at + 0.04,
        duration: 0.14,
        filter: "bandpass",
        freq: 650,
        q: 1,
        gain: 0.45 * g,
      });
    }
  }
}
// kind: "magOut" (tháo băng), "magIn" (lắp băng), "bolt" (lên đạn)
function playSpatialReload(kind, position) {
  const a = spatialAudio(position, { volume: 0.75, ...AUDIO_RANGE.reload });
  if (!a) return;
  const click = (at, freq, gain = 0.9, q = 3) =>
    noiseBurst(a, { at, duration: 0.025, filter: "bandpass", freq, q, gain });
  const slide = (at, freq, duration = 0.08, gain = 0.7) =>
    noiseBurst(a, { at, duration, filter: "bandpass", freq, q: 1.3, gain });
  const thud = (at, from, gain = 0.4) =>
    toneBurst(a, { at, duration: 0.07, from, to: from / 2, gain });
  if (kind === "magRelease") {
    click(0, 3400, 0.7);
  } else if (kind === "magOut") {
    slide(0, 1600, 0.12, 0.8); // băng trượt ra khỏi ổ
    thud(0.02, 240, 0.25);
  } else if (kind === "magIn") {
    slide(0, 1400, 0.06, 0.6);
    click(0.06, 2600, 1.1, 2); // "cạch" băng vào khoá
    thud(0.06, 180, 0.6);
    noiseBurst(a, {
      at: 0.075,
      duration: 0.03,
      filter: "highpass",
      freq: 4200,
      gain: 0.5,
    });
  } else if (kind === "charge") {
    slide(0, 2400, 0.07, 0.8); // kéo tay kéo lên đạn
    click(0.12, 3000, 1.1);
    thud(0.12, 200, 0.4);
  } else if (kind === "boltOpen") {
    click(0, 3200, 0.9);
    slide(0.08, 2100, 0.09, 0.8);
  } else if (kind === "round") {
    click(0, 2900, 0.8, 4); // viên đạn ép xuống hộp
    toneBurst(a, {
      at: 0.005,
      duration: 0.04,
      type: "triangle",
      from: 2100,
      to: 1600,
      gain: 0.05,
    });
  } else if (kind === "clipOut") {
    slide(0, 3000, 0.05, 0.5);
    toneBurst(a, {
      at: 0.03,
      duration: 0.06,
      type: "triangle",
      from: 1800,
      to: 1200,
      gain: 0.06,
    });
  } else if (kind === "boltClose") {
    slide(0, 2300, 0.08, 0.8);
    click(0.1, 2800, 1.1);
    thud(0.1, 210, 0.4);
  }
}
// playerKey = null: người chơi của mình; còn lại là id người chơi khác.
// Vị trí được lấy lại ở mỗi tiếng nên âm thanh đi theo người đang nạp đạn,
// và tự dừng nếu họ chết / thoát / ngừng nạp.
function startReloadSounds(playerKey, weapon = "ranger") {
  for (const stage of RELOAD_STAGES[
    weapon === "sniper" ? "sniper" : "ranger"
  ]) {
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

// ---- Chế độ hiển thị: game quyết định fullscreen/windowed, không phải phím ESC ----
let displayMode =
  localStorage.getItem("ld-display-mode") === "fullscreen"
    ? "fullscreen"
    : "windowed";
let fullscreenRestoreArmed = false;
const isMatchScreenActive = () => $("#game")?.classList.contains("active");
function syncDisplayModeControls() {
  const pause = document.getElementById("pauseFullscreen");
  if (pause) pause.value = displayMode === "fullscreen" ? "on" : "off";
  const main = document.getElementById("displayMode");
  if (main) main.value = displayMode;
}
// Đang fullscreen trong trận thì khóa phím ESC (Chrome/Edge): nhấn ESC chỉ gửi
// sự kiện cho game (mở menu tạm dừng) chứ không thoát fullscreen.
function syncKeyboardLock() {
  try {
    if (
      displayMode === "fullscreen" &&
      document.fullscreenElement &&
      isMatchScreenActive()
    )
      navigator.keyboard?.lock?.(GAME_KEY_CODES)?.catch?.(() => {});
    else navigator.keyboard?.unlock?.();
  } catch {}
}
async function applyDisplayMode() {
  try {
    if (displayMode === "fullscreen" && !document.fullscreenElement)
      await document.documentElement.requestFullscreen?.({
        navigationUI: "hide",
      });
    else if (displayMode === "windowed" && document.fullscreenElement)
      await document.exitFullscreen?.();
  } catch {
    // Trình duyệt chỉ cho vào fullscreen khi có thao tác của người chơi; nếu
    // bị từ chối thì armFullscreenRestore() sẽ thử lại ở lần bấm/phím kế tiếp.
  }
  syncKeyboardLock();
}
function setDisplayMode(mode) {
  displayMode = mode === "fullscreen" ? "fullscreen" : "windowed";
  localStorage.setItem("ld-display-mode", displayMode);
  syncDisplayModeControls();
  return applyDisplayMode();
}
// Fullscreen bị thoát ngoài ý muốn (ESC ở trình duyệt không hỗ trợ khóa phím...):
// chờ thao tác kế tiếp của người chơi rồi vào lại ngay, vì trình duyệt không cho
// tự vào fullscreen nếu không có thao tác.
function armFullscreenRestore() {
  if (fullscreenRestoreArmed) return;
  fullscreenRestoreArmed = true;
  const restore = async () => {
    document.removeEventListener("pointerdown", restore, true);
    document.removeEventListener("keydown", restore, true);
    fullscreenRestoreArmed = false;
    if (displayMode !== "fullscreen" || !isMatchScreenActive()) return;
    await applyDisplayMode();
    if (
      displayMode === "fullscreen" &&
      isMatchScreenActive() &&
      !document.fullscreenElement
    )
      armFullscreenRestore(); // phím vừa bấm (vd. ESC) không tính là thao tác hợp lệ
  };
  document.addEventListener("pointerdown", restore, true);
  document.addEventListener("keydown", restore, true);
}

function syncPauseSettings() {
  for (const key of Object.keys(settingsBindings)) {
    const input = document.getElementById(settingsBindings[key].main);
    if (input) syncSettingControl(key, input.value);
  }
  syncDisplayModeControls();
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
document
  .getElementById("pauseFullscreen")
  ?.addEventListener("change", (event) =>
    setDisplayMode(
      event.currentTarget.value === "on" ? "fullscreen" : "windowed",
    ),
  );
document
  .getElementById("displayMode")
  ?.addEventListener("change", (event) =>
    setDisplayMode(event.currentTarget.value),
  );
syncDisplayModeControls();
// Setting đã chọn thì khóa đúng như vậy suốt trận.
document.addEventListener("fullscreenchange", () => {
  syncKeyboardLock();
  if (!isMatchScreenActive()) return; // ngoài trận không ép
  if (displayMode === "windowed" && document.fullscreenElement)
    document.exitFullscreen?.().catch?.(() => {});
  else if (displayMode === "fullscreen" && !document.fullscreenElement)
    armFullscreenRestore();
});
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

// Nhập mã phòng xong bấm Enter cũng vào phòng, không cần bấm nút THAM GIA.
$("#codeInput").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  $("#joinBtn").click();
});

function connect(message) {
  if (socket) socket.close();
  serverOffsetReady = false;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}`);
  $("#status").textContent = "● CONNECTING";
  socket.onopen = () => {
    socket.send(
      JSON.stringify({ ...message, name: $("#nameInput").value || "Rookie" }),
    );
    startPingLoop();
  };
  socket.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "pong") {
      const sample = performance.now() - Number(m.t);
      if (Number.isFinite(sample) && sample >= 0 && sample < 5000)
        rttMs = rttMs ? rttMs + (sample - rttMs) * 0.25 : sample;
      updatePingHud();
      return;
    }
    if (m.type === "error") {
      alert(m.message);
      return;
    }
    if (m.type === "joined") {
      roomCode = m.code;
      playerId = m.playerId;
      isHost = m.isHost;
      mapId = m.mapId === "desert" ? "desert" : "forest";
      setMapObstacles(m.obstacles || []);
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
    if (m.type === "lootSfx" && typeof m.sound === "string")
      playLootSound(
        m.sound,
        m.by === playerId
          ? null
          : { x: m.x, y: groundHeightAt(m.x, m.z) + 0.6, z: m.z },
      );
    if (m.type === "horn" && m.senderId !== playerId)
      playCarHorn({ x: m.x, y: m.y, z: m.z });
    // Server sửa lại chỗ tiếp đất (ví dụ trúng cây / đá).
    if (m.type === "landed" && local.state === "ground") {
      local.x = m.x;
      local.z = m.z;
      local.groundY = Number(m.groundY) || 0;
    }
    if (m.type === "state") {
      const receivedAt = performance.now();
      for (const vehicle of m.vehicles || []) vehicle.receivedAt = receivedAt;
      recordVehicleSnapshots(m.vehicles || [], m.now);
      snapshotServerTime = m.now;
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
      // Chỉ cập nhật khi map đổi: renderMapChoice ghi localStorage (I/O đồng bộ)
      // và DOM — trước đây chạy 20 lần/giây suốt trận.
      if (m.mapId && m.mapId !== mapId) {
        mapId = m.mapId;
        renderMapChoice(mapId);
      }
      // Weather state handling is disabled for performance profiling.
      // if (typeof m.weatherActive === "boolean" && m.weatherActive !== weatherActive) {
      //   weatherActive = m.weatherActive;
      //   const forest = mapId === "forest";
      //   if (weatherActive) beginWeather(forest); else endWeather(forest);
      // }
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
        else if ((Number(m.total) || 0) > 1) showVictory();
        else showResult();
      }
    }
  };
  const thisSocket = socket;
  socket.onclose = () => {
    stopPingLoop();
    // Chủ động rời phòng / mở kết nối mới thì không báo lỗi.
    if (socket !== thisSocket) {
      $("#status").textContent = "● ONLINE";
      return;
    }
    $("#status").textContent = "● MẤT KẾT NỐI";
    if (inMatch)
      showLootToast("MẤT KẾT NỐI MÁY CHỦ · KIỂM TRA MẠNG RỒI VÀO LẠI PHÒNG");
    else if (roomCode)
      alert(
        "Mất kết nối tới máy chủ. Hãy kiểm tra mạng rồi tạo/vào lại phòng.",
      );
  };
}
// ---- Đo ping (RTT) — dùng để dự đoán xe và hiện chất lượng mạng cho người chơi ----
let rttMs = 0,
  pingTimer = null;
function startPingLoop() {
  stopPingLoop();
  const ping = () => send({ type: "ping", t: performance.now() });
  ping();
  pingTimer = setInterval(ping, 2000);
}
function stopPingLoop() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}
function updatePingHud() {
  let el = $("#pingHud");
  if (!el) {
    const hud = $(".hud");
    if (!hud) return;
    el = document.createElement("div");
    el.id = "pingHud";
    el.className = "ping-hud";
    hud.append(el);
  }
  const ms = Math.round(rttMs);
  setText(el, `PING ${ms} MS`);
  const level = ms < 80 ? "good" : ms < 160 ? "ok" : "bad";
  if (el.dataset.level !== level) el.dataset.level = level;
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
let lastLobbyKey = "";
function renderLobby() {
  if (!gameState) return;
  isHost = gameState.hostId === playerId;
  // Gói state tới 20 lần/giây; chỉ dựng lại sảnh khi danh sách người chơi đổi.
  const lobbyKey = `${playerId}|${isHost}|${mapId}|${gameState.players
    .map((p) => `${p.id}:${p.name}`)
    .join(",")}`;
  if (lobbyKey === lastLobbyKey) return;
  lastLobbyKey = lobbyKey;
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
// Trước đây mỗi lần gọi tạo MỚI một Material dù cùng màu — với hàng nghìn
// vật cản (nhà/cây/đá...) thì con số Material tạo ra lên tới hàng nghìn,
// trong khi thực chất chỉ có vài chục màu khác nhau. Cache lại theo màu để
// GPU không phải đổi trạng thái vật liệu liên tục.
const materialCache = new Map();
const sharedMaterials = new Set();
// Lambert thay cho Standard (PBR): mọi vật liệu ở đây đều nhám (roughness
// 0.8–1) nên hình gần như y hệt, nhưng shader rẻ hơn nhiều lần — quan trọng
// với GPU tích hợp / máy yếu vì phần lớn khung hình là nhà, cây, đá, đất.
function makeMat(color, roughness = 1) {
  const key = String(color);
  let mat = materialCache.get(key);
  if (!mat) {
    mat = new THREE.MeshLambertMaterial({ color });
    materialCache.set(key, mat);
    sharedMaterials.add(mat);
  }
  return mat;
}
// Gộp hàng trăm/nghìn vật cản tĩnh cùng màu (nhà, cây, đá...) thành một mesh
// DUY NHẤT mỗi màu — biến hàng nghìn draw call thành vài chục, không đổi bất
// kỳ hình ảnh nào vì mỗi mảnh vẫn giữ đúng vị trí/xoay/scale gốc, chỉ khác là
// được "đóng cứng" vào hình học chung thay vì làm một Mesh riêng.
let mergeBuckets = null;
// Bucket đặc biệt cần vật liệu riêng (không phải Lambert đục của makeMat).
// Kính cửa sổ: cả map gộp chung MỘT mesh trong suốt → chỉ thêm 1 draw call.
const BUCKET_MATERIALS = {
  windowGlass: () =>
    new THREE.MeshLambertMaterial({
      color: "#a9cbd6",
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      side: THREE.DoubleSide, // nhìn được từ trong lẫn ngoài nhà
    }),
};
function bucketAdd(key, color, geometry, build) {
  const temp = new THREE.Object3D();
  build(temp);
  temp.updateMatrix();
  const geo = geometry.clone();
  geo.applyMatrix4(temp.matrix);
  geometry.dispose();
  (mergeBuckets[key] ||= { color, parts: [] }).parts.push(geo);
}
function flushMergeBuckets() {
  for (const key in mergeBuckets) {
    const bucket = mergeBuckets[key];
    if (!bucket.parts.length) continue;
    const merged = mergeGeometries(bucket.parts, false);
    const mesh = new THREE.Mesh(merged, BUCKET_MATERIALS[key]?.() || makeMat(bucket.color));
    if (BUCKET_MATERIALS[key]) mesh.renderOrder = 1; // kính trong vẽ sau vật đục
    scene.add(mesh);
  }
  mergeBuckets = null;
}
function updateAmmoHud() {
  const reserve = local.reserveAmmo ?? 0;
  const hud = $("#ammo");
  if (weaponKey(local.weapon) === "none") {
    setHtml(hud, `👊 <i>VÀO NHÀ TÌM SÚNG · DỰ TRỮ ${reserve}</i>`);
    return;
  }
  const capacity = local.weapon === "sniper" ? 5 : 30;
  setHtml(hud, `${ammo} <i>/ ${capacity} · DỰ TRỮ ${reserve}</i>`);
}
// ---- Lưới không gian cho vật cản (giống server) ----
// Va chạm, độ cao, nước, cầu được hỏi nhiều lần MỖI khung hình (đi bộ, xe,
// hạt loot...). Quét cả ~500 vật cản mỗi lần là lãng phí: chia map thành ô
// 16 m, mỗi điểm chỉ xét vài vật cản trong ô của nó (kết quả y hệt).
const OBSTACLE_CELL = 16;
const OBSTACLE_CELL_MARGIN = 3;
let obstacleCells = null;
const obstacleCellKey = (ix, iz) => (ix + 512) * 1024 + (iz + 512);
function obstacleBoundRadius(o) {
  const w = o.w || 1;
  const length = o.length || w;
  if (o.type === "lake") return Math.max(w, length);
  if (o.type === "road" || o.type === "river") return (length + w) / 2;
  return Math.hypot(w, length) * 0.6;
}
// Loại obstacle chỉ dùng để dựng địa hình (không va chạm, không vẽ riêng).
const TERRAIN_ONLY = new Set(["hill", "terrain", "plateau", "pad", "swamp"]);
let mapTerrain = null;
function setMapObstacles(list) {
  mapObstacles = list;
  mapHills = list.filter((obstacle) => obstacle.type === "hill");
  // Cùng lưới độ cao với server (public/terrain.js) → đứng/lái/đạn khớp mặt đất.
  mapTerrain = window.LDTerrain.build(list);
  obstacleCells = new Map();
  for (const o of list) {
    if (TERRAIN_ONLY.has(o.type) || !Number.isFinite(o.x)) continue;
    const r = obstacleBoundRadius(o) + OBSTACLE_CELL_MARGIN;
    const x0 = Math.floor((o.x - r) / OBSTACLE_CELL),
      x1 = Math.floor((o.x + r) / OBSTACLE_CELL);
    const z0 = Math.floor((o.z - r) / OBSTACLE_CELL),
      z1 = Math.floor((o.z + r) / OBSTACLE_CELL);
    for (let ix = x0; ix <= x1; ix++)
      for (let iz = z0; iz <= z1; iz++) {
        const key = obstacleCellKey(ix, iz);
        let cell = obstacleCells.get(key);
        if (!cell) obstacleCells.set(key, (cell = []));
        cell.push(o);
      }
  }
}
const NO_OBSTACLES = [];
function obstaclesNear(x, z) {
  if (!obstacleCells) return mapObstacles;
  return (
    obstacleCells.get(
      obstacleCellKey(
        Math.floor(x / OBSTACLE_CELL),
        Math.floor(z / OBSTACLE_CELL),
      ),
    ) || NO_OBSTACLES
  );
}
function groundHeightAt(x, z) {
  let height = mapTerrain ? mapTerrain.heightAt(x, z) : 0;
  if (isOnBridgeAt(x, z, 0.2)) height = Math.max(height, 0.3);
  return height;
}
function isOnBridgeAt(x, z, clearance = 0) {
  return obstaclesNear(x, z).some((road) => {
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
  for (const o of obstaclesNear(x, z)) {
    if (o.type !== "house" && o.type !== "hut" && o.type !== "rock") continue;
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
      const base = groundHeightAt(o.x, o.z);
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
      const base = groundHeightAt(o.x, o.z);
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
  for (const water of obstaclesNear(x, z)) {
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
// ---------------------------------------------------------------------------
// ĐỊA HÌNH TỰ NHIÊN: mặt đất liền khối theo lưới độ cao dùng chung với server
// ---------------------------------------------------------------------------
// Độ sâu lòng nước tại (x, z) — bỏ qua cầu (dưới gầm cầu vẫn là lòng sông).
function waterBedDepth(x, z) {
  for (const o of obstaclesNear(x, z)) {
    if (o.type !== "river" && o.type !== "lake") continue;
    if (window.LDTerrain.insideWater(o, x, z)) return o.depth || 4;
  }
  return 0;
}
// Danh sách đầm lầy lọc sẵn (hàm này gọi hàng chục nghìn lần khi dựng map).
let swampCache = null,
  swampCacheFor = null;
function inSwamp(x, z, margin = 0) {
  if (swampCacheFor !== mapObstacles) {
    swampCacheFor = mapObstacles;
    swampCache = mapObstacles.filter((o) => o.type === "swamp");
  }
  for (const o of swampCache)
    if (window.LDTerrain.insideWater(o, x, z, margin)) return true;
  return false;
}
function terrainColor(forest, x, z, h, slope, bed, swamp, seed, out) {
  const n = window.LDTerrain.fbm(x / 18, z / 18, seed + 5, 3);
  const n2 = window.LDTerrain.fbm(x / 5, z / 5, seed + 9, 2);
  const mix = (hex, t) => out.lerp(tmpTerrainColor.set(hex), t);
  if (forest) {
    out.set(n > 0.55 ? "#5c8a43" : n > 0.42 ? "#4f7d3c" : "#44703a");
    mix("#7d8a4a", Math.max(0, n2 - 0.62) * 1.6); // mảng cỏ úa
    if (h > 18) mix("#56654a", Math.min(1, (h - 18) / 22)); // cỏ núi sẫm
    if (slope > 0.45)
      mix(n2 > 0.5 ? "#6d6f66" : "#5d6058", Math.min(1, (slope - 0.45) * 2.2)); // vách đá
    if (h > 34) mix("#7b7e78", Math.min(1, (h - 34) / 10));
    if (h > 46)
      mix("#e8ecef", Math.min(1, (h - 46) / 8) * (slope < 1 ? 1 : 0.5)); // tuyết đỉnh núi
    if (swamp) out.set(n2 > 0.5 ? "#3d4a2b" : "#454f2e");
    if (bed > 0) out.set("#3e4b3a");
    else if (
      h < 0.7 &&
      waterBedDepth(x + 6, z) +
        waterBedDepth(x - 6, z) +
        waterBedDepth(x, z + 6) +
        waterBedDepth(x, z - 6) >
        0
    )
      out.set("#7b7657"); // bãi bồi ven sông
  } else {
    out.set(n > 0.55 ? "#d2ae74" : n > 0.42 ? "#c9a46a" : "#bf975f");
    mix("#e0c28c", Math.max(0, n2 - 0.6) * 1.5);
    if (slope > 0.3) {
      // Vách núi sa mạc: các lớp đá trầm tích theo độ cao.
      const band = Math.floor((h + n * 6) / 3.2) % 3;
      mix(
        band === 0 ? "#b5794a" : band === 1 ? "#a3673f" : "#c48c58",
        Math.min(1, (slope - 0.3) * 2),
      );
    }
    if (h > 55) mix("#8d5e3c", Math.min(1, (h - 55) / 20));
  }
  return out;
}
const tmpTerrainColor = new THREE.Color();
function createGroundMesh(forest) {
  const T = mapTerrain;
  const { N, CELL, EXTENT } = T;
  const seed = (mapObstacles.find((o) => o.type === "terrain")?.seed || 1) | 0;
  const vis = new Float32Array(N * N);
  const colors = new Float32Array(N * N * 3);
  const color = new THREE.Color();
  for (let j = 0; j < N; j++) {
    const z = j * CELL - EXTENT;
    for (let i = 0; i < N; i++) {
      const x = i * CELL - EXTENT;
      const k = j * N + i;
      const h = T.heights[k];
      const bed = waterBedDepth(x, z);
      const swamp = forest && inSwamp(x, z);
      // Lòng sông/hồ hạ xuống đáy; đầm lầy lún nhẹ dưới mặt nước đục.
      vis[k] = bed > 0 ? -bed : swamp ? -0.25 : h;
      const slope =
        i > 0 && i < N - 1 && j > 0 && j < N - 1
          ? Math.hypot(
              T.heights[k + 1] - T.heights[k - 1],
              T.heights[k + N] - T.heights[k - N],
            ) /
            (2 * CELL)
          : 0;
      terrainColor(forest, x, z, h, slope, bed, swamp, seed, color);
      colors[k * 3] = color.r;
      colors[k * 3 + 1] = color.g;
      colors[k * 3 + 2] = color.b;
    }
  }
  const normals = new Float32Array(N * N * 3);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const hl = vis[j * N + Math.max(0, i - 1)],
        hr = vis[j * N + Math.min(N - 1, i + 1)];
      const hd = vis[Math.max(0, j - 1) * N + i],
        hu = vis[Math.min(N - 1, j + 1) * N + i];
      const nx = hl - hr,
        ny = 2 * CELL,
        nz = hd - hu;
      const len = Math.hypot(nx, ny, nz);
      normals[k * 3] = nx / len;
      normals[k * 3 + 1] = ny / len;
      normals[k * 3 + 2] = nz / len;
    }
  // Chia 6×6 khối để GPU bỏ qua phần nằm ngoài khung nhìn.
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const CH = Math.ceil((N - 1) / 6);
  for (let cj = 0; cj < N - 1; cj += CH)
    for (let ci = 0; ci < N - 1; ci += CH) {
      const w = Math.min(CH, N - 1 - ci) + 1,
        d = Math.min(CH, N - 1 - cj) + 1;
      const pos = new Float32Array(w * d * 3),
        nor = new Float32Array(w * d * 3),
        col = new Float32Array(w * d * 3);
      for (let j = 0; j < d; j++)
        for (let i = 0; i < w; i++) {
          const k = (cj + j) * N + (ci + i),
            v = j * w + i;
          pos[v * 3] = (ci + i) * CELL - EXTENT;
          pos[v * 3 + 1] = vis[k];
          pos[v * 3 + 2] = (cj + j) * CELL - EXTENT;
          for (let c = 0; c < 3; c++) {
            nor[v * 3 + c] = normals[k * 3 + c];
            col[v * 3 + c] = colors[k * 3 + c];
          }
        }
      const index = [];
      for (let j = 0; j < d - 1; j++)
        for (let i = 0; i < w - 1; i++) {
          const a = j * w + i,
            b = a + w;
          index.push(a, b, a + 1, a + 1, b, b + 1);
        }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(col, 3));
      geometry.setIndex(index);
      geometry.computeBoundingSphere();
      scene.add(new THREE.Mesh(geometry, material));
    }
  addWaterSurfaces(forest);
  addRoadRibbons(forest);
}
// Dải băng (ribbon) chạy dọc một đường gấp khúc, bám độ cao yFn — dùng cho
// mặt đường, lề đường và mặt sông. Trả về BufferGeometry có index/normal/uv
// để gộp chung được với các hình khác trong bucket.
function ribbonGeometry(points, halfWidth, yFn) {
  const pos = [],
    nor = [],
    uv = [],
    index = [];
  let along = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const a = points[Math.max(0, i - 1)],
      b = points[Math.min(points.length - 1, i + 1)];
    let dx = b.x - a.x,
      dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const hw = typeof halfWidth === "function" ? halfWidth(i) : halfWidth;
    if (i > 0)
      along += Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z);
    for (const side of [-1, 1]) {
      const x = p.x + dz * hw * side,
        z = p.z - dx * hw * side;
      pos.push(x, yFn(x, z, p), z);
      nor.push(0, 1, 0);
      uv.push(side < 0 ? 0 : 1, along / 8);
    }
    if (i > 0) {
      const v = i * 2;
      index.push(v - 2, v, v - 1, v - 1, v, v + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  return geometry;
}
// Gom các đoạn (road/river) cùng id theo thứ tự seq thành đường gấp khúc mịn.
function segmentLines(type, idKey, trim = 0) {
  const groups = new Map();
  for (const o of mapObstacles)
    if (o.type === type && o[idKey] !== undefined) {
      if (!groups.has(o[idKey])) groups.set(o[idKey], []);
      groups.get(o[idKey]).push(o);
    }
  const lines = [];
  for (const segs of groups.values()) {
    segs.sort((a, b) => a.seq - b.seq);
    const pts = [];
    segs.forEach((s, n) => {
      const half = (s.length - trim) / 2;
      const sx = Math.sin(s.yaw) * half,
        sz = Math.cos(s.yaw) * half;
      if (n === 0) pts.push({ x: s.x - sx, z: s.z - sz, seg: s });
      // Chia nhỏ để bám địa hình (mỗi ~2.5 m một điểm).
      const steps = Math.max(1, Math.round((half * 2) / 2.5));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        pts.push({
          x: s.x - sx + 2 * sx * t,
          z: s.z - sz + 2 * sz * t,
          seg: s,
        });
      }
    });
    lines.push(pts);
  }
  return lines;
}
function addRoadRibbons(forest) {
  const noop = () => {};
  for (const pts of segmentLines("road", "roadId", 0.6)) {
    const y = (lift) => (x, z) => groundHeightAt(x, z) + lift;
    const halfW = pts[0]?.seg.w / 2 || 4.5;
    bucketAdd(
      "road-shoulder",
      forest ? "#7c7563" : "#9a8a6c",
      ribbonGeometry(pts, halfW + 1.2, y(0.05)),
      noop,
    );
    bucketAdd(
      "road-asphalt",
      forest ? "#4f4d46" : "#5e584e",
      ribbonGeometry(pts, halfW, y(0.085)),
      noop,
    );
    // Vạch giữa đứt quãng.
    let run = 0;
    let dash = [];
    for (let i = 1; i < pts.length; i++) {
      run += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      const on = run % 5 < 2.2;
      if (on) dash.push(pts[i]);
      if ((!on || i === pts.length - 1) && dash.length > 1) {
        bucketAdd(
          "road-dash",
          "#d9d0a8",
          ribbonGeometry(dash, 0.09, y(0.11)),
          noop,
        );
        dash = [];
      } else if (!on) dash = [];
    }
  }
  // Mặt cầu dày + trụ cầu xuống lòng sông.
  for (const s of mapObstacles) {
    if (s.type !== "road" || !s.bridge) continue;
    bucketAdd(
      "bridge-deck",
      "#6b6358",
      new THREE.BoxGeometry(s.w + 0.6, 0.4, s.length),
      (t) => {
        t.position.set(s.x, groundHeightAt(s.x, s.z) - 0.18, s.z);
        t.rotation.y = s.yaw;
      },
    );
    for (const side of [-1, 1])
      bucketAdd(
        "bridge-deck",
        "#6b6358",
        new THREE.BoxGeometry(0.7, 5.2, 0.7),
        (t) => {
          t.position.set(
            s.x + Math.cos(s.yaw) * side * (s.w / 2 - 0.3),
            -2.5,
            s.z - Math.sin(s.yaw) * side * (s.w / 2 - 0.3),
          );
        },
      );
  }
}
function addWaterSurfaces(forest) {
  if (!forest) return;
  const riverMat = waterMaterial("riverSurface", {
    color: "#32869a",
    roughness: 0.22,
    metalness: 0.12,
    transparent: true,
    opacity: 0.86,
  });
  for (const pts of segmentLines("river", "riverId", 6)) {
    const geometry = ribbonGeometry(
      pts,
      (i) => pts[i].seg.w / 2 + 0.6,
      () => 0.05,
    );
    scene.add(new THREE.Mesh(geometry, riverMat));
  }
  // Đầm lầy: mặt nước đục màu rêu, nông (đi bộ được), kèm lau sậy từ addGrass().
  const swampMat = waterMaterial("swamp", {
    color: "#55622f",
    roughness: 0.55,
    transparent: true,
    opacity: 0.82,
  });
  for (const o of mapObstacles) {
    if (o.type !== "swamp") continue;
    const m = new THREE.Mesh(new THREE.CircleGeometry(1, 40), swampMat);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = o.yaw || 0; // khớp phép xoay elip của insideWater
    m.scale.set(o.w, o.length, 1);
    m.position.set(o.x, 0.04, o.z);
    scene.add(m);
  }
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
// 10 đoạn sông trước đây mỗi đoạn tạo 2 material nước riêng; dùng chung theo loại.
const waterMaterials = new Map();
function waterMaterial(kind, options) {
  let material = waterMaterials.get(kind);
  if (!material) {
    material = new THREE.MeshStandardMaterial(options);
    waterMaterials.set(kind, material);
  }
  return material;
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
    case "road":
    case "river":
      // Vẽ liền mạch bằng dải băng bám địa hình trong createGroundMesh().
      break;
    case "lake": {
      // Lòng hồ là địa hình đã hạ xuống (createGroundMesh); chỉ còn mặt nước.
      const water = add(
        new THREE.CircleGeometry(1, 48),
        "#287f92",
        o.x,
        0.05,
        o.z,
        waterMaterial("lakeSurface", {
          color: "#287f92",
          roughness: 0.2,
          metalness: 0.1,
          transparent: true,
          opacity: 0.86,
        }),
      );
      water.rotation.set(-Math.PI / 2, 0, o.yaw || 0);
      water.scale.set(o.w, o.length, 1);
      break;
    }
    case "fence": {
      // Lan can / hàng rào: 2 thanh ngang + cọc mỗi ~2.4 m (đúng khối va chạm).
      const c = Math.cos(o.yaw || 0),
        sn = Math.sin(o.yaw || 0);
      const color = "#7a6a52";
      for (const y of [0.55, 1.02])
        bucketAdd(
          "fence",
          color,
          new THREE.BoxGeometry(0.09, 0.12, o.length),
          (t) => {
            t.position.set(o.x, baseY + y, o.z);
            t.rotation.y = o.yaw || 0;
          },
        );
      const posts = Math.max(1, Math.round(o.length / 2.4));
      for (let n = 0; n <= posts; n++) {
        const along = (n / posts - 0.5) * o.length;
        bucketAdd(
          "fence",
          color,
          new THREE.BoxGeometry(0.14, 1.2, 0.14),
          (t) => {
            t.position.set(o.x + sn * along, baseY + 0.55, o.z + c * along);
            t.rotation.y = o.yaw || 0;
          },
        );
      }
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
      // Toạ độ cục bộ của nhà → thế giới theo đúng phép xoay dùng cho va chạm
      // (blockedByBuilding) để tường vẽ ra trùng tường chặn đạn/người.
      const yaw = o.yaw || 0,
        yc = Math.cos(yaw),
        ys = Math.sin(yaw);
      const at = (t, x, y, z) =>
        t.position.set(o.x + yc * x + ys * z, y + baseY, o.z - ys * x + yc * z);
      const wall = (x, y, z, sx, sy, sz, color = wallColor) =>
        bucketAdd(color, color, new THREE.BoxGeometry(sx, sy, sz), (t) => {
          at(t, x, y, z);
          t.rotation.y = yaw;
        });
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
      // Cửa sổ hai bên: bệ, lanh tô và kính TRONG SUỐT — nhìn và bắn xuyên được
      // (server cũng để trống ô cửa trong phép thử đạn).
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
        bucketAdd(
          "windowGlass",
          "#a9cbd6",
          new THREE.PlaneGeometry(windowHalf * 2 - 0.08, windowTop - sill - 0.08),
          (t) => {
            at(t, side * (half - 0.05), (sill + windowTop) / 2, 0);
            t.rotation.y = yaw + Math.PI / 2;
          },
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
        // Mái cần xoay nghiêng nên không dùng chung hàm wall() (không trả về
        // mesh để chỉnh rotation nữa) — gọi bucketAdd trực tiếp.
        bucketAdd(
          roofColor,
          roofColor,
          new THREE.BoxGeometry(w * 0.58, 0.24, w + 0.55),
          (t) => {
            at(t, side * w * 0.245, wallH + w * 0.16, 0);
            // Xoay theo hướng nhà trước rồi mới nghiêng mái.
            t.rotation.order = "YXZ";
            t.rotation.set(0, yaw, -side * 0.48); // lật mái để cả 2 mặt cùng dốc về đỉnh
          },
        );
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
      // Hai dáng cây: thông nhiều tầng (variant 0–1) và cây lá rộng tán tròn
      // (variant 2–3). Gốc lún 0.5 m để cây trên sườn dốc không bị hở chân.
      const sink = 0.5;
      const trunkH = o.h * (o.variant >= 2 ? 0.5 : 0.62) + sink;
      bucketAdd(
        "tree-trunk",
        "#5a4029",
        new THREE.CylinderGeometry(w * 0.14, w * 0.24, trunkH, 6),
        (t) => t.position.set(o.x, baseY - sink + trunkH / 2, o.z),
      );
      if ((o.variant || 0) < 2) {
        const tiers = 4;
        for (let tier = 0; tier < tiers; tier++) {
          const f = tier / (tiers - 1);
          bucketAdd(
            tier % 2 ? "pine-a" : "pine-b",
            tier % 2 ? "#2f5e38" : "#274f30",
            new THREE.ConeGeometry(w * (1.55 - f * 0.9), o.h * 0.36, 8),
            (t) => {
              t.position.set(o.x, baseY + o.h * (0.34 + f * 0.5), o.z);
              t.rotation.y = (o.yaw || 0) + tier;
            },
          );
        }
      } else {
        const leaf = o.variant === 2 ? "#4e7b37" : "#5d8a3e";
        const blobs = [
          [0, 0.72, 0, 1.25],
          [0.55, 0.62, 0.2, 0.9],
          [-0.45, 0.66, -0.3, 0.95],
          [0.1, 0.9, -0.1, 0.85],
        ];
        for (const [bx, by, bz, bs] of blobs)
          bucketAdd(
            "broadleaf-" + o.variant,
            leaf,
            new THREE.IcosahedronGeometry(1, 0),
            (t) => {
              const r = w * 1.35 * bs;
              const c = Math.cos(o.yaw || 0),
                sn = Math.sin(o.yaw || 0);
              t.position.set(
                o.x + (c * bx + sn * bz) * w * 1.4,
                baseY + o.h * by,
                o.z + (-sn * bx + c * bz) * w * 1.4,
              );
              t.scale.set(r, r * 0.8, r);
              t.rotation.y = (o.yaw || 0) + bx;
            },
          );
      }
      break;
    }
    case "deadTree": {
      bucketAdd(
        "deadtree",
        "#70563b",
        new THREE.CylinderGeometry(w * 0.17, w * 0.28, o.h, 5),
        (t) => {
          t.position.set(o.x, o.h / 2 + baseY, o.z);
          if (o.yaw) t.rotation.y = o.yaw;
          t.rotation.z = 0.08;
        },
      );
      for (const side of [-1, 1]) {
        bucketAdd(
          "deadtree",
          "#70563b",
          new THREE.CylinderGeometry(w * 0.08, w * 0.12, o.h * 0.36, 4),
          (t) => {
            t.position.set(o.x + side * w * 0.35, o.h * 0.72 + baseY, o.z);
            if (o.yaw) t.rotation.y = o.yaw;
            t.rotation.z = side * 0.72;
          },
        );
      }
      break;
    }
    case "cactus": {
      bucketAdd(
        "cactus-trunk",
        "#3d7744",
        new THREE.CylinderGeometry(w * 0.22, w * 0.26, o.h, 7),
        (t) => t.position.set(o.x, o.h / 2 + baseY, o.z),
      );
      for (const side of [-1, 1]) {
        bucketAdd(
          "cactus-arm",
          "#4b8948",
          new THREE.CylinderGeometry(w * 0.12, w * 0.15, o.h * 0.38, 6),
          (t) => t.position.set(o.x + side * w * 0.36, o.h * 0.48 + baseY, o.z),
        );
        bucketAdd(
          "cactus-arm",
          "#4b8948",
          new THREE.CylinderGeometry(w * 0.12, w * 0.12, o.h * 0.16, 6),
          (t) => t.position.set(o.x + side * w * 0.36, o.h * 0.64 + baseY, o.z),
        );
      }
      break;
    }
    case "rock": {
      // Đá có mặt lồi lõm (nhiễu theo vị trí đỉnh nên các mặt vẫn khít nhau),
      // lún 20% xuống đất. Đá lớn ở sa mạc thành mỏm đá nhiều tầng.
      const colorA = forest ? "#6f7465" : "#9a7552";
      const colorB = forest ? "#5f6557" : "#86613f";
      const makeRock = (sx, sy, sz, y, spin, color) => {
        const g = new THREE.DodecahedronGeometry(0.5, 1);
        const p = g.attributes.position;
        for (let i = 0; i < p.count; i++) {
          const vx = p.getX(i),
            vy = p.getY(i),
            vz = p.getZ(i);
          const n =
            0.78 +
            0.44 *
              window.LDTerrain.valueNoise(
                vx * 3.1 + o.x * 0.37,
                vz * 3.1 + vy * 2.3 + o.z * 0.37,
                7,
              );
          p.setXYZ(i, vx * n, vy * n, vz * n);
        }
        g.computeVertexNormals();
        bucketAdd("rock-" + color, color, g, (t) => {
          t.position.set(o.x, baseY + y, o.z);
          t.scale.set(sx, sy, sz);
          t.rotation.set(0.1, (o.yaw || 0) + spin, 0.08);
        });
      };
      makeRock(w, o.h, w * 0.82, o.h * 0.3, 0, o.variant % 2 ? colorA : colorB);
      if (w > 4.5) {
        // Tầng đá phía trên, lệch tâm — nhìn như mỏm đá phong hoá.
        makeRock(w * 0.62, o.h * 0.55, w * 0.55, o.h * 0.72, 1.3, colorA);
      }
      break;
    }
    // Núi/đồi, cao nguyên, nền nhà, đầm lầy đã nằm trong mặt địa hình liền khối.
  }
}
// ---- Cỏ: bụi cỏ lá mảnh, dày, chỉ vẽ gần người chơi ----
// Mỗi "bụi" là 5 lá mảnh (rộng ~5 cm) nghiêng ngẫu nhiên, màu sẫm ở gốc sáng ở
// ngọn, gộp sẵn thành MỘT geometry và nhân bản bằng InstancedMesh. Bụi được
// chia ô 25 m; chỉ các ô trong tầm GRASS_VIEW_DISTANCE mới được vẽ.
function grassTuftGeometry(blades, height, seed) {
  const rnd = (() => {
    let s = seed >>> 0;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  })();
  const pos = [],
    col = [],
    index = [];
  const base = new THREE.Color("#2e4a22"),
    tip = new THREE.Color("#b7cf7a");
  for (let b = 0; b < blades; b++) {
    const a = rnd() * Math.PI * 2;
    const ox = (rnd() - 0.5) * 0.18,
      oz = (rnd() - 0.5) * 0.18;
    const h = height * (0.6 + rnd() * 0.55);
    const lean = 0.15 + rnd() * 0.3;
    const w = 0.022 + rnd() * 0.014;
    const cx = Math.cos(a),
      cz = Math.sin(a);
    const lx = -Math.sin(a) * lean * h,
      lz = Math.cos(a) * lean * h;
    const v0 = pos.length / 3;
    // gốc trái, gốc phải, giữa trái, giữa phải, ngọn
    const pts = [
      [ox - cx * w, 0, oz - cz * w, 0],
      [ox + cx * w, 0, oz + cz * w, 0],
      [
        ox - cx * w * 0.7 + lx * 0.35,
        h * 0.55,
        oz - cz * w * 0.7 + lz * 0.35,
        0.55,
      ],
      [
        ox + cx * w * 0.7 + lx * 0.35,
        h * 0.55,
        oz + cz * w * 0.7 + lz * 0.35,
        0.55,
      ],
      [ox + lx, h, oz + lz, 1],
    ];
    for (const [x, y, z, t] of pts) {
      pos.push(x, y, z);
      const c = base.clone().lerp(tip, t);
      col.push(c.r, c.g, c.b);
    }
    index.push(
      v0,
      v0 + 1,
      v0 + 2,
      v0 + 1,
      v0 + 3,
      v0 + 2,
      v0 + 2,
      v0 + 3,
      v0 + 4,
    );
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}
function nearHouse(x, z, margin) {
  for (const o of obstaclesNear(x, z))
    if (
      (o.type === "house" || o.type === "hut") &&
      Math.hypot(o.x - x, o.z - z) < o.w * 0.72 + margin
    )
      return true;
  return false;
}
function addGrass(forest) {
  const lowQuality = $("#quality")?.value === "Performance";
  GRASS_VIEW_DISTANCE = lowQuality ? 50 : 75;
  const seed =
    (mapObstacles.find((o) => o.type === "terrain")?.seed || 1) >>> 0;
  let s = seed ^ 0x9e3779b9;
  const rand = () =>
    (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  const kinds = {
    grass: { geometry: grassTuftGeometry(5, 0.55, seed), chunks: new Map() },
    reed: { geometry: grassTuftGeometry(4, 1.5, seed + 3), chunks: new Map() },
  };
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  const push = (kind, x, z, scale, color) => {
    dummy.position.set(x, groundHeightAt(x, z) - 0.02, z);
    dummy.rotation.set(0, rand() * Math.PI * 2, 0);
    dummy.scale.set(scale, scale * (0.8 + rand() * 0.5), scale);
    dummy.updateMatrix();
    const key = `${Math.floor(x / GRASS_CHUNK)}|${Math.floor(z / GRASS_CHUNK)}`;
    const chunks = kinds[kind].chunks;
    if (!chunks.has(key)) chunks.set(key, { matrices: [], colors: [] });
    chunks.get(key).matrices.push(dummy.matrix.clone());
    chunks.get(key).colors.push(color.clone());
  };
  const spacing = (forest ? 1.2 : 3.6) * (lowQuality ? 1.45 : 1);
  for (let gz = -MAP_HALF + 1; gz < MAP_HALF - 1; gz += spacing)
    for (let gx = -MAP_HALF + 1; gx < MAP_HALF - 1; gx += spacing) {
      const x = gx + (rand() - 0.5) * spacing,
        z = gz + (rand() - 0.5) * spacing;
      const r = rand();
      if (Math.abs(x) < 6 && Math.abs(z) < 12) continue; // khu chờ đầu trận
      if (waterBedDepth(x, z) > 0) continue;
      if (forest && inSwamp(x, z)) {
        if (r < 0.7)
          push(
            "reed",
            x,
            z,
            0.8 + rand() * 0.6,
            tint.setHSL(0.17 + rand() * 0.04, 0.35, 0.3 + rand() * 0.12),
          );
        continue;
      }
      if (isNearRoad(x, z, 0.9) || nearHouse(x, z, 0.3)) continue;
      const h = mapTerrain.heightAt(x, z);
      const slope = mapTerrain.slopeAt(x, z);
      if (forest) {
        // Thưa dần lên cao, không mọc trên vách đá / đỉnh núi.
        if (slope > 0.55 || h > 40 || r > 1 - Math.min(0.85, h / 48)) {
        } else
          push(
            "grass",
            x,
            z,
            0.75 + rand() * 0.7,
            tint.setHSL(
              0.22 + rand() * 0.07,
              0.45 + rand() * 0.2,
              0.55 + rand() * 0.25,
            ),
          );
      } else if (slope < 0.35 && h < 24 && r < 0.55) {
        push(
          "grass",
          x,
          z,
          0.6 + rand() * 0.5,
          tint.setHSL(0.11 + rand() * 0.03, 0.35, 0.6 + rand() * 0.15),
        );
      }
    }
  grassChunks = [];
  for (const kind of Object.values(kinds))
    for (const chunk of kind.chunks.values()) {
      const mesh = new THREE.InstancedMesh(
        kind.geometry,
        material,
        chunk.matrices.length,
      );
      chunk.matrices.forEach((matrix, index) => {
        mesh.setMatrixAt(index, matrix);
        mesh.setColorAt(index, chunk.colors[index]);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.visible = false;
      scene.add(mesh);
      grassChunks.push(mesh);
    }
  grassCheckAt = 0;
}
const GRASS_CHUNK = 25;
let GRASS_VIEW_DISTANCE = 75;
let grassChunks = [],
  grassCheckAt = 0;
// Chỉ vẽ các ô cỏ gần camera; trên máy bay / rơi cao thì tắt hết.
function updateGrassVisibility() {
  if (!grassChunks.length || !camera) return;
  const now = performance.now();
  if (now < grassCheckAt) return;
  grassCheckAt = now + 200;
  const high =
    local.state === "plane" ||
    camera.position.y - groundHeightAt(camera.position.x, camera.position.z) >
      60;
  for (const mesh of grassChunks) {
    const sphere = mesh.boundingSphere;
    const d =
      Math.hypot(
        sphere.center.x - camera.position.x,
        sphere.center.z - camera.position.z,
      ) - sphere.radius;
    mesh.visible = !high && d < GRASS_VIEW_DISTANCE;
  }
}
// Match the road clearance used by server-side obstacle and loot placement.
function isNearRoad(x, z, clearance = 0) {
  return obstaclesNear(x, z).some((road) => {
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
  for (const o of obstaclesNear(x, z)) {
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
    if (o.type === "fence") {
      const dx = x - o.x,
        dz = z - o.z;
      const c = Math.cos(o.yaw || 0),
        s = Math.sin(o.yaw || 0);
      if (
        Math.abs(c * dx - s * dz) < o.w / 2 + obstacleRadius &&
        Math.abs(s * dx + c * dz) < o.length / 2 + obstacleRadius
      )
        return true;
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

// Clear-weather fog only: fade the area outside the map while testing without weather.
const FOG_CLEAR = { forest: [140, 360], desert: [140, 360] };
let fogBaseNear = 32,
  fogBaseFar = 125;
function applyBaseFog(forest) {
  const [near, far] = FOG_CLEAR[forest ? "forest" : "desert"];
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
  // Vô lăng thật của xe: trụ lái nghiêng về phía tài xế; nhóm "steering" quay
  // quanh trục vô lăng. Hai bàn tay (găng + cẳng tay) của tài xế là con của
  // vô lăng nên xoay theo khi đánh lái — chỉ hiện khi CHÍNH mình cầm lái xe này.
  const steeringPivot = new THREE.Group();
  steeringPivot.position.set(-0.43, 1.03, -0.26);
  steeringPivot.rotation.set(-0.42, Math.PI, 0);
  root.add(steeringPivot);
  const steering = new THREE.Group();
  steeringPivot.add(steering);
  steering.add(new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.03, 8, 24), trim));
  for (const angle of [Math.PI / 2, (Math.PI * 7) / 6, -Math.PI / 6]) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.03, 0.02), trim);
    spoke.position.set(Math.cos(angle) * 0.1, Math.sin(angle) * 0.1, 0.01);
    spoke.rotation.z = angle;
    steering.add(spoke);
  }
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.055, 0.05, 12).rotateX(Math.PI / 2),
    makeMat("#3a3d38"),
  );
  hub.position.z = 0.015;
  steering.add(hub);
  // Găng tay nắm vành ở 9 giờ / 3 giờ: là con của vô lăng nên xoay theo vành.
  // Cẳng tay KHÔNG xoay theo vô lăng: mỗi khung hình được nối lại từ khuỷu tay
  // (cố định, phía dưới – sau vô lăng, về phía người lái) tới đúng găng tay.
  const driverHands = new THREE.Group();
  const gloveMat = makeMat("#26261f");
  const sleeveMat = makeMat("#5a5f48");
  const gloves = [],
    forearms = [];
  for (const side of [-1, 1]) {
    const glove = new THREE.Mesh(new THREE.SphereGeometry(0.046, 10, 8), gloveMat);
    glove.scale.set(1, 1.2, 1.1);
    glove.position.set(side * 0.22, 0, 0);
    steering.add(glove);
    gloves.push(glove);
    const forearm = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.04, 0.3, 4, 8).rotateX(Math.PI / 2),
      sleeveMat,
    );
    driverHands.add(forearm);
    forearms.push({ mesh: forearm, side });
  }
  driverHands.visible = false;
  steeringPivot.add(driverHands);
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
    driverHands,
    gloves,
    forearms,
    steerSpin: 0,
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
// ---------------------------------------------------------------------------
// NỘI SUY MẠNG (người chơi khác + xe)
// ---------------------------------------------------------------------------
// Server gửi 20 gói/giây nhưng qua Wi-Fi gói tới không đều. Trước đây mỗi gói
// "giật" avatar/xe tới vị trí mới (hoặc lerp đuổi theo mục tiêu nhảy cóc) →
// thấy người khác giật, xe tele. Nay mỗi vật thể giữ vài snapshot gắn mốc
// thời gian SERVER và được vẽ trễ cố định INTERP_DELAY_MS, luôn nằm giữa hai
// snapshot thật → chuyển động liên tục dù gói tới sớm/muộn. Server giữ lịch
// sử vị trí 1 s (claimAlong) nên bắn trúng thứ mình nhìn thấy vẫn được tính.
const INTERP_DELAY_MS = 100;
const MAX_EXTRAPOLATE_MS = 150;
const angleDelta = (from, to) =>
  Math.atan2(Math.sin(to - from), Math.cos(to - from));
function pushSnapshot(list, snap, teleportDistance = 8) {
  const last = list[list.length - 1];
  if (last) {
    if (snap.t <= last.t) {
      // Cùng mốc thời gian: chỉ cập nhật giá trị mới nhất.
      Object.assign(last, snap);
      return;
    }
    // Hồi sinh / ra xe / sửa vị trí lớn từ server: nhảy thẳng, không trượt dài.
    if (Math.hypot(snap.x - last.x, snap.z - last.z) > teleportDistance)
      list.length = 0;
  }
  list.push(snap);
  if (list.length > 10) list.shift();
}
function sampleSnapshots(list, renderT, out) {
  const n = list.length;
  if (!n) return null;
  const last = list[n - 1];
  if (n === 1 || renderT <= list[0].t) {
    const s = n === 1 || renderT >= last.t ? last : list[0];
    out.x = s.x;
    out.y = s.y ?? 0;
    out.z = s.z;
    out.yaw = s.yaw;
    return out;
  }
  let a, b, k;
  if (renderT >= last.t) {
    // Gói kế tiếp tới muộn: ngoại suy ngắn theo vận tốc gần nhất rồi dừng.
    a = list[n - 2];
    b = last;
    k =
      1 + Math.min(renderT - b.t, MAX_EXTRAPOLATE_MS) / Math.max(1, b.t - a.t);
  } else {
    let i = n - 1;
    while (i > 1 && list[i - 1].t > renderT) i--;
    a = list[i - 1];
    b = list[i];
    k = (renderT - a.t) / Math.max(1, b.t - a.t);
  }
  out.x = a.x + (b.x - a.x) * k;
  out.y = (a.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * k;
  out.z = a.z + (b.z - a.z) * k;
  out.yaw = a.yaw + angleDelta(a.yaw, b.yaw) * k;
  return out;
}
const vehicleSnaps = new Map();
const vehicleSample = { x: 0, y: 0, z: 0, yaw: 0 };
// Xe do chính mình lái: mô phỏng ngay trên máy (cùng công thức với server) để
// phản hồi phím tức thì; mỗi gói server được "bù" bằng một độ lệch hiển thị
// giảm dần thay vì kéo giật xe về → hết tele khi chạy nhanh / lên dốc.
let driveSim = null;
function carInputs() {
  if (paused) return { throttle: 0, steer: 0, brake: false };
  return {
    throttle: keys.KeyW ? 1 : keys.KeyS ? -1 : 0,
    steer: (keys.KeyA ? 1 : 0) - (keys.KeyD ? 1 : 0),
    brake: Boolean(keys.Space),
  };
}
function stepCar(state, input, dt) {
  if (input.brake) state.speed *= Math.max(0, 1 - 7 * dt);
  else if (input.throttle)
    state.speed = Math.max(
      -7,
      Math.min(22, state.speed + input.throttle * 8 * dt),
    );
  else {
    // Trôi theo quán tính (giống hệt server): ma sát lăn + cản gió.
    const drag = (0.9 + 0.08 * Math.abs(state.speed)) * dt;
    state.speed -= Math.sign(state.speed) * Math.min(Math.abs(state.speed), drag);
  }
  const speedFactor = Math.min(1, Math.abs(state.speed) / 4);
  state.yaw +=
    input.steer * 1.35 * speedFactor * dt * (state.speed < 0 ? -1 : 1);
  state.x -= Math.sin(state.yaw) * state.speed * dt;
  state.z -= Math.cos(state.yaw) * state.speed * dt;
}
function reconcileDrive(vehicle) {
  // Gói server phản ánh phím đã gửi khoảng 1 RTT trước: tua trạng thái server
  // tiến lên đúng khoảng đó bằng phím hiện tại để ra "hiện tại" của máy mình.
  const lead = Math.min(0.3, (rttMs || 60) / 1000 + 0.025);
  const next = {
    x: vehicle.x,
    z: vehicle.z,
    yaw: vehicle.yaw,
    speed: vehicle.speed,
  };
  const input = carInputs();
  for (let left = lead; left > 1e-4; left -= 1 / 60)
    stepCar(next, input, Math.min(1 / 60, left));
  if (driveSim && driveSim.id === vehicle.id) {
    const shownX = driveSim.x + driveSim.ox;
    const shownZ = driveSim.z + driveSim.oz;
    const shownYaw = driveSim.yaw + driveSim.oyaw;
    driveSim.ox = shownX - next.x;
    driveSim.oz = shownZ - next.z;
    driveSim.oyaw = angleDelta(next.yaw, shownYaw);
    // Lệch quá xa (va chạm mạnh, xe chìm...) thì chấp nhận nhảy ngay.
    if (Math.hypot(driveSim.ox, driveSim.oz) > 5)
      driveSim.ox = driveSim.oz = driveSim.oyaw = 0;
    Object.assign(driveSim, next);
  } else {
    driveSim = { id: vehicle.id, ...next, ox: 0, oz: 0, oyaw: 0 };
  }
}
function recordVehicleSnapshots(vehicles, serverTime) {
  for (const v of vehicles) {
    let list = vehicleSnaps.get(v.id);
    if (!list) vehicleSnaps.set(v.id, (list = []));
    pushSnapshot(list, { t: serverTime, x: v.x, y: 0, z: v.z, yaw: v.yaw }, 12);
  }
  const driving = local.vehicleSeat === 0 && local.vehicleId;
  const own = driving && vehicles.find((v) => v.id === local.vehicleId);
  if (own && !own.destroyed && !own.submerged) reconcileDrive(own);
  else driveSim = null;
}
// Nghiêng thân xe theo mặt dốc (4 điểm lấy độ cao quanh xe).
function tiltCarToGround(mesh, x, z, yaw) {
  const s = Math.sin(yaw),
    c = Math.cos(yaw);
  const front = groundHeightAt(x - s * 1.5, z - c * 1.5);
  const back = groundHeightAt(x + s * 1.5, z + c * 1.5);
  const right = groundHeightAt(x + c * 0.9, z - s * 0.9);
  const left = groundHeightAt(x - c * 0.9, z + s * 0.9);
  mesh.rotation.x = Math.atan2(front - back, 3);
  mesh.rotation.z = Math.atan2(right - left, 1.8);
}
// Cẳng tay tài xế (góc nhìn thứ nhất): từ khuỷu cố định tới găng trên vành.
// Toạ độ trong khung trụ lái: +Z hướng ra đầu xe, người lái ở phía -Z.
const _elbow = new THREE.Vector3(),
  _grip = new THREE.Vector3(),
  _armDir = new THREE.Vector3(),
  _armAxis = new THREE.Vector3(0, 0, 1);
function poseDriverForearms(ud) {
  const spin = ud.steerSpin;
  ud.forearms.forEach(({ mesh, side }) => {
    _grip.set(side * 0.22 * Math.cos(spin), side * 0.22 * Math.sin(spin), 0);
    _elbow.set(side * 0.27, -0.2, -0.36);
    _armDir.subVectors(_grip, _elbow);
    const length = _armDir.length();
    mesh.position.addVectors(_grip, _elbow).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(_armAxis, _armDir.normalize());
    mesh.scale.set(1, 1, length / 0.38);
  });
}
function updateVehicleMeshes(dt) {
  const vehicles = gameState?.vehicles || [];
  const liveIds = new Set();
  const renderT = serverNow() - INTERP_DELAY_MS;
  for (const vehicle of vehicles) {
    liveIds.add(vehicle.id);
    let mesh = vehicleMeshes.get(vehicle.id);
    if (!mesh) {
      mesh = buildCarMesh(vehicle, mapId === "forest");
      mesh.rotation.order = "YXZ";
      scene.add(mesh);
      vehicleMeshes.set(vehicle.id, mesh);
    }
    mesh.rotation.order = "YXZ";
    const localDriver =
      driveSim &&
      driveSim.id === vehicle.id &&
      local.vehicleId === vehicle.id &&
      local.vehicleSeat === 0 &&
      !vehicle.destroyed &&
      !vehicle.submerged;
    let targetX, targetZ, targetYaw;
    if (localDriver) {
      stepCar(driveSim, carInputs(), dt);
      const decay = Math.exp(-7 * dt);
      driveSim.ox *= decay;
      driveSim.oz *= decay;
      driveSim.oyaw *= decay;
      targetX = driveSim.x + driveSim.ox;
      targetZ = driveSim.z + driveSim.oz;
      targetYaw = driveSim.yaw + driveSim.oyaw;
    } else {
      const s = sampleSnapshots(
        vehicleSnaps.get(vehicle.id) || [],
        renderT,
        vehicleSample,
      );
      targetX = s ? s.x : vehicle.x;
      targetZ = s ? s.z : vehicle.z;
      targetYaw = s ? s.yaw : vehicle.yaw;
    }
    const targetY = groundHeightAt(targetX, targetZ) - (vehicle.sinkDepth || 0);
    mesh.position.x = targetX;
    mesh.position.z = targetZ;
    // Độ cao nền là hàm liên tục nên bám thẳng; chỉ làm mềm bậc cầu 0.3 m.
    mesh.position.y +=
      (targetY - mesh.position.y) *
      (Math.abs(targetY - mesh.position.y) > 0.25 ? Math.min(18 * dt, 1) : 1);
    mesh.rotation.y = targetYaw;
    if (!vehicle.destroyed && !vehicle.submerged)
      tiltCarToGround(mesh, targetX, targetZ, targetYaw);
    const ud = mesh.userData;
    // Đánh lái: vô lăng quay tối đa ~100°, về giữa mượt khi thả phím.
    const iDrive = local.vehicleId === vehicle.id && local.vehicleSeat === 0;
    const steerInput = iDrive ? carInputs().steer : vehicle.steer || 0;
    // Vô lăng quay mặt về tài xế: rẽ trái (steer +1) = quay NGƯỢC chiều kim đồng hồ
    // khi tài xế nhìn vào, tức góc âm quanh trục cục bộ của vô lăng.
    ud.steerSpin += (-steerInput * 1.75 - ud.steerSpin) * Math.min(1, 7 * dt);
    ud.steering.rotation.z = ud.steerSpin;
    const showHands = iDrive && !deathView;
    ud.driverHands.visible = showHands;
    for (const glove of ud.gloves) glove.visible = showHands;
    if (showHands) poseDriverForearms(ud);
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
const vehicleEye = new THREE.Vector3(),
  vehicleTilt = new THREE.Quaternion(),
  vehicleYawInv = new THREE.Quaternion(),
  vehicleLook = new THREE.Quaternion(),
  vehicleEuler = new THREE.Euler(),
  UP_AXIS = new THREE.Vector3(0, 1, 0);
let vehiclePitch = 0; // góc cúi/ngửa của hành khách, tách khỏi độ nghiêng xe
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
    return;
  }
  const carMesh = vehicleMeshes.get(vehicle.id);
  const yaw = carMesh?.rotation.y ?? vehicle.yaw;
  const seatX = local.vehicleSeat === 0 ? -0.43 : 0.43;
  const eyeY = local.vehicleSeat === 0 ? 1.32 : 1.28;
  camera.rotation.order = "YXZ";
  if (carMesh) {
    // Mắt đặt đúng ghế theo khung xe (đã nghiêng theo dốc), camera nghiêng
    // cùng thân xe: lên dốc thấy đầu xe ngóc lên, qua sườn đồi thấy xe nghiêng.
    carMesh.updateMatrixWorld();
    vehicleEye.set(seatX, eyeY, 0.18);
    carMesh.localToWorld(vehicleEye);
    camera.position.copy(vehicleEye);
    local.x = vehicleEye.x;
    local.z = vehicleEye.z;
    local.groundY = carMesh.position.y;
    if (local.vehicleSeat === 0) {
      local.yaw = yaw;
      camera.quaternion.copy(carMesh.quaternion);
    } else {
      // Hành khách nhìn tự do (yaw/pitch riêng) nhưng vẫn nghiêng theo khung xe.
      vehicleTilt.copy(carMesh.quaternion).premultiply(
        vehicleYawInv.setFromAxisAngle(UP_AXIS, -yaw),
      );
      vehicleLook.setFromEuler(vehicleEuler.set(vehiclePitch, local.yaw, 0, "YXZ"));
      camera.quaternion.copy(vehicleYawInv.setFromAxisAngle(UP_AXIS, yaw))
        .multiply(vehicleTilt)
        .multiply(vehicleYawInv.setFromAxisAngle(UP_AXIS, -yaw))
        .multiply(vehicleLook);
    }
  } else {
    local.groundY = groundHeightAt(vehicle.x, vehicle.z);
    camera.position.set(vehicle.x, local.groundY + eyeY, vehicle.z);
    if (local.vehicleSeat === 0) local.yaw = yaw;
    camera.rotation.set(local.vehicleSeat === 0 ? 0 : vehiclePitch, local.yaw, 0);
  }
  if (gun) gun.visible = false;
  if (hud) {
    hud.classList.remove("hidden");
    // Tốc độ hiển thị theo xe đang vẽ (dự đoán) để khớp cảm giác lái.
    const shownSpeed =
      driveSim && driveSim.id === vehicle.id ? driveSim.speed : vehicle.speed;
    setText($("#vehicleSpeed"), Math.round(Math.abs(shownSpeed) * 3.6));
    setText(
      $("#vehicleHP"),
      vehicle.submerged
        ? "XE CHÌM · ĐỘNG CƠ ĐÃ TẮT"
        : vehicle.destroyed
          ? "XE ĐÃ NỔ · CỐ ĐỊNH"
          : `XE ${Math.round(vehicle.hp)}/60 HP${vehicle.smoke >= 2 ? " · KHÓI DÀY" : vehicle.smoke ? " · ĐANG BỐC KHÓI" : ""}`,
    );
    setText(
      $("#vehicleStatus"),
      vehicle.submerged
        ? "XE CHÌM · ĐỘNG CƠ ĐÃ TẮT"
        : vehicle.destroyed
          ? "XE ĐÃ CHÁY"
          : local.vehicleSeat === 0
            ? "TÀI XẾ · CLICK BÓP KÈN"
            : "HÀNH KHÁCH · F ĐỂ XUỐNG",
    );
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
  applyBaseFog(forest); // weather disabled; retain clear map-edge fog only
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
    // Laptop có 2 GPU: ưu tiên card rời để khung hình ổn định.
    powerPreference: "high-performance",
    stencil: false,
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
    setMapObstacles(gameState?.obstacles || []);
  }
  // Bucket gộp hình phải sẵn sàng trước: mặt đường / cầu cũng được gộp vào đó.
  mergeBuckets = {};
  createGroundMesh(forest);
  addOutskirts(forest);
  // Không còn vẽ 4 bức tường xanh vuông quanh map: viền map giờ là dãy núi.
  addSafeZoneWall();
  addGrass(forest);
  for (const obstacle of mapObstacles) drawMapObject(obstacle, forest);
  flushMergeBuckets(); // dồn toàn bộ nhà/cây/đá/xương rồng thành vài chục draw call
  // First-person weapon silhouette attached to the camera.
  // Súng cầm tay góc nhìn thứ nhất: AUG gắn red dot và Kar98k gắn ống 8x.
  // Tâm red dot đặt đúng (0.28, -0.075) so với camera: khi ngắm, súng dịch
  // (-0.28, +0.075) (updateGunPose) nên chấm đỏ nằm ngay giữa màn hình.
  gun = new THREE.Group();
  const aug = buildAug();
  aug.position.set(0.28, -0.075 - aug.userData.sightY, -0.57);
  gun.add(aug);
  const kar = buildKar98();
  kar.position.set(0.27, -0.235, -0.52);
  kar.visible = false;
  gun.add(kar);
  // Beryl M762: đường thước ngắm cũng đặt ở (0.28, -0.075) nên ngắm bằng
  // chuột phải là thước ngắm sau + đầu ruồi thẳng hàng giữa màn hình.
  const beryl = buildBeryl();
  beryl.position.set(0.28, -0.075 - beryl.userData.sightY, -0.52);
  beryl.visible = false;
  gun.add(beryl);
  // Tay không: hai nắm tay đeo găng + cẳng tay, thế thủ ở hai góc dưới màn hình.
  const fists = new THREE.Group();
  const gloveMat = makeMat("#26261f"),
    sleeveMat = makeMat("#5a5f48");
  fists.userData.hands = [-1, 1].map((side) => {
    const hand = new THREE.Group();
    const fist = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.08, 0.1), gloveMat);
    hand.add(fist);
    const forearm = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.045, 0.3, 4, 8).rotateX(Math.PI / 2),
      sleeveMat,
    );
    forearm.position.set(0, -0.03, 0.2);
    hand.add(forearm);
    hand.userData.rest = new THREE.Vector3(side * 0.24, -0.28, -0.46);
    hand.position.copy(hand.userData.rest);
    hand.rotation.set(0.25, -side * 0.12, side * 0.2);
    fists.add(hand);
    return hand;
  });
  fists.visible = false;
  gun.add(fists);
  const flashes = {};
  for (const [key, model] of [
    ["ranger", aug],
    ["sniper", kar],
    ["beryl", beryl],
  ]) {
    const flash = makeMuzzleFlash(key === "sniper" ? 1.25 : 0.95);
    flash.position.copy(model.userData.muzzle);
    model.add(flash);
    flashes[key] = flash;
    const mag = model.userData.magazine;
    mag.userData.base = mag.position.clone();
    mag.userData.baseRot = mag.rotation.clone();
  }
  gun.userData.magazine = aug.userData.magazine;
  gun.userData.magazines = {
    ranger: aug.userData.magazine,
    sniper: kar.userData.magazine,
    beryl: beryl.userData.magazine,
  };
  // Mô hình theo từng loại vũ khí; "none" = hai nắm đấm.
  gun.userData.models = { ranger: aug, sniper: kar, beryl, none: fists };
  gun.userData.fists = fists;
  gun.userData.punchAt = 0;
  gun.userData.punchSide = 1;
  gun.userData.flashes = flashes;
  gun.userData.bolt = kar.userData.bolt;
  gun.userData.boltAt = 0;
  gun.visible = false; // phòng chờ / máy bay / đang nhảy dù: tay không, chỉ cầm súng sau khi tiếp đất
  camera.add(gun);
  updateLocalWeaponVisual(); // bắt đầu trận bằng tay không (hoặc vũ khí đang có)
  // (Vô lăng giả gắn vào camera đã bỏ: tài xế nhìn thấy và cầm vô lăng THẬT của xe.)
  // Đèn chớp nòng tạo SẴN (cường độ 0). Số lượng đèn trong scene phải cố định
  // suốt trận, nếu không mỗi lần đổi Three.js phải biên dịch lại shader.
  muzzleFlash = new THREE.PointLight(0xffc66b, 0, 3);
  muzzleFlash.position.set(0.28, -0.22, -1);
  camera.add(muzzleFlash);
  scene.add(camera);
  // weatherActive = false; // weather sync disabled for performance profiling
  planeObject = buildPlane();
  planeObject.visible = false;
  scene.add(planeObject);
  // Đèn tín hiệu nhảy dù tách khỏi máy bay và luôn nằm trong scene (cường độ 0
  // khi không dùng). Đèn nằm trong nhóm bị ẩn sẽ bị bỏ khỏi danh sách đèn →
  // mỗi lần máy bay hiện/ẩn toàn bộ vật liệu phải biên dịch lại shader (khựng).
  const planeLight = planeObject.userData.jumpPointLight;
  planeObject.remove(planeLight);
  planeLight.intensity = 0;
  scene.add(planeLight);
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
  warmupShaders();
  addEventListener("resize", resizeWorld);
  requestAnimationFrame(frame);
}
// Biên dịch sẵn MỌI shader ngay khi vào map. Nếu không, lần đầu tiên cỏ /
// loot / chớp nòng / nhân vật địch / hạt máu xuất hiện, trình duyệt phải dừng
// để biên dịch shader → khựng 50–200 ms giữa trận (thường đúng lúc đấu súng).
function warmupShaders() {
  if (!renderer || !scene || !camera) return;
  const kit = new THREE.Group();
  try {
    const { root, rig } = buildAvatar(catHeadMaterials, catEarMat);
    for (const kind of ["ranger", "sniper", "beryl"]) {
      const weapon = buildBakedWeapon(kind, mergeGeometries);
      const flash = makeMuzzleFlash(1);
      flash.visible = true;
      weapon.add(flash);
      rig.weaponMount.add(weapon);
    }
    kit.add(root);
    const indicators = indicatorAssets();
    kit.add(new THREE.Mesh(indicators.ring, indicators.ringMat));
    kit.add(new THREE.Mesh(indicators.cross, indicators.crossMat));
    for (const material of bloodMaterials) kit.add(new THREE.Mesh(bloodGeometry, material));
    kit.add(buildChute());
  } catch (error) {
    console.warn("warmup kit:", error);
  }
  kit.position.copy(camera.position);
  scene.add(kit);
  // Tạm bật mọi vật đang ẩn (cỏ xa, loot xa, súng tay, máy bay...) để compile.
  const hidden = [];
  scene.traverse((o) => {
    if (!o.visible) {
      hidden.push(o);
      o.visible = true;
    }
  });
  try {
    renderer.compile(scene, camera);
  } catch (error) {
    console.warn("shader warmup:", error);
  }
  for (const o of hidden) o.visible = false;
  scene.remove(kit);
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
  return (
    Math.min(devicePixelRatio || 1, caps[$("#quality").value] || 1.25) *
    resolutionScale
  );
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
// Đầu mèo: 6 ảnh (phải, trái lật gương, trên xoay 180°, dưới, sau, mặt) được
// vẽ vào MỘT texture atlas 3×2 → cái đầu chỉ tốn 1 lần vẽ thay vì 6.
const HEAD_ATLAS_CELL = 256;
const headAtlasCanvas = document.createElement("canvas");
headAtlasCanvas.width = HEAD_ATLAS_CELL * 3;
headAtlasCanvas.height = HEAD_ATLAS_CELL * 2;
const headAtlasTexture = new THREE.CanvasTexture(headAtlasCanvas);
headAtlasTexture.colorSpace = THREE.SRGBColorSpace;
[
  ["side", "none"],
  ["side", "mirror"],
  ["top", "rotate"],
  ["bottom", "none"],
  ["back-zoom", "none"],
  ["face-zoom", "none"],
].forEach(([name, transform], face) => {
  const img = new Image();
  img.onload = () => {
    const ctx = headAtlasCanvas.getContext("2d");
    const S = HEAD_ATLAS_CELL;
    const x = (face % 3) * S,
      y = Math.floor(face / 3) * S;
    ctx.save();
    if (transform === "mirror") {
      ctx.translate(x + S, y);
      ctx.scale(-1, 1);
    } else if (transform === "rotate") {
      ctx.translate(x + S, y + S);
      ctx.rotate(Math.PI);
    } else ctx.translate(x, y);
    ctx.drawImage(img, 0, 0, S, S);
    ctx.restore();
    headAtlasTexture.needsUpdate = true;
  };
  img.src = `/cat-head-${name}.${name.endsWith("-zoom") ? "jpg" : "png"}`;
});
const catHeadMaterials = new THREE.MeshLambertMaterial({
  map: headAtlasTexture,
});
catHeadMaterials.userData.headAtlas = true;
const catEarMat = makeMat("#8a8175");

// Hạt máu dùng chung 1 geometry + 2 material và được tái sử dụng; trước đây mỗi
// phát trúng tạo/hủy 13 geometry + 13 material (bắn auto = hàng trăm/giây).
const bloodGeometry = new THREE.SphereGeometry(0.045, 5, 5);
const bloodMaterials = [
  new THREE.MeshBasicMaterial({ color: 0xf02e42 }),
  new THREE.MeshBasicMaterial({ color: 0xb51228 }),
];
const bloodPool = [];
function spawnBloodBurst(position) {
  if (!scene) return;
  // Giới hạn số hạt cùng lúc để loạt đạn dày không làm tụt khung hình.
  if (bloodParticles.length > 90) return;
  for (let i = 0; i < 13; i++) {
    const particle =
      bloodPool.pop() ||
      new THREE.Mesh(bloodGeometry, bloodMaterials[i % 3 ? 1 : 0]);
    particle.scale.setScalar(1);
    particle.position.copy(position);
    (particle.userData.velocity ||= new THREE.Vector3()).set(
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
function setRemoteMotionMode(ud, mode) {
  if (ud.motionMode === mode) return;
  ud.motionMode = mode;
  ud.snaps = [];
}
function placeRemote(mesh, p) {
  const ud = mesh.userData;
  const st = p.state || "lobby";
  ud.seat = p.seat || 0;
  if (p.vehicleId) {
    // Vị trí lấy từ chính mesh xe đang vẽ (updateRemoteMotion) để người ngồi
    // luôn dính đúng ghế, không lệch/giật so với thân xe.
    setRemoteMotionMode(ud, "vehicle");
    ud.vehicleId = p.vehicleId;
    ud.vehicleSeat = p.vehicleSeat;
    mesh.rotation.set(0, p.yaw, 0);
    if (!vehicleMeshes.has(p.vehicleId))
      mesh.position.set(p.x, (p.groundY || 0) + 0.08, p.z);
    mesh.scale.set(1, 1, 1);
    return;
  }
  if (st === "plane") {
    setRemoteMotionMode(ud, "plane");
    mesh.rotation.set(0, p.yaw, 0);
    mesh.scale.set(1, 1, 1);
    return;
  }
  if (st === "freefall" || st === "parachute") {
    setRemoteMotionMode(ud, "air");
    pushSnapshot(
      ud.snaps,
      {
        t: snapshotServerTime,
        x: p.x,
        y: (p.y ?? 0) + (st === "freefall" ? 0.5 : 0),
        z: p.z,
        yaw: p.yaw,
      },
      40,
    );
    // Rơi tự do: nằm sấp, đầu hướng về phía trước (như tư thế nhảy dù); dù bung: đứng thẳng.
    mesh.rotation.x = st === "freefall" ? -1.35 : 0;
    mesh.rotation.z = 0;
    mesh.scale.set(1, 1, 1);
    return;
  }
  setRemoteMotionMode(ud, "ground");
  pushSnapshot(ud.snaps, {
    t: snapshotServerTime,
    x: p.x,
    y: p.swimming
      ? p.swimY || 0
      : (p.groundY || 0) + (p.prone ? 0.35 : p.jumpY || 0),
    z: p.z,
    yaw: p.yaw,
  });
  // Negative X rotation lays local +Y toward local -Z, matching the server's
  // prone hitbox centers (head forward, legs behind).
  const peekRoll = p.prone ? 0 : -(Number(p.peek) || 0) * 0.18;
  mesh.rotation.x = p.prone ? -Math.PI / 2 : 0;
  mesh.rotation.z = peekRoll;
  // Khom người là tư thế (gập gối, cúi thân) do poseAvatar dựng, không bóp dẹt mô hình.
  mesh.scale.set(1, 1, 1);
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
  setText($("#aliveCount"), state.alive);
  const me = state.players.find((player) => player.id === playerId);
  if (me) setText($("#killHud"), me.kills || 0);
  setText($("#totalCount"), state.total);
  if (state.lastElimination && state.lastElimination.id !== lastEliminationId) {
    const event = state.lastElimination;
    lastEliminationId = event.id;
    const row = document.createElement("div");
    row.className = "kill-feed-row";
    row.textContent =
      event.cause === "collision"
        ? `${event.killerName} đã tông ${event.victimName} không thương tiếc`
        : event.killerName === "Nổ xe"
          ? `Nổ xe đã đưa ${event.victimName} đến một nơi tốt hơn`
          : `${event.killerName} đã chịch ${event.victimName} đến chết`;
    $("#killFeed")?.prepend(row);
    const timer = setTimeout(() => row.remove(), 20000);
    killFeedTimers.push(timer);
    if (event.victimId === playerId) {
      localEliminationMessage =
        event.cause === "collision"
          ? `${event.killerName} đã lỡ tông bạn.`
          : event.killerName === "Nổ xe"
            ? `Nổ xe đã đưa ${event.victimName} đến một nơi tốt hơn.`
            : `Bạn đã bị chịch đến chết bởi ${event.killerName}.`;
      $("#resultDetail").textContent = localEliminationMessage;
    }
    if (event.killerId === playerId && event.killerName !== "Nổ xe") {
      matchKills.push({
        name: event.victimName,
        weapon: event.weapon || (event.cause === "collision" ? "XE" : "—"),
        headshot: Boolean(event.headshot),
        distance: event.distance,
        at: Date.now() - startedAt,
      });
      const notice = $("#killNotice");
      if (notice) {
        if (event.cause === "collision") {
          notice.textContent = `Bạn đã tông ${event.victimName} dẹp lép`;
        } else {
          notice.replaceChildren(document.createTextNode("Bạn "));
          const action = document.createElement("span");
          action.className = "kill-notice-action";
          action.textContent = "đã chịch";
          notice.append(
            action,
            document.createTextNode(` ${event.victimName} đến chết.`),
          );
        }
        notice.classList.remove("hidden");
        setTimeout(() => notice.classList.add("hidden"), 10000);
      }
    }
  }
  const living = new Set();
  const nowMs = Date.now();
  for (const p of state.players) {
    if (p.id === playerId) {
      const weaponChanged = local.weapon !== (p.weapon || "none");
      local.weapon = p.weapon || "none";
      if (weaponChanged) updateLocalWeaponVisual();
      local.hp = Math.round(Number(p.hp) || 0);
      local.kills = p.kills;
      local.placement = p.placement || 0;
      // KHÔNG ghi đè local.groundY bằng giá trị server lúc đang đi bộ: gói server
      // tới trễ ~50–150 ms nên độ cao cũ làm client tính sai "đang đứng trên đá /
      // mái nào" → bị chặn hoặc tụt xuống rồi bật lại (màn hình giật về sau).
      // Client tự tính độ cao chân mỗi khung hình (standingHeightAt).
      if (local.state !== "ground" && local.state !== "lobby")
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
        vehiclePitch = 0;
        const vehicle = gameState?.vehicles?.find(
          (v) => v.id === local.vehicleId,
        );
        local.yaw = vehicle?.yaw ?? p.yaw;
        localFootstepDistance = 0;
        stopFiring();
        if (scoped) setScope(false);
      } else if (!local.vehicleId && previousVehicleId) {
        // Snap to the server-confirmed exit point beside the occupied seat.
        local.x = p.x;
        local.z = p.z;
        local.yaw = p.yaw;
        localFootstepDistance = 0;
        // Ra khỏi xe: camera thẳng lại (bỏ độ nghiêng của khung xe).
        if (camera) camera.rotation.set(0, local.yaw, 0, "YXZ");
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
        startReloadSounds(null, local.weapon);
        if (scoped) setScope(false); // đang nạp đạn thì không thể ngắm bắn
      }
      if (!local.reloading) local.reloadStartedAt = 0;
      updateAmmoHud();
      setText($("#feed"), local.reloading ? "⟳ ĐANG NẠP ĐẠN · R" : "");
      setStyle($("#reloadHud"), "display", local.reloading ? "flex" : "none");
      syncLocalState(p);
      continue;
    }
    living.add(p.id);
    let mesh = remoteMeshes.get(p.id);
    if (!mesh) {
      // Nhân vật có khớp (avatar.js): đầu mèo + nón + giáp, súng AUG / Kar98k
      // trên tay với tia lửa đầu nòng dựng sẵn (chỉ bật/tắt khi bắn).
      const { root, rig } = buildAvatar(catHeadMaterials, catEarMat);
      mesh = root;
      const weapon = buildBakedWeapon("ranger", mergeGeometries);
      const sniperWeapon = buildBakedWeapon("sniper", mergeGeometries);
      rig.weaponMount.add(weapon, sniperWeapon);
      const muzzleFlash = makeMuzzleFlash(1);
      muzzleFlash.position.copy(weapon.userData.muzzle);
      weapon.add(muzzleFlash);
      const sniperFlash = makeMuzzleFlash(1.3);
      sniperFlash.position.copy(sniperWeapon.userData.muzzle);
      sniperWeapon.add(sniperFlash);
      const berylWeapon = buildBakedWeapon("beryl", mergeGeometries);
      rig.weaponMount.add(berylWeapon);
      const berylFlash = makeMuzzleFlash(1.15);
      berylFlash.position.copy(berylWeapon.userData.muzzle);
      berylWeapon.add(berylFlash);
      // Vòng nạp đạn và chữ thập hồi máu: mỗi cái là MỘT mesh dùng chung geometry.
      const indicators = indicatorAssets();
      const reloadIndicator = new THREE.Mesh(
        indicators.ring,
        indicators.ringMat,
      );
      reloadIndicator.rotation.x = Math.PI / 2;
      reloadIndicator.position.set(0, 2.35, 0);
      reloadIndicator.visible = false;
      mesh.add(reloadIndicator);
      const healIndicator = new THREE.Mesh(
        indicators.cross,
        indicators.crossMat,
      );
      healIndicator.position.set(0, 2.35, 0);
      healIndicator.visible = false;
      mesh.add(healIndicator);
      const chute = buildChute(); // mái dù, chỉ hiện khi người đó đang thả dù
      chute.visible = false;
      mesh.add(chute);
      mesh.userData = {
        state: p.state || "lobby",
        seat: p.seat || 0,
        chute,
        rig,
        pose: {},
        head: rig.head,
        weapon,
        sniperWeapon,
        berylWeapon,
        muzzleFlash,
        sniperFlash,
        berylFlash,
        reloadIndicator,
        healIndicator,
        shotId: Number(p.shotId) || 0,
        punchId: Number(p.punchId) || 0,
        punchAt: 0,
        punchSide: 1,
        flashUntil: 0,
        kickUntil: 0,
        lastGunshotAt: 0,
        reloading: Boolean(p.reloading),
        lastMotionX: p.x,
        lastMotionZ: p.z,
        footstepDistance: 0,
        speed: 0,
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
    const holding = curState === "ground" && !p.vehicleId;
    mesh.userData.weapon.visible = holding && p.weapon === "ranger";
    mesh.userData.sniperWeapon.visible = holding && p.weapon === "sniper";
    mesh.userData.berylWeapon.visible = holding && p.weapon === "beryl";
    // Cú đấm mới (punchId tăng): hoạt ảnh tay luân phiên + tiếng vút.
    const punchCount = (Number(p.punchId) || 0) - (mesh.userData.punchId || 0);
    if (punchCount > 0) {
      mesh.userData.punchId = Number(p.punchId) || 0;
      mesh.userData.punchSide = -mesh.userData.punchSide;
      mesh.userData.punchAt = nowMs;
      playPunchWhoosh({ x: p.x, y: (p.groundY || 0) + 1.3, z: p.z });
    }
    mesh.userData.chute.visible = curState === "parachute";
    mesh.userData.slowWalking = Boolean(p.slowWalking);
    mesh.userData.crouching = Boolean(p.crouching);
    mesh.userData.prone = Boolean(p.prone);
    mesh.userData.swimming = Boolean(p.swimming);
    // Nhảy: dựng tư thế co gối khi đang ở trên không; phát tiếng đáp đất khi chạm đất.
    const wasJumping = mesh.userData.jumpY > 0.05;
    mesh.userData.jumpY = Number(p.jumpY) || 0;
    if (wasJumping && mesh.userData.jumpY <= 0.02 && p.alive && (p.state || "lobby") === "ground")
      playJumpLand(p.x, p.groundY || 0, p.z, false);
    const wasReloading = Boolean(mesh.userData.reloading);
    mesh.userData.reloading = Boolean(p.reloading);
    if (mesh.userData.reloading && !wasReloading && p.alive)
      startReloadSounds(p.id, p.weapon);
    mesh.userData.reloadIndicator.visible = Boolean(p.reloading);
    mesh.userData.reloadIndicator.position.y = p.prone
      ? 0.8
      : p.crouching
        ? 1.85
        : 2.35;
    mesh.userData.healing = Boolean(p.healing);
    mesh.userData.healIndicator.visible = Boolean(p.healing);
    mesh.userData.healIndicator.position.y = p.prone
      ? 0.8
      : p.crouching
        ? 1.85
        : 2.35;
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
      mesh.userData.flashUntil = nowMs + (p.weapon === "sniper" ? 60 : 45);
      mesh.userData.kickUntil = nowMs + 90;
      fireMuzzleFlash(
        p.weapon === "sniper"
          ? mesh.userData.sniperFlash
          : p.weapon === "beryl"
            ? mesh.userData.berylFlash
            : mesh.userData.muzzleFlash,
      );
      mesh.userData.lastGunshotAt = nowMs;
      const soundBaseY = p.swimming ? p.swimY || 0 : p.groundY || 0;
      const muzzleY = soundBaseY + (p.prone ? 0.55 : p.crouching ? 0.9 : 1.3);
      // Nếu một gói tin gộp nhiều phát thì phát lần lượt, cách nhau 120 ms.
      // Trước đây mỗi phát phát tiếng HAI lần chồng nhau (gấp đôi số audio
      // node + bộ lọc HRTF khi đối phương xả đạn). Một lần với âm lượng bù tương đương.
      for (let i = 0; i < Math.min(shotCount, 4); i++) {
        playSpatialGunshot(
          { x: p.x, y: muzzleY, z: p.z },
          1.25,
          i * 0.06,
          p.weapon === "sniper" ? "sniper" : p.weapon === "beryl" ? "beryl" : "rifle",
        );
      }
      if (p.weapon === "sniper")
        playKarBolt({ x: p.x, y: muzzleY, z: p.z }, 0.5);
    }
    mesh.userData.weaponKind = weaponKey(p.weapon);
    mesh.userData.driver = p.vehicleSeat === 0;
    mesh.visible = p.alive;
  }
  for (const [id, m] of remoteMeshes)
    if (!living.has(id)) {
      scene.remove(m);
      remoteMeshes.delete(id);
      // Giải phóng geometry riêng của avatar; material dùng chung thì giữ lại.
      // Geometry nhân vật / súng / chỉ báo dùng chung giữa mọi người chơi nên
      // KHÔNG dispose ở đây (những người khác vẫn đang dùng).
    }
  setText($("#healthText"), local.hp);
  setStyle($("#healthBar"), "width", local.hp + "%");
  setStyle($("#hitFlash"), "borderWidth", local.hp < 40 ? "8px" : "0");
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
    return `${{ sniper: "KAR98K · SCOPE 8X", beryl: "BERYL M762", ranger: "AUG · RED DOT" }[item.weapon] || "SÚNG"} · NHẤN F ${weaponKey(local.weapon) === "none" ? "NHẶT" : "ĐỔI"} SÚNG`;
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
    // Material từ makeMat() là dùng chung toàn cảnh — không được hủy (hủy là
    // mọi vật cùng màu phải biên dịch lại shader). Chỉ hủy material riêng (lá cờ).
    const mats = Array.isArray(object.material)
      ? object.material
      : object.material
        ? [object.material]
        : [];
    for (const mat of mats) if (!sharedMaterials.has(mat)) mat.dispose();
  });
  crate.mesh = null;
}
function disposeLootMesh(item) {
  if (!item.mesh) return;
  // Geometry/material của loot là tài nguyên DÙNG CHUNG (lootAssets) — chỉ gỡ
  // khỏi scene. Trước đây nhặt đồ là hủy luôn material dùng chung của makeMat
  // → Three.js phải biên dịch lại shader → khựng mỗi lần nhặt.
  scene?.remove(item.mesh);
  nearbyLoot.delete(item);
  item.mesh = null;
  item.body = null;
}
// ---- Tài nguyên loot dùng chung --------------------------------------------
// Mỗi vật phẩm trước đây là 6–10 mesh riêng với geometry/material riêng; ~650
// vật phẩm → hàng nghìn draw call + hàng nghìn geometry trên GPU. Nay thân vật
// phẩm của mỗi loại được gộp sẵn thành MỘT geometry có màu theo đỉnh, dùng chung
// cho mọi vật phẩm cùng loại: mỗi vật phẩm còn 3 draw call và chỉ được vẽ khi ở gần.
const LOOT_VIEW_DISTANCE = 75;
const nearbyLoot = new Set();
let lootAssets = null;
function coloredPart(geometry, color, setup) {
  const temp = new THREE.Object3D();
  setup?.(temp);
  temp.updateMatrix();
  const geo = geometry.index ? geometry.toNonIndexed() : geometry;
  geo.applyMatrix4(temp.matrix);
  const c = new THREE.Color(color);
  const colors = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) {
    colors[i] = c.r;
    colors[i + 1] = c.g;
    colors[i + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.deleteAttribute("uv");
  return geo;
}
function buildLootAssets() {
  const box = (w, h, d, color, setup) =>
    coloredPart(new THREE.BoxGeometry(w, h, d), color, setup);
  const cyl = (r, h, seg, color, setup) =>
    coloredPart(new THREE.CylinderGeometry(r, r, h, seg), color, setup);
  // Súng rơi dưới đất = đúng mô hình AUG / Kar98k đang cầm, gộp thành 1 geometry.
  const weapon = (kind) =>
    weaponToColoredGeometry(
      kind === "sniper" ? buildKar98() : kind === "beryl" ? buildBeryl() : buildAug(),
      mergeGeometries,
    );
  const medParts = [box(0.5, 0.34, 0.34, "#f2f2ec")];
  const bar = (w, h, d, x, y, z) =>
    medParts.push(box(w, h, d, "#d8202f", (o) => o.position.set(x, y, z)));
  bar(0.28, 0.02, 0.08, 0, 0.175, 0); // chữ thập trên nắp
  bar(0.08, 0.02, 0.28, 0, 0.175, 0);
  for (const side of [1, -1]) {
    bar(0.28, 0.08, 0.02, 0, 0, 0.171 * side); // hai mặt trước/sau
    bar(0.08, 0.28, 0.02, 0, 0, 0.171 * side);
  }
  const ammoParts = [
    box(0.5, 0.28, 0.32, "#54602f"),
    box(0.5, 0.02, 0.08, "#d5a83a", (o) => (o.position.y = 0.15)),
  ];
  for (let i = 0; i < 4; i++)
    ammoParts.push(
      cyl(0.035, 0.2, 8, "#d9b64a", (o) => {
        o.rotation.z = Math.PI / 2;
        o.position.set(0, 0.2, -0.105 + i * 0.07);
      }),
    );
  const glow = (color) => ({
    ring: new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    }),
    beam: new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    }),
  });
  const bodies = {
    ranger: weapon("ranger"),
    sniper: weapon("sniper"),
    beryl: weapon("beryl"),
    medkit: mergeGeometries(medParts, false),
    ammo: mergeGeometries(ammoParts, false),
  };

  // Tính bounding box 1 lần cho mỗi loại loot.
  // Dùng để đặt đáy vật phẩm sát mặt đất, không bị lơ lửng.
  for (const geometry of Object.values(bodies)) {
    geometry.computeBoundingBox();
  }

  return {
    bodyMaterial: new THREE.MeshLambertMaterial({ vertexColors: true }),
    bodies,
  };
}
// Độ cao mặt tựa của loot: điểm đất cao nhất dưới vật phẩm, và nếu nằm trong
// nhà thì là MẶT TRÊN tấm sàn (sàn dày 8 cm đặt theo độ cao tâm nhà) — trước đây
// loot đặt theo địa hình nên bị sàn nhà / đất dốc che mất một phần.
const HOUSE_FLOOR_TOP = 0.08;
function lootRestHeight(x, z, footprint) {
  let y = groundHeightAt(x, z);
  for (const [px, pz] of footprint) y = Math.max(y, groundHeightAt(px, pz));
  for (const o of obstaclesNear(x, z)) {
    if (o.type !== "house" && o.type !== "hut") continue;
    const yaw = o.yaw || 0,
      dx = x - o.x,
      dz = z - o.z;
    const lx = Math.cos(yaw) * dx - Math.sin(yaw) * dz;
    const lz = Math.sin(yaw) * dx + Math.cos(yaw) * dz;
    const half = (o.w || 1) / 2;
    if (Math.abs(lx) <= half && Math.abs(lz) <= half)
      y = Math.max(y, groundHeightAt(o.x, o.z) + HOUSE_FLOOR_TOP);
  }
  return y;
}
function addLootMesh(item) {
  if (!scene || item.mesh) return;
  lootAssets ||= buildLootAssets();
  const isMed = item.type === "medkit";
  const isWeapon = item.type === "weapon";
  const root = new THREE.Group();
  root.userData.interactionTarget = { kind: "loot", id: item.id };
  const bodyKey = isWeapon
    ? item.weapon === "sniper" || item.weapon === "beryl"
      ? item.weapon
      : "ranger"
    : isMed
      ? "medkit"
      : "ammo";
  const body = new THREE.Mesh(
    lootAssets.bodies[bodyKey],
    lootAssets.bodyMaterial,
  );

  root.add(body);

  // Đặt đáy vật phẩm vừa chạm mặt đất.
  // Không dùng y = 0.4 cố định vì mỗi loại loot có chiều cao khác nhau.
  const bounds = lootAssets.bodies[bodyKey].boundingBox;

  // Loot đứng yên, không xoay và không nhấp nhô.
  body.rotation.set(0, 0, 0);
  let restY;
  if (isWeapon) {
    // Súng nằm nghiêng trên mặt đất như bị đánh rơi: lật 90° sang một bên
    // (sau khi lật, trục X cục bộ thành trục đứng nên đáy = bounds.min.x), hướng
    // do SERVER quyết định để mọi người chơi thấy khẩu súng nằm giống hệt nhau.
    const yaw = Number(item.yaw) || 0;
    body.rotation.set(0, yaw, Math.PI / 2);
    if (bounds) body.position.y = -bounds.min.x + 0.03;
    // Súng dài ~1 m: lấy điểm cao nhất dưới cả hai đầu + hai mép, nếu không
    // đất dốc sẽ nuốt mất báng hoặc nòng.
    const sin = Math.sin(yaw),
      cos = Math.cos(yaw);
    const footprint = [];
    for (const along of bounds ? [bounds.min.z, 0, bounds.max.z] : [0])
      for (const side of bounds ? [-bounds.max.y, -bounds.min.y] : [0])
        footprint.push([item.x + sin * along + cos * side, item.z + cos * along - sin * side]);
    restY = lootRestHeight(item.x, item.z, footprint);
  } else {
    if (bounds) body.position.y = -bounds.min.y + 0.015;
    const r = 0.26;
    restY = lootRestHeight(item.x, item.z, [
      [item.x - r, item.z - r],
      [item.x + r, item.z - r],
      [item.x - r, item.z + r],
      [item.x + r, item.z + r],
    ]);
  }

  root.position.set(item.x, restY, item.z);

  root.visible = false;
  scene.add(root);

  item.mesh = root;
  item.body = body;
  // Chỉ bật khi người chơi tới gần (updateLootVisibility).
  root.visible = false;
  scene.add(root);
  item.mesh = root;
  item.body = body;
  lootVisibilityCheckAt = 0; // xét lại ngay ở khung hình kế tiếp
}
// Bật/tắt loot theo khoảng cách ~5 lần/giây: loot ở xa không được vẽ, không
// được xoay, không được raycast. Gần như luôn chỉ vài chục vật phẩm hiển thị.
let lootVisibilityCheckAt = 0;
function updateLootVisibility() {
  const now = performance.now();
  if (now < lootVisibilityCheckAt) return;
  lootVisibilityCheckAt = now + 200;
  const viewX = camera?.position.x ?? local.x;
  const viewZ = camera?.position.z ?? local.z;
  const limit2 = LOOT_VIEW_DISTANCE * LOOT_VIEW_DISTANCE;
  const show = local.state === "ground" || local.state === "parachute";
  for (const item of lootItems.values()) {
    if (!item.mesh) continue;
    const dx = item.x - viewX,
      dz = item.z - viewZ;
    const visible = show && dx * dx + dz * dz < limit2;
    item.mesh.visible = visible;
    if (visible) nearbyLoot.add(item);
    else nearbyLoot.delete(item);
  }
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
const aimRoots = [];
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
  // Chỉ raycast các vật trong tầm với (~6 m). Trước đây MỖI khung hình tia
  // ngắm được thử với toàn bộ ~650 vật phẩm × 6–10 mesh con của chúng.
  const roots = aimRoots;
  roots.length = 0;
  const reach2 = 36;
  for (const item of nearbyLoot) {
    const dx = item.x - local.x,
      dz = item.z - local.z;
    if (item.mesh && dx * dx + dz * dz <= reach2) roots.push(item.mesh);
  }
  for (const crate of lootCrates.values()) {
    const dx = crate.x - local.x,
      dz = crate.z - local.z;
    if (crate.mesh && dx * dx + dz * dz <= reach2) roots.push(crate.mesh);
  }
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
  // Balo mở thì hàm này chạy theo mỗi gói state (20 lần/giây): chỉ ghi DOM khi số đổi.
  setHtml(
    $("#bpAmmoCount"),
    `${local.reserveAmmo ?? 0}<small>/${packLimits.ammo}</small>`,
  );
  setText($("#bpMag"), ammo);
  setHtml(
    $("#bpMedCount"),
    `${local.medkits || 0}<small>/${packLimits.medkits}</small>`,
  );
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
  setText($("#bpTitle"), crate ? "BALO / HÒM TIẾP TẾ" : "BALO");
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
    lockPointer(renderer?.domElement);
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
// Súng hạ/gập khi hồi máu; khi nạp đạn súng được kéo vào giữa và lại gần màn
// hình (không còn nép sát mép phải như trước), rung/lắc liên tục suốt quá
// trình, kèm 3 cú giật rõ rệt (rút băng đạn / lắp băng đạn mới / lên đạn) —
// và băng đạn cũ rơi hẳn ra ngoài tầm nhìn rồi biến mất trước khi băng đạn
// mới trượt lên lắp vào, thay vì chỉ nhấp nhô nhẹ tại chỗ như trước.
function updateGunPose(dt) {
  if (!gun) return;
  if (deathView) {
    gun.visible = false;
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
  const reloading = local.reloading && reloadProgress < 1;
  const reloadBlend = reloading ? Math.sin(reloadProgress * Math.PI) : 0;
  const phase = (start, end) =>
    clamp((reloadProgress - start) / (end - start), 0, 1);
  gun.rotation.set(0.15 * gunBusy, 1.35 * gunBusy, -0.12 * gunBusy);
  // Khi ngắm red dot: đưa súng lại gần mắt để ô kính to, dễ nhìn xuyên.
  // Beryl có hộp khóa nòng dài ra sau kính ngắm: kéo ít hơn, nếu không phần
  // thân sau lọt qua mặt phẳng cắt gần của camera (0.1 m) → bị cắt, nhìn như
  // trong suốt / mất chi tiết.
  const adsPull = local.weapon === "beryl" ? 0.2 : 0.3;
  gun.position.set(
    0.3 * gunBusy - 0.28 * gunAimBlend,
    -0.14 * gunBusy + 0.075 * gunAimBlend,
    0.05 * gunBusy + adsPull * gunAimBlend,
  );
  if (reloading) {
    // Kéo súng vào giữa và lại gần camera để thấy rõ thao tác nạp đạn.
    gun.position.x -= 0.16 * reloadBlend;
    gun.position.y -= 0.2 * reloadBlend;
    gun.position.z += 0.09 * reloadBlend;
    // Rung/lắc liên tục trong suốt quá trình nạp đạn (2 tần số chồng lên
    // nhau cho cảm giác lộn xộn tự nhiên hơn một dao động đơn thuần).
    const wobble = reloadBlend * 0.03;
    gun.rotation.x +=
      Math.sin(reloadProgress * 26) * wobble +
      Math.sin(reloadProgress * 71) * wobble * 0.4;
    gun.rotation.z += Math.cos(reloadProgress * 19) * wobble * 0.7;
    // 3 cú giật rõ rệt: rút băng đạn cũ, lắp băng đạn mới vào, rồi lên đạn.
    const grabKick = Math.sin(phase(0.03, 0.14) * Math.PI);
    const seatKick = Math.sin(phase(0.56, 0.68) * Math.PI);
    const chargeKick = Math.sin(phase(0.86, 0.97) * Math.PI);
    gun.rotation.x += grabKick * 0.16 + seatKick * 0.1 - chargeKick * 0.22;
    gun.rotation.y += grabKick * 0.05 - seatKick * 0.04;
    gun.position.z += grabKick * 0.03 + seatKick * 0.05 - chargeKick * 0.07;
  }
  const magazine = gun.userData.magazine;
  if (magazine) {
    if (reloading) {
      const eject = phase(0.06, 0.32); // rút băng đạn cũ ra
      const insert = phase(0.5, 0.66); // lắp băng đạn mới vào
      const settle = phase(0.66, 0.8); // ổn định lại sau khi lắp
      const overshoot = Math.sin(settle * Math.PI) * 0.05;
      // outFactor: băng đạn đang "ở ngoài" gắn được bao nhiêu (0 = đã lắp
      // hẳn, 1 = đã rút hẳn ra) — đảm bảo luôn quay lại đúng vị trí gốc.
      const outFactor = eject * (1 - insert);
      magazine.visible = !(reloadProgress > 0.32 && reloadProgress < 0.5);
      const base = magazine.userData.base,
        baseRot = magazine.userData.baseRot;
      // Băng AUG rút xuống dưới; kẹp đạn Kar98k nạp từ phía trên.
      const dirY = magazine.userData.fromTop ? 1 : -1;
      magazine.position.set(
        base.x - 0.05 * outFactor,
        base.y + dirY * 0.4 * outFactor + overshoot,
        base.z - 0.08 * outFactor,
      );
      magazine.rotation.set(baseRot.x + outFactor * 0.55, 0, outFactor * 0.9);
    } else {
      magazine.visible = true;
      magazine.position.copy(magazine.userData.base);
      magazine.rotation.copy(magazine.userData.baseRot);
    }
  }
  // Khóa nòng Kar98k: bật lên → kéo lùi → đẩy tới → gập xuống (~0.65 s);
  // khi nạp đạn thì mở suốt quá trình.
  // Tay không: hai nắm tay nhún nhẹ theo nhịp thở; cú đấm lao thẳng ra trước
  // (~0.12 s) rồi thu về (~0.2 s), tay trái / phải luân phiên.
  const fists = gun.userData.fists;
  if (fists?.visible) {
    const t = (performance.now() - gun.userData.punchAt) / 320;
    const breathe = Math.sin(performance.now() / 420) * 0.008;
    for (const hand of fists.userData.hands) {
      const side = hand.userData.rest.x < 0 ? -1 : 1;
      const active = side === gun.userData.punchSide && t >= 0 && t < 1;
      const reach = active ? (t < 0.38 ? t / 0.38 : 1 - (t - 0.38) / 0.62) : 0;
      hand.position.set(
        hand.userData.rest.x - side * reach * 0.2,
        hand.userData.rest.y + breathe + reach * 0.12,
        hand.userData.rest.z - reach * 0.38,
      );
    }
  }
  const bolt = gun.userData.bolt;
  if (bolt) {
    let lift = 0,
      back = 0;
    if (local.weapon === "sniper" && reloading) {
      const open = Math.min(
        1,
        reloadProgress / 0.1,
        (1 - reloadProgress) / 0.1,
      );
      lift = open;
      back = open;
    } else {
      const t = (performance.now() - gun.userData.boltAt) / 650;
      if (t >= 0 && t < 1) {
        const up = clamp(t / 0.2, 0, 1),
          pull = clamp((t - 0.2) / 0.25, 0, 1),
          push = clamp((t - 0.5) / 0.25, 0, 1),
          down = clamp((t - 0.78) / 0.2, 0, 1);
        lift = up * (1 - down);
        back = pull * (1 - push);
      }
    }
    bolt.rotation.z = lift * 1.1;
    bolt.position.z = 0.07 + back * 0.09;
  }
}
// Gọi mỗi frame: xoay/nhấp nhô vật phẩm, gợi ý phím F, thanh hồi máu.
function updateLootHud(dt) {
  updateLootVisibility();
  
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
    setText(
      heal.querySelector("span"),
      `ĐANG HỒI MÁU ${(left / 1000).toFixed(1)}S · F ĐỂ HỦY`,
    );
    heal.querySelector("i").style.width =
      `${Math.min(100, (1 - left / HEAL_DURATION_MS) * 100)}%`;
    heal.classList.remove("hidden");
    prompt.classList.add("hidden");
    return;
  }
  heal.classList.add("hidden");
  // Gợi ý phím F chỉ ghi lại DOM khi nội dung thật sự đổi (trước đây ghi
  // innerHTML mỗi khung hình → trình duyệt dựng lại HUD 60 lần/giây).
  if (local.vehicleId) {
    setHtml(prompt, `<b>F</b>RỜI KHỎI XE`);
    prompt.classList.remove("hidden");
    return;
  }
  if (nearestVehicle()) {
    setHtml(prompt, `<b>F</b>VÀO LÁI XE · TỐI ĐA 2 NGƯỜI`);
    prompt.classList.remove("hidden");
    return;
  }
  const target = aimedInteractable();
  if (target?.kind === "crate" && target.data) {
    setHtml(prompt, `<b>F</b>MỞ HÒM TIẾP TẾ`);
    prompt.classList.remove("hidden");
  } else if (target?.kind === "loot" && target.data) {
    const item = target.data;
    setHtml(
      prompt,
      packHasRoom(item.type)
        ? `<b>F</b>NHẶT ${lootLabel(item)}`
        : `<b>✕</b>BALO ĐẦY · KHÔNG NHẶT ĐƯỢC ${item.type === "ammo" ? "ĐẠN" : "BỊCH MÁU"}`,
    );
    prompt.classList.remove("hidden");
  } else {
    prompt.classList.add("hidden");
  }
}
function beginGame() {
  inMatch = true;
  matchKills = [];
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
  local.reserveAmmo = 0; // balo rỗng khi bắt đầu trận
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
  // Rời trận cần xác nhận lần nữa để tránh bấm nhầm.
  $("#leaveMatchBtn").onclick = () => $("#leaveConfirm").classList.remove("hidden");
  $("#leaveCancelBtn").onclick = () => $("#leaveConfirm").classList.add("hidden");
  $("#leaveConfirmBtn").onclick = () => {
    $("#leaveConfirm").classList.add("hidden");
    leaveMatch();
  };
}

// Keyboard Lock chỉ được hỗ trợ ở một số trình duyệt và thường cần fullscreen.
// Ctrl+W sẽ vẫn đặt KeyW cho điều khiển đi chậm, nhưng không đóng tab nếu browser
// cho phép khóa phím. Các trình duyệt/OS vẫn có thể giữ lại một số shortcut.
const GAME_KEY_CODES = [
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "KeyQ",
  "KeyE",
  "KeyR",
  "KeyZ",
  "KeyF",
  "Space",
  "Tab",
  "Escape",
  "F5",
  "F6",
  "F11",
  "F12",
];

function enterGameInputMode() {
  const canvas = renderer?.domElement;
  const game = $("#game");
  if (!canvas || !game) return;

  // Gọi cả hai API đồng bộ trong cùng thao tác click để đáp ứng user activation.
  applyDisplayMode(); // theo setting fullscreen/windowed đã chọn
  try {
    lockPointer(canvas);
  } catch {}

  // if (!document.fullscreenElement && game.requestFullscreen) {
  //   try {
  //     const fullscreenRequest = game.requestFullscreen({
  //       navigationUI: "hide",
  //       keyboardLock: "browser",
  //     });
  //     fullscreenRequest
  //       ?.then(() => lockGameKeys())
  //       .catch(() => {
  //         // Hỗ trợ browser không nhận tùy chọn keyboardLock nhưng vẫn có fullscreen.
  //         game
  //           .requestFullscreen?.()
  //           .then(() => lockGameKeys())
  //           .catch(() => {});
  //       });
  //   } catch {
  //     // Tiếp tục chơi dạng cửa sổ nếu fullscreen không được hỗ trợ.
  //   }
  // } else if (document.fullscreenElement === game) {
  //   lockGameKeys();
  // }
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
  try {
    navigator.keyboard?.unlock?.();
  } catch {}
  // if (document.fullscreenElement === $("#game")) {
  //   document.exitFullscreen?.().catch?.(() => {});
  // }
}

function blockBrowserShortcuts(e) {
  const game = $("#game");
  const editing = e.target?.closest?.(
    "input, textarea, select, [contenteditable='true']",
  );
  if (!game?.classList.contains("active") || editing) return;
  if (document.pointerLockElement !== renderer?.domElement) return;

  // Không stopPropagation: các phím điều khiển của game vẫn nhận được sự kiện.
  // preventDefault chặn các shortcut có thể chặn bằng trang web.
  if (
    e.ctrlKey ||
    e.metaKey ||
    e.altKey ||
    ["F5", "F6", "F11", "F12"].includes(e.code)
  ) {
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
    setStyle(grayOverlay, "opacity", "0");
    setText(hud, "");
    setStyle(tint, "opacity", "0");
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
    setStyle(grayOverlay, "opacity", "1");
    setText(
      hud,
      `NGOÀI VÒNG AN TOÀN · CÒN ${Math.round(distOutside)}M · -${zone.damage}HP/S`,
    );
    setStyle(hud, "color", "#ff5252");
    setStyle(tint, "opacity", "1");
  } else {
    setStyle(grayOverlay, "opacity", "0");
    setText(hud, statusText);
    setStyle(hud, "color", "#8fd4ff");
    setStyle(tint, "opacity", "0");
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
  const modifierKey = [
    "ControlLeft",
    "ControlRight",
    "AltLeft",
    "AltRight",
    "ShiftLeft",
    "ShiftRight",
    "MetaLeft",
    "MetaRight",
  ].includes(e.code);
  const ctrlWalkKey =
    e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.shiftKey &&
    ["KeyW", "KeyS"].includes(e.code);
  if (!modifierKey && !ctrlWalkKey && (e.ctrlKey || e.metaKey || e.altKey)) {
    // Ctrl+R, Ctrl+T, Alt+Left... không được kích hoạt thao tác game.
    e.preventDefault();
    return;
  }

  if (e.code === "Escape") {
    e.preventDefault();

    // ESC may open the menu during deathcam; gameplay controls remain disabled.
    if ($("#result")?.classList.contains("active")) return;

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

  // G: bỏ súng đang cầm xuống đất, quay về tay không.
  if (
    e.code === "KeyG" &&
    !e.repeat &&
    !paused &&
    local.state === "ground" &&
    !local.vehicleId &&
    $("#game").classList.contains("active")
  ) {
    e.preventDefault();
    if (weaponKey(local.weapon) === "none") showLootToast("BẠN ĐANG TAY KHÔNG");
    else {
      stopFiring();
      if (scoped) {
        scoped = false;
        setScope(false);
      }
      send({ type: "dropWeapon" });
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
    $("#result")?.classList.contains("active") ||
    !$("#game").classList.contains("active")
  )
    return;
  closeBackpack(false);
  paused = true;
  document.exitPointerLock?.(); // ESC bị khóa nên trình duyệt không tự thả chuột
  stopFiring();
  if (local.vehicleId && local.vehicleSeat === 0)
    send({ type: "vehicleControl", throttle: 0, steer: 0, brake: false }); // xe trôi, không phanh gấp
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
  $("#leaveConfirm")?.classList.add("hidden");
  // Deadview intentionally has no pointer lock; resume spectating in place.
  if (deathView) return;
  lockPointer(renderer?.domElement);
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
  hideVictory();
  $("#leaveConfirm")?.classList.add("hidden");
  if (deathResultTimer) clearTimeout(deathResultTimer);
  deathResultTimer = null;
  deathView = null;
  camera?.up.set(0, 1, 0);
  $("#deathViewOverlay")?.classList.add("hidden");
  setStyle($("#zoneGrayOverlay"), "opacity", "0");
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
  // stopLoop("weather", 0.12); // weather loop disabled for performance profiling
  stopVehicleEngineAudio(0.03);
  stopVehicleFireAudio(0.03);
  // weatherActive = false;
  // if (weatherFx?.mesh) {
  //   scene?.remove(weatherFx.mesh);
  //   weatherFx.geometry.dispose();
  //   weatherFx.material.dispose();
  // }
  // weatherFx = null;
  inMatch = false;
  plane = null;
  planeObject = null;
  renderer?.dispose();
  renderer = null;
  remoteMeshes.clear();
  // Trạng thái nội suy / dự đoán / các bể đối tượng thuộc về scene cũ.
  vehicleSnaps.clear();
  driveSim = null;
  nearbyLoot.clear();
  grassChunks = [];
  tracerPool.length = 0;
  bloodParticles.length = 0;
  bloodPool.length = 0;
  muzzleFlash = null;
  lastVehicleControlKey = "";
  resolutionScale = 1;
}
// Khóa chuột ở chế độ "unadjustedMovement" (đọc chuyển động thô, bỏ gia tốc
// chuột của Windows). Trình duyệt không hỗ trợ thì khóa kiểu thường.
function lockPointer(element) {
  if (!element?.requestPointerLock) return;
  let request;
  try {
    request = element.requestPointerLock({ unadjustedMovement: true });
  } catch {
    // Trình duyệt cũ báo lỗi ngay với tuỳ chọn → khóa kiểu thường.
    try {
      element.requestPointerLock();
    } catch {}
    return;
  }
  // Trình duyệt không nhận tuỳ chọn → Promise bị từ chối → khóa lại kiểu thường.
  request?.catch?.(() => {
    try {
      element.requestPointerLock()?.catch?.(() => {});
    } catch {}
  });
}
// Chrome/Edge trên Windows thỉnh thoảng trả về một movementX/Y khổng lồ (thường
// ngược hướng) khi đang khóa chuột và xoay liên tục — đó là cú "giật màn hình về
// sau một khúc". Bỏ các giá trị bất thường so với tốc độ tay gần đây, và bỏ vài
// sự kiện đầu tiên ngay sau khi vừa khóa chuột (hay chứa bước nhảy rác).
//
// LƯU Ý (lỗi cũ): bản trước bỏ MỌI giá trị vượt ngưỡng và không cập nhật tốc độ
// trung bình với giá trị bị bỏ → khi xoay nhanh đột ngột, ngưỡng không bao giờ
// tăng kịp, mọi sự kiện đều bị bỏ → màn hình "đứng im" cho tới khi nhấc chuột.
// Bây giờ chỉ bỏ cú nhảy ĐƠN LẺ: bước nhảy rác của trình duyệt là 1 sự kiện
// khổng lồ, thường NGƯỢC hướng đang xoay; chuyển động thật thì liên tục và cùng
// hướng. Tối đa bỏ 1 sự kiện liên tiếp, sau đó luôn nhận và thích nghi ngưỡng.
let mouseAvg = 12,
  mouseDirX = 0, // hướng xoay ngang gần đây (trung bình có dấu)
  mouseRejects = 0,
  pointerLockedAt = 0;
document.addEventListener("pointerlockchange", () => {
  pointerLockedAt = performance.now();
  mouseAvg = 12;
  mouseDirX = 0;
  mouseRejects = 0;
});
function saneMouseDelta(e) {
  if (performance.now() - pointerLockedAt < 40) return false;
  const mx = e.movementX || 0,
    my = e.movementY || 0;
  const mag = Math.max(Math.abs(mx), Math.abs(my));
  const limit = Math.max(260, mouseAvg * 6);
  if (mag > limit && mouseRejects < 1) {
    // Cùng hướng đang xoay mạnh → chuyển động thật (vung chuột nhanh), nhận luôn.
    const sameDirection = Math.abs(mouseDirX) > 20 && Math.sign(mx) === Math.sign(mouseDirX);
    if (!sameDirection) {
      mouseRejects++;
      mouseAvg += (mag - mouseAvg) * 0.3; // vẫn thích nghi để lần sau không bỏ nữa
      return false;
    }
  }
  mouseRejects = 0;
  mouseAvg += (mag - mouseAvg) * 0.2;
  mouseDirX += (mx - mouseDirX) * 0.3;
  return true;
}
function onMouse(e) {
  // While driving, steering controls the car and the POV follows its heading.
  if (local.vehicleId && local.vehicleSeat === 0) return;
  if (document.pointerLockElement !== renderer?.domElement) return;
  // Mất sự kiện nhả chuột (trình duyệt đôi khi làm rơi mouseup khi khóa chuột):
  // nút trái thực tế đã nhả mà vẫn đang "bóp cò" → dừng bắn ngay.
  if (triggerHeld && !(e.buttons & 1)) stopFiring();
  if (!saneMouseDelta(e)) return;
  if (local.vehicleId) {
    const sens = Number($("#sensitivity").value) || 50;
    local.yaw -= e.movementX * sens * 0.000055;
    vehiclePitch = clamp(vehiclePitch - e.movementY * sens * 0.000036, -1.2, 1.2);
    return;
  }
  const sniperZoomScale =
    scoped && local.weapon === "sniper"
      ? clamp(sniperZoomFov / baseFov, 0.12, 1)
      : 1;
  // Cùng một độ nhạy + hệ số zoom cho cả 2 trục (trước đây trục dọc dùng hằng
  // số cố định nên zoom không làm chậm chuột dọc). 0.000036 × 50 = 0.0018, nên
  // ở độ nhạy mặc định cảm giác chuột dọc vẫn y như cũ khi không zoom.
  const lookSens = (Number($("#sensitivity").value) || 50) * sniperZoomScale;
  local.yaw -= e.movementX * lookSens * 0.000055;
  camera.rotation.order = "YXZ";
  camera.rotation.y = local.yaw + recoilYaw;
  camera.rotation.x = Math.max(
    -1.35,
    Math.min(1.35, camera.rotation.x - e.movementY * lookSens * 0.000036),
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
      weaponKey(local.weapon) !== "none" && // tay không thì không có gì để ngắm
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
  // Một lần NHẤN mới nghĩa là nút đã được nhả trước đó: nếu triggerHeld vẫn còn
  // true là do mất sự kiện mouseup → trước đây mọi cú click sau đó đều bị bỏ qua
  // ("click không nhận"). Giờ xoá trạng thái cũ và bắn bình thường.
  if (triggerHeld) stopFiring();
  // Clicking repeatedly must not bypass the bolt-action cooldown.
  if (
    local.weapon === "sniper" &&
    Date.now() - lastClientShotAt < SNIPER_FIRE_INTERVAL_MS
  )
    return;
  triggerHeld = true;
  nextAutoShotAt = performance.now() + currentFireInterval();
  shootOnce();
}
function onMouseUp(e) {
  if (e.button === 0) stopFiring();
}
function stopFiring() {
  triggerHeld = false;
  if (fireInterval !== null) clearInterval(fireInterval);
  fireInterval = null;
}
// Bắn liên thanh được nhịp theo khung hình thay vì setInterval: setInterval bị
// trình duyệt dồn/trễ khi main thread bận nên nhịp bắn lúc nhanh lúc chậm và
// viên đạn không khớp hướng ngắm của khung hình đang hiển thị.
let nextAutoShotAt = 0;
// Nhịp bắn phía client (hơi chậm hơn giới hạn server để không bị từ chối).
const CLIENT_FIRE_INTERVAL = { none: 480, ranger: FIRE_INTERVAL_MS, beryl: 90 };
const currentFireInterval = () =>
  local.weapon === "sniper"
    ? SNIPER_FIRE_INTERVAL_MS
    : CLIENT_FIRE_INTERVAL[weaponKey(local.weapon)] || FIRE_INTERVAL_MS;
function updateAutoFire() {
  if (!triggerHeld) return;
  const now = performance.now();
  if (now < nextAutoShotAt) return;
  const interval = currentFireInterval();
  // Sau một lần khựng dài thì không xả bù cả loạt đạn cùng lúc.
  nextAutoShotAt =
    now - nextAutoShotAt > interval
      ? now + interval
      : nextAutoShotAt + interval;
  shootOnce();
}

// Tia từ tâm màn hình xuyên qua đúng các mesh người chơi đang được vẽ — chính
// là thứ red dot đang chỉ vào. Server dùng kết quả này để xác nhận trúng đạn.
const aimRaycaster = new THREE.Raycaster();
function findAimedPlayer(eye, dir, far = 140) {
  aimRaycaster.camera = camera;
  aimRaycaster.set(eye, dir);
  aimRaycaster.near = 0;
  aimRaycaster.far = far;
  let best = null;
  // Chỉ thử với hộp hitbox vô hình (đứng / khom) — CÙNG kích thước server dùng,
  // đã bao cả nón và giáp: thấy trúng nón là trúng đầu, trúng giáp là trúng thân.
  for (const [id, mesh] of remoteMeshes) {
    const ud = mesh.userData;
    if (!mesh.visible || !ud.rig) continue;
    const set = ud.rig.hitboxes[ud.crouching && !ud.prone ? "crouch" : "stand"];
    mesh.updateMatrixWorld(true);
    const hit = aimRaycaster.intersectObject(set, true)[0];
    if (hit && (!best || hit.distance < best.dist))
      best = {
        id,
        part: hit.object.userData.hitPart || "body",
        dist: hit.distance,
      };
  }
  return best;
}

let muzzleFlash = null,
  muzzleFlashOffAt = 0;
const shotAim = new THREE.Vector3(),
  shotEye = new THREE.Vector3();

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
  const key = weaponKey(local.weapon);
  if (key === "none") {
    // Tay không: đấm (tay trái / phải luân phiên), tầm với ~1.9 m do server kiểm.
    lastClientShotAt = now;
    gun.userData.punchSide = -gun.userData.punchSide;
    gun.userData.punchAt = performance.now();
    playPunchWhoosh(null);
    camera.getWorldDirection(shotAim);
    camera.getWorldPosition(shotEye);
    send({
      type: "shoot",
      aim: { x: shotAim.x, y: shotAim.y, z: shotAim.z },
      x: shotEye.x,
      z: shotEye.z,
      eyeY: shotEye.y,
      hit: findAimedPlayer(shotEye, shotAim, 1.9),
    });
    return;
  }
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
    key === "sniper" ? "sniper" : key === "beryl" ? "beryl" : "rifle",
  );
  // Đèn chớp nòng luôn nằm sẵn trong scene (xem initWorld), chỉ đổi cường độ.
  // Trước đây đèn được TẠO ở phát bắn đầu tiên → đổi số lượng đèn buộc Three.js
  // biên dịch lại shader của mọi vật liệu → khựng hình ngay phát súng đầu.
  if (muzzleFlash) {
    muzzleFlash.intensity = 2;
    muzzleFlashOffAt = performance.now() + 45;
  }
  // Tia lửa đầu nòng (mesh có sẵn, chỉ bật lên ~40 ms).
  const fpFlash = gun?.userData.flashes?.[key];
  if (fpFlash) {
    fireMuzzleFlash(fpFlash);
    muzzleFlashOffAt =
      performance.now() + (key === "sniper" ? 55 : key === "beryl" ? 50 : 40);
  }
  if (local.weapon === "sniper" && gun) {
    // Kar98k: kéo khóa nòng sau mỗi phát (hình + tiếng).
    gun.userData.boltAt = performance.now() + 260;
    playKarBolt(null, 0.3);
  }
  // Use Three.js's actual camera ray for both the visible tracer and server hit test.
  camera.getWorldDirection(shotAim);
  camera.getWorldPosition(shotEye);
  makeTracer(shotEye, shotAim);
  // Trước đây mỗi phát gửi HAI gói "shoot" giống nhau (gói thứ hai luôn bị
  // server từ chối vì cooldown) → gấp đôi băng thông lúc bắn auto.
  send({
    type: "shoot",
    aim: { x: shotAim.x, y: shotAim.y, z: shotAim.z },
    x: shotEye.x,
    z: shotEye.z,
    eyeY: shotEye.y,
    hit: findAimedPlayer(shotEye, shotAim),
  });
  // This shot follows the current reticle exactly; recoil is applied just
  // afterward so it moves the aim for the next shot instead of deflecting this one.
  const stanceScale = local.prone ? 0.35 : local.crouching ? 0.65 : 1;
  const recoilScale = (scoped ? 0.72 : 1) * stanceScale;
  // Độ giật: Beryl M762 giật lên và lắc ngang mạnh hơn AUG rõ rệt.
  const kick = { sniper: [0.105, 0.018], beryl: [0.05, 0.05], ranger: [0.032, 0.026] }[key];
  const pitchKick = kick[0] * recoilScale;
  const yawKick = (Math.random() - 0.5) * kick[1] * recoilScale;
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
  // AUG: chấm đỏ; Beryl: kính toàn ảnh (lưới ngắm nằm trên mô hình 3D, không phủ
  // lớp HUD); Kar98k: ống 8x.
  overlay.classList.toggle("reflex", scoped && local.weapon === "ranger");
  overlay.classList.toggle("iron", scoped && local.weapon === "beryl");
  overlay.classList.toggle("sniper", scoped && local.weapon === "sniper");
  overlay.querySelector("small").textContent =
    local.weapon === "sniper"
      ? `ỐNG NGẮM ${Math.round(baseFov / sniperZoomFov)}X · CUỘN CHUỘT ĐỔI 4X–8X · CHUỘT PHẢI ĐỂ THOÁT`
      : local.weapon === "beryl"
        ? "KÍNH TOÀN ẢNH · CHUỘT PHẢI ĐỂ THOÁT"
        : "RED DOT · CHUỘT PHẢI ĐỂ THOÁT";
}
function onScopeWheel(event) {
  if (!scoped || local.weapon !== "sniper") return;
  event.preventDefault();
  // Ống ngắm Kar98k có thể chỉnh 4x → 8x như trong PUBG.
  const zoom = clamp(
    Math.round(baseFov / sniperZoomFov) - Math.sign(event.deltaY),
    4,
    8,
  );
  sniperZoomFov = baseFov / zoom;
  camera.fov = sniperZoomFov;
  camera.updateProjectionMatrix();
  setScope(true);
}
// Tên + mô tả hiển thị trên HUD cho từng loại vũ khí.
const WEAPON_INFO = {
  none: { name: "TAY KHÔNG", sub: "ĐẤM · ĐẦU −50 · THÂN −5" },
  ranger: { name: "AUG", sub: "SÚNG TRƯỜNG TẤN CÔNG · RED DOT" },
  beryl: { name: "BERYL M762", sub: "SÚNG TRƯỜNG TẤN CÔNG · KÍNH TOÀN ẢNH" },
  sniper: { name: "KAR98K", sub: "SÚNG BẮN TỈA · SCOPE 8X" },
};
const weaponKey = (w) => (WEAPON_INFO[w] ? w : "none");
function updateLocalWeaponVisual() {
  if (!gun) return;
  const key = weaponKey(local.weapon);
  for (const [kind, model] of Object.entries(gun.userData.models || {}))
    model.visible = kind === key;
  gun.userData.magazine = gun.userData.magazines?.[key] || null;
  setText($(".weapon small"), WEAPON_INFO[key].sub);
  setText($(".weapon b"), WEAPON_INFO[key].name);
  if (key === "none" && scoped) setScope(false);
  else if (scoped) setScope(true);
  updateAmmoHud();
}
// Vệt đạn dùng một "bể" Line cố định: bắn auto trước đây tạo Geometry +
// Material + setTimeout mới cho MỖI viên (12 viên/giây) rồi hủy → rác bộ nhớ,
// upload GPU liên tục và giật khi GC chạy.
const TRACER_POOL_SIZE = 6;
const TRACER_LIFE_MS = 110;
const tracerPool = [];
let tracerMaterial = null;
function makeTracer(eye, direction) {
  if (!scene) return;
  if (!tracerMaterial)
    tracerMaterial = new THREE.LineBasicMaterial({
      color: 0xffed8a,
      transparent: true,
      opacity: 0.95,
    });
  let tracer = tracerPool.find((line) => !line.visible);
  if (!tracer) {
    if (tracerPool.length < TRACER_POOL_SIZE) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(6), 3),
      );
      tracer = new THREE.Line(geometry, tracerMaterial);
      tracer.frustumCulled = false;
      tracerPool.push(tracer);
    } else {
      tracer = tracerPool.reduce((a, b) =>
        a.userData.hideAt < b.userData.hideAt ? a : b,
      );
    }
  }
  if (tracer.parent !== scene) scene.add(tracer);
  const muzzle = tracerMuzzle;
  if (scoped) {
    // While aiming, start the visible tracer on the camera's center ray so it
    // stays aligned with the reticle instead of streaking in from the hip-fire muzzle.
    muzzle.copy(eye).addScaledVector(direction, 0.25);
  } else {
    // Vệt đạn xuất phát đúng đầu nòng của mô hình súng đang cầm.
    const fpFlash = gun?.userData.flashes?.[weaponKey(local.weapon)];
    if (fpFlash) {
      fpFlash.parent.updateMatrixWorld(true);
      fpFlash.getWorldPosition(muzzle);
    } else camera.localToWorld(muzzle.set(0.28, -0.2, -1));
  }
  // End the tracer on the exact same camera-center ray sent to the server.
  const pos = tracer.geometry.attributes.position;
  pos.setXYZ(0, muzzle.x, muzzle.y, muzzle.z);
  pos.setXYZ(
    1,
    eye.x + direction.x * 140,
    eye.y + direction.y * 140,
    eye.z + direction.z * 140,
  );
  pos.needsUpdate = true;
  tracer.visible = true;
  tracer.userData.hideAt = performance.now() + TRACER_LIFE_MS;
}
const tracerMuzzle = new THREE.Vector3();
// Gọi mỗi khung hình: tắt vệt đạn / chớp nòng đã hết hạn (không cần setTimeout).
function updateShotEffects() {
  const now = performance.now();
  for (const tracer of tracerPool)
    if (tracer.visible && now >= tracer.userData.hideAt) tracer.visible = false;
  if (now >= muzzleFlashOffAt) {
    if (muzzleFlash && muzzleFlash.intensity) muzzleFlash.intensity = 0;
    for (const flash of Object.values(gun?.userData.flashes || {}))
      if (flash.visible) flash.visible = false;
  }
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
  const planeLight = planeObject.userData.jumpPointLight;
  if (!plane) {
    planeObject.visible = false;
    planeLight.intensity = 0;
    return;
  }
  const t = planeTime();
  if (local.state === "plane" && t >= plane.tEnter && !jumpCuePlayed) {
    jumpCuePlayed = true;
    playJumpReadyBell();
  }
  planeObject.visible = t < plane.tExit + 25;
  if (!planeObject.visible) {
    planeLight.intensity = 0;
    return;
  }
  const pos = planePosAt(t);
  planeObject.position.set(pos.x, plane.alt, pos.z);
  planeObject.rotation.y = planeYaw();
  planeObject.updateMatrixWorld();
  planeLight.position
    .copy(planeObject.userData.jumpLight.position)
    .applyMatrix4(planeObject.matrixWorld);
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
const remoteSample = { x: 0, y: 0, z: 0, yaw: 0 };
// Geometry vòng nạp đạn (12 vạch) và chữ thập hồi máu, gộp sẵn và dùng chung.
let indicatorCache = null;
function indicatorAssets() {
  if (indicatorCache) return indicatorCache;
  const dashes = [];
  for (let dash = 0; dash < 12; dash++) {
    const angle = (dash / 12) * Math.PI * 2;
    const box = new THREE.BoxGeometry(0.13, 0.1, 0.11);
    box.rotateY(-angle);
    box.translate(Math.cos(angle) * 0.3, 0, Math.sin(angle) * 0.3);
    dashes.push(box);
  }
  const cross = [
    [0.52, 0.14, 0.14],
    [0.14, 0.52, 0.14],
    [0.14, 0.14, 0.52],
  ].map(([w, h, d]) => new THREE.BoxGeometry(w, h, d));
  indicatorCache = {
    ring: mergeGeometries(dashes, false),
    ringMat: new THREE.MeshBasicMaterial({
      color: 0xd6ff45,
      toneMapped: false,
    }),
    cross: mergeGeometries(cross, false),
    crossMat: new THREE.MeshBasicMaterial({
      color: 0xff4d5e,
      toneMapped: false,
    }),
  };
  return indicatorCache;
}
// Điểm hai tay cầm trên mỗi khẩu (toạ độ của mô hình súng, xem weapons.js).
const WEAPON_GRIPS = {
  ranger: {
    right: new THREE.Vector3(0, -0.1, -0.02),
    left: new THREE.Vector3(0, -0.13, -0.2),
  },
  sniper: {
    right: new THREE.Vector3(0, -0.07, 0.1),
    left: new THREE.Vector3(0, -0.05, -0.26),
  },
  beryl: {
    right: new THREE.Vector3(0, -0.1, 0.1),
    left: new THREE.Vector3(0, -0.06, -0.3),
  },
};
// Dựng tư thế + hoạt ảnh cho người chơi khác mỗi khung hình (sau khi đã nội
// suy vị trí). Tốc độ lấy từ chính chuyển động đang hiển thị nên bước chân
// khớp với tốc độ trượt thật, không bị "trượt băng".
function animateAvatars(dt) {
  const now = Date.now();
  for (const mesh of remoteMeshes.values()) {
    const ud = mesh.userData;
    if (!ud.rig || !mesh.visible) continue;
    const px = mesh.position.x,
      pz = mesh.position.z;
    if (ud.prevX !== undefined && dt > 0) {
      const v = Math.hypot(px - ud.prevX, pz - ud.prevZ) / dt;
      ud.speed += (Math.min(v, 12) - ud.speed) * Math.min(1, 10 * dt);
    }
    ud.prevX = px;
    ud.prevZ = pz;
    const stance =
      ud.motionMode === "vehicle"
        ? "seat"
        : ud.state === "freefall"
          ? "air"
          : ud.state === "parachute"
            ? "chute"
            : ud.swimming
              ? "swim"
              : ud.prone
                ? "prone"
                : ud.jumpY > 0.05
                  ? "jump"
                  : ud.crouching
                    ? "crouch"
                    : "stand";
    const armed =
      ud.weapon.visible || ud.sniperWeapon.visible || ud.berylWeapon.visible;
    const punchT = (now - ud.punchAt) / 320;
    poseAvatar(
      ud.rig,
      ud.pose,
      {
        stance,
        speed: ud.state === "plane" ? 0 : ud.speed,
        slow: ud.slowWalking,
        reloading: ud.reloading,
        driver: ud.driver,
        steerSpin: ud.steerSpin || 0,
        kick:
          now < ud.kickUntil ? (ud.weaponKind === "sniper" ? 0.16 : 0.06) : 0,
        weaponGrip: armed ? WEAPON_GRIPS[ud.weaponKind] || WEAPON_GRIPS.ranger : null,
        // Tay không (đã tiếp đất): thế thủ + cú đấm luân phiên.
        fists: !armed && ud.weaponKind === "none" && ud.state === "ground",
        punch: punchT >= 0 && punchT < 1 ? punchT : 0,
        punchSide: ud.punchSide,
      },
      dt,
    );
    if (now >= ud.flashUntil) {
      ud.muzzleFlash.visible = false;
      ud.sniperFlash.visible = false;
      ud.berylFlash.visible = false;
    }
    if (ud.reloading) ud.reloadIndicator.rotation.z += dt * 7;
    if (ud.healing) ud.healIndicator.rotation.y += dt * 5;
  }
}
function updateRemoteMotion(dt) {
  const t = plane ? planeTime() : 0;
  const renderT = serverNow() - INTERP_DELAY_MS;
  for (const mesh of remoteMeshes.values()) {
    const ud = mesh.userData;
    if (ud.state === "plane" && plane) {
      const seat = seatWorld(ud.seat || 0, t);
      mesh.position.set(seat.x, plane.alt, seat.z);
      mesh.rotation.set(0, planeYaw(), 0);
    } else if (ud.motionMode === "vehicle") {
      const car = vehicleMeshes.get(ud.vehicleId);
      if (car) {
        // Ngồi đúng ghế theo khung xe và nghiêng cùng xe khi lên dốc / qua sườn đồi.
        car.updateMatrixWorld();
        vehicleEye.set(ud.vehicleSeat === 0 ? -0.43 : 0.43, 0.08, 0.18);
        car.localToWorld(vehicleEye);
        mesh.position.copy(vehicleEye);
        mesh.quaternion.copy(car.quaternion);
        ud.steerSpin = car.userData.steerSpin || 0;
      }
    } else if (ud.snaps?.length) {
      const s = sampleSnapshots(ud.snaps, renderT, remoteSample);
      mesh.position.set(s.x, s.y, s.z);
      mesh.rotation.y = s.yaw;
    }
    if (ud.chute?.visible)
      ud.chute.rotation.z = Math.sin(performance.now() / 700 + mesh.id) * 0.06;
  }
}

/* WEATHER EFFECTS TEMPORARILY COMMENTED OUT FOR PERFORMANCE TESTING.
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
*/
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
    setText($("#phaseSmall"), "PHÒNG CHỜ · ĐANG VÀO TRẬN");
    setText($("#phaseBig"), "…");
    setText(
      $("#phaseSub"),
      `ĐÃ VÀO ${ready}/${players.length} NGƯỜI CHƠI · WASD DI CHUYỂN · CLICK ĐỂ KHÓA CHUỘT`,
    );
    lastCountdownNumber = null;
    return;
  }
  const n = Math.max(1, Math.ceil((countdownEndsAt - serverNow()) / 1000));
  setText($("#phaseSmall"), "TRẬN ĐẤU BẮT ĐẦU SAU");
  setText($("#phaseBig"), n);
  setText($("#phaseSub"), "CHUẨN BỊ LÊN MÁY BAY");
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
    setText(el, "PHÒNG CHỜ");
    return;
  }
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  setText(
    el,
    `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`,
  );
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
  setText(
    $("#flightState"),
    st === "plane"
      ? "TRÊN MÁY BAY"
      : st === "freefall"
        ? "ĐANG RƠI TỰ DO"
        : "ĐANG DÙ",
  );
  setText(
    $("#flightAlt"),
    st === "plane"
      ? `ĐỘ CAO ${Math.round(alt)} M`
      : `ĐỘ CAO ${Math.round(alt)} M · ${Math.round(airState.fall)} M/S`,
  );
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
  setText(hint, text);
  hint.classList.toggle("ok", ok);
  drawFlightMap();
}
let minimapBaseCanvas = null,
  minimapBaseKey = "";
function minimapBase(S, forest, k, X, Y) {
  const key = `${mapId}|${gameState?.mapSeed}|${mapObstacles.length}|${S}`;
  if (minimapBaseCanvas && minimapBaseKey === key) return minimapBaseCanvas;
  minimapBaseKey = key;
  minimapBaseCanvas ||= document.createElement("canvas");
  minimapBaseCanvas.width = minimapBaseCanvas.height = S;
  const ctx = minimapBaseCanvas.getContext("2d");
  // Nền: tô theo độ cao + đổ bóng sườn núi từ chính lưới địa hình (vẽ 1 lần).
  const img = ctx.createImageData(S, S);
  const c = new THREE.Color();
  const ramp = forest
    ? [
        [0, "#5a8a47"],
        [8, "#4c7a3d"],
        [20, "#5d6f4a"],
        [32, "#7d7f74"],
        [48, "#e6eaec"],
      ]
    : [
        [0, "#d0ac72"],
        [10, "#c79b62"],
        [28, "#b27a4c"],
        [50, "#93613f"],
        [80, "#7b5236"],
      ];
  const c2 = new THREE.Color();
  for (let py = 0; py < S; py++)
    for (let px = 0; px < S; px++) {
      const x = (px + 0.5 - S / 2) / k,
        z = (py + 0.5 - S / 2) / k;
      const h = mapTerrain ? mapTerrain.heightAt(x, z) : 0;
      let i = 0;
      while (i < ramp.length - 2 && h > ramp[i + 1][0]) i++;
      const t = Math.min(
        1,
        Math.max(0, (h - ramp[i][0]) / (ramp[i + 1][0] - ramp[i][0])),
      );
      c.set(ramp[i][1]).lerp(c2.set(ramp[i + 1][1]), t);
      if (waterBedDepth(x, z) > 0) c.set("#3a8fa3");
      else if (forest && inSwamp(x, z)) c.set("#56643a");
      const d = 2 / k;
      const gx = mapTerrain
        ? mapTerrain.heightAt(x + d, z) - mapTerrain.heightAt(x - d, z)
        : 0;
      const gz = mapTerrain
        ? mapTerrain.heightAt(x, z + d) - mapTerrain.heightAt(x, z - d)
        : 0;
      const shade = Math.max(0.55, Math.min(1.25, 1 - (gx + gz) * 0.035));
      const o = (py * S + px) * 4;
      img.data[o] = Math.min(255, c.r * 255 * shade);
      img.data[o + 1] = Math.min(255, c.g * 255 * shade);
      img.data[o + 2] = Math.min(255, c.b * 255 * shade);
      img.data[o + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  // Đường: vẽ theo từng tuyến liền mạch, cầu sáng màu hơn.
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const roadLines = segmentLines("road", "roadId", 0.6);
  for (const [color, width] of [
    ["#3c3a33", 1.7],
    [forest ? "#d8cfae" : "#efe0bb", 0.9],
  ]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, 9 * k * width);
    ctx.beginPath();
    for (const pts of roadLines)
      pts.forEach((p, i) =>
        i ? ctx.lineTo(X(p.x), Y(p.z)) : ctx.moveTo(X(p.x), Y(p.z)),
      );
    ctx.stroke();
  }
  for (const o of mapObstacles) {
    if (
      o.type !== "house" &&
      o.type !== "hut" &&
      o.type !== "tree" &&
      o.type !== "rock"
    )
      continue;
    const size = Math.max(1.4, (o.w || 1) * k);
    ctx.save();
    ctx.translate(X(o.x), Y(o.z));
    ctx.rotate(-(o.yaw || 0));
    if (o.type === "house" || o.type === "hut") {
      ctx.fillStyle = o.type === "house" ? "#8a4f38" : "#9c7a4e";
      ctx.fillRect(-size / 2, -size / 2, size, size);
      ctx.strokeStyle = "rgba(20,16,10,.7)";
      ctx.lineWidth = 0.6;
      ctx.strokeRect(-size / 2, -size / 2, size, size);
    } else if (o.type === "tree") {
      ctx.fillStyle = "rgba(24,62,32,.75)";
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(1, size * 0.9), 0, Math.PI * 2);
      ctx.fill();
    } else if (o.w > 4) {
      ctx.fillStyle = forest ? "#6b6f62" : "#7d5a3c";
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.strokeStyle = forest ? "#c8f27a" : "#f3d38c";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, S - 2, S - 2);
  return minimapBaseCanvas;
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
  const forest = mapId === "forest";
  // Lớp địa hình tĩnh (đất, sông, đường, đồi, nhà, cây...) chỉ vẽ MỘT lần mỗi
  // map rồi dán lại; trước đây ~500 vật thể được vẽ lại mỗi 150 ms.
  ctx.clearRect(0, 0, S, S);
  ctx.drawImage(minimapBase(S, forest, k, X, Y), 0, 0);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, S, S);
  ctx.clip();
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
  // for (const p of gameState?.players || [])
  //   if (
  //     p.id !== playerId &&
  //     (p.state === "freefall" || p.state === "parachute")
  //   )
  //     dot(p.x, p.z, 3, "#ff7a5c");
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
    new THREE.MeshLambertMaterial({
      color: "#e8622c",
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
    new THREE.MeshLambertMaterial({
      color: "#f1f5f6",
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
  // Mặt phẳng xa bắt đầu từ mép lưới địa hình (núi viền đã hạ dần về 0 ở đó).
  const far = 1600,
    edge = window.LDTerrain.EXTENT - 1;
  const strip = (w, d, x, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, -0.05, z);
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
  // if (audioLoops.weather) setLoopGain(audioLoops.weather, ...); // weather audio disabled
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
/* WEATHER AUDIO TEMPORARILY COMMENTED OUT FOR PERFORMANCE TESTING.
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
*/
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
// Tiếp đất sau khi NHẢY DÙ: cả người đổ xuống đất (cú "huỵch" nặng, trầm), lăn
// một vòng giảm chấn, dây dù căng rồi tán dù xẹp phập phồng, khóa đai cách cách.
function playLanding(position) {
  const a = spatialAudio(position, { volume: 1, ref: 3, max: 50 });
  if (!a) return;
  toneBurst(a, { duration: 0.28, from: 85, to: 30, gain: 1.25 }); // thân người đập đất
  noiseBurst(a, { duration: 0.16, filter: "lowpass", freq: 700, gain: 1.1, drive: 6 });
  noiseBurst(a, { at: 0.12, duration: 0.45, filter: "lowpass", freq: 420, gain: 0.55 }); // lăn người
  toneBurst(a, { at: 0.2, duration: 0.14, from: 70, to: 40, gain: 0.45 }); // chạm đất lần 2 khi lăn
  noiseBurst(a, { at: 0.18, duration: 0.7, filter: "bandpass", freq: 260, q: 0.6, gain: 0.5 }); // tán dù xẹp
  noiseBurst(a, { at: 0.45, duration: 0.55, filter: "bandpass", freq: 180, q: 0.8, gain: 0.35 }); // vải dù phập phồng
  noiseBurst(a, { at: 0.62, duration: 0.025, filter: "bandpass", freq: 3400, q: 4, gain: 0.7 }); // tháo khóa đai
  noiseBurst(a, { at: 0.7, duration: 0.025, filter: "bandpass", freq: 3100, q: 4, gain: 0.55 });
}
// Đáp đất sau khi NHẢY (bật tại chỗ): hai bàn chân chạm gần như cùng lúc, đầu gối
// nhún, trang bị trên người va lách cách; tiếng mặt đất theo bề mặt.
function playJumpLand(x, y, z, ownPlayer) {
  const a = spatialAudio(ownPlayer ? null : { x, y: y + 0.1, z }, {
    volume: ownPlayer ? 0.45 : 0.8,
    ref: 2,
    max: 26,
  });
  if (!a) return;
  const surface = footSurface(x, z);
  for (const [at, g] of [[0, 1], [0.018, 0.8]]) {
    toneBurst(a, { at, duration: 0.09, from: surface === "wood" ? 170 : 115, to: 55, gain: 0.55 * g }); // gót chạm đất
    if (surface === "grass") noiseBurst(a, { at, duration: 0.14, filter: "bandpass", freq: 2400, q: 0.7, gain: 0.5 * g });
    else if (surface === "sand") noiseBurst(a, { at, duration: 0.18, filter: "highpass", freq: 2600, gain: 0.4 * g });
    else if (surface === "road") noiseBurst(a, { at, duration: 0.04, filter: "bandpass", freq: 1800, q: 2, gain: 0.9 * g });
    else if (surface === "wood") noiseBurst(a, { at, duration: 0.06, filter: "bandpass", freq: 850, q: 3, gain: 0.8 * g });
    else if (surface === "water" || surface === "mud") noiseBurst(a, { at, duration: 0.25, filter: "lowpass", freq: 1400, gain: 0.8 * g });
    noiseBurst(a, { at, duration: 0.08, filter: "lowpass", freq: 450, gain: 0.6 * g });
  }
  // Súng, băng đạn, giáp va nhau khi nhún gối.
  noiseBurst(a, { at: 0.05, duration: 0.04, filter: "bandpass", freq: 3200, q: 3, gain: 0.35 });
  toneBurst(a, { at: 0.06, duration: 0.05, type: "triangle", from: 2200, to: 1700, gain: 0.04 });
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
  for (let i = bloodParticles.length - 1; i >= 0; i--) {
    const particle = bloodParticles[i];
    particle.userData.life -= dt;
    particle.userData.velocity.y -= 8 * dt;
    particle.position.addScaledVector(particle.userData.velocity, dt);
    particle.scale.setScalar(Math.max(0.05, particle.userData.life / 0.62));
    if (particle.userData.life <= 0) {
      scene.remove(particle);
      bloodParticles.splice(i, 1);
      bloodPool.push(particle);
    }
  }
  updateLootHud(dt);
  updateGunPose(dt);
  if (deathView) {
    if (gun) gun.visible = false;
  }
  updatePhaseOverlay();
  updatePlaneObject(dt);
  // Xe trước, người sau: người ngồi trên xe lấy vị trí ghế từ mesh xe của
  // CHÍNH khung hình này (thứ tự ngược lại làm người lệch khỏi ghế khi xe chạy nhanh).
  updateVehicleMeshes(dt);
  updateRemoteMotion(dt);
  animateAvatars(dt);
  updateAutoFire();
  updateShotEffects();
  // Trên máy bay / đang nhảy dù thì mô phỏng riêng; chỉ ở phòng chờ hoặc mặt đất mới đi bộ.
  if (local.state === "plane") updatePlane();
  else if (local.state === "freefall" || local.state === "parachute")
    updateAir(dt);
  updateEnvironment(dt);
  updateGrassVisibility();
  // updateWeather(dt); // weather particle update disabled for performance testing
  updateFlightHud();
  updateMatchClock();
  updateZoneHud();
  updateZoneWorld();
  // Vẫn chạy khi đang tạm dừng: carInputs() trả về 0 nên xe được nhả ga/phanh
  // thay vì chạy tiếp với phím cuối cùng trước khi mở menu.
  if (local.vehicleId) {
    const now = Date.now();
    if (local.vehicleSeat === 0) {
      // Gửi NGAY khi phím đổi (không chờ nhịp 45 ms) và nhắc lại mỗi 250 ms;
      // server giữ nguyên điều khiển cuối cùng nên không cần gửi liên tục.
      const input = carInputs();
      const key = `${input.throttle}|${input.steer}|${input.brake}`;
      if (key !== lastVehicleControlKey || now - lastVehicleControlAt > 250) {
        send({ type: "vehicleControl", ...input });
        lastVehicleControlKey = key;
        lastVehicleControlAt = now;
      }
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
          playJumpLand(local.x, local.groundY, local.z, true);
        }
      }
      if (grounded) {
        jumpOffset = 0;
        // Độ cao gốc của mắt đuổi mượt theo mặt đất; nhún đầu khi đi là một
        // ĐỘ LỆCH theo nhịp bước (trước đây cộng dồn sin mỗi khung hình → rung).
        cameraBaseY += (targetHeight - cameraBaseY) * Math.min(12 * dt, 1);
        const bob = !isCrouching && isMoving ? Math.sin(localGaitPhase * 2) * 0.022 : 0;
        headBob += (bob - headBob) * Math.min(14 * dt, 1);
        camera.position.y = cameraBaseY + headBob;
      } else {
        cameraBaseY = targetHeight;
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
    const nowMove = Date.now();
    if (nowMove - lastMove > 50) {
      // Đứng yên, không xoay: bỏ gói trùng lặp (chỉ nhắc lại mỗi 250 ms) —
      // giảm ~80% gói gửi lên khi núp/ngắm, đỡ nghẽn Wi-Fi yếu và đỡ tải server.
      const moveKey = `${local.x.toFixed(2)}|${local.z.toFixed(2)}|${local.yaw.toFixed(3)}|${+local.crouching}${+local.prone}${+Boolean(local.swimming)}${+isSlowWalking}|${(local.swimY ?? 0).toFixed(2)}|${jumpOffset.toFixed(2)}|${local.peek.toFixed(2)}`;
      if (moveKey !== lastMoveKey || nowMove - lastMove > 250) {
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
        lastMove = nowMove;
        lastMoveKey = moveKey;
      }
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
    camera.position.set(deathView.x, deathView.y + 45, deathView.z);
    camera.lookAt(deathView.x, deathView.y, deathView.z);
  }
  renderer.render(scene, camera);
  adaptResolution(dt);
  requestAnimationFrame(frame);
}
// Tự hạ độ phân giải render khi GPU yếu không giữ nổi ~45 FPS và tăng lại khi
// dư sức — giữ khung hình đều thay vì tụt FPS lúc giao tranh / nhiều khói lửa.
let frameTimeAvg = 1 / 60,
  resolutionScale = 1,
  resolutionCheckAt = 0;
// Mỗi lần đổi độ phân giải, trình duyệt cấp phát lại bộ đệm vẽ (khựng một
// nhịp). Bản cũ có thể hạ rồi tăng lại mỗi 2 giây khi FPS dao động quanh ngưỡng
// (vd. lúc nhìn xuống đám cỏ) → giật định kỳ. Nay: chỉ hạ khi chậm LIÊN TỤC
// ~4 s, chỉ tăng lại khi mượt liên tục ~12 s, và nghỉ ít nhất 8 s sau mỗi lần đổi.
let slowChecks = 0,
  fastChecks = 0,
  resolutionChangedAt = 0;
function adaptResolution(dt) {
  frameTimeAvg += (dt - frameTimeAvg) * 0.05;
  const now = performance.now();
  if (now < resolutionCheckAt) return;
  resolutionCheckAt = now + 1000;
  slowChecks = frameTimeAvg > 1 / 42 ? slowChecks + 1 : 0;
  fastChecks = frameTimeAvg < 1 / 57 ? fastChecks + 1 : 0;
  if (now - resolutionChangedAt < 8000) return;
  let next = resolutionScale;
  if (slowChecks >= 4) next = Math.max(0.55, resolutionScale - 0.1);
  else if (fastChecks >= 12) next = Math.min(1, resolutionScale + 0.05);
  if (Math.abs(next - resolutionScale) < 0.001) return;
  resolutionScale = next;
  resolutionChangedAt = now;
  slowChecks = fastChecks = 0;
  renderer.setPixelRatio(graphicsPixelRatio());
}
// Thắng trận (trận có nhiều người, chỉ còn mình sống): ẩn minimap, hiện chữ
// TOP 1 vàng thật to kèm một câu chúc mừng ngẫu nhiên, rồi mới sang bảng kết quả.
const VICTORY_LINES = [
  "Gà quay tối nay là của bạn! 🍗",
  "Cả bản đồ này giờ là nhà của bạn!",
  "Không ai cản nổi bạn hôm nay!",
  "Người cuối cùng đứng vững — chính là bạn!",
  "Đối thủ đã về sảnh, còn bạn về nhất!",
];
let victoryTimer = null;
function showVictory() {
  if (victoryTimer || $("#result").classList.contains("active")) return;
  stopFiring();
  if (scoped) setScope(false);
  if (paused) {
    paused = false;
    $("#gameMessage").classList.add("hidden");
  }
  $("#flightHud")?.classList.add("hidden");
  setText(
    $("#victoryLine"),
    VICTORY_LINES[Math.floor(Math.random() * VICTORY_LINES.length)],
  );
  $("#victoryOverlay")?.classList.remove("hidden");
  playVictoryFanfare();
  victoryTimer = setTimeout(() => {
    victoryTimer = null;
    showResult();
  }, 6000);
}
function hideVictory() {
  if (victoryTimer) clearTimeout(victoryTimer);
  victoryTimer = null;
  $("#victoryOverlay")?.classList.add("hidden");
}
function playVictoryFanfare() {
  [523, 659, 784, 1047].forEach((freq, i) =>
    setTimeout(() => tone(freq, i === 3 ? 0.5 : 0.16, "triangle", 0.05), i * 150),
  );
}
function showResult() {
  if (!$("#game").classList.contains("active")) return;
  if ($("#result").classList.contains("active")) return;
  hideVictory();
  if (deathResultTimer) clearTimeout(deathResultTimer);
  deathResultTimer = null;
  deathView = null;
  camera?.up.set(0, 1, 0);
  if (renderer?.domElement) renderer.domElement.style.filter = "";
  // Clear screen effects before switching views so the fixed zone tint (and
  // any last damage/death effect) cannot wash out the result panel.
  for (const id of ["zoneGrayOverlay", "zoneDangerTint", "damageDirection"]) {
    const overlay = document.getElementById(id);
    if (!overlay) continue;
    setStyle(overlay, "opacity", "0");
    overlay.classList.remove("show", "active");
    if (id === "damageDirection") overlay.classList.add("hidden");
  }
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
        "Bạn đã bị chịch. Hãy xem lại chiến thuật và thử thêm lần nữa.";
  resultEndsAt = Date.now() + 20000;
  const updateCountdown = () => {
    const secondsLeft = Math.max(
      0,
      Math.ceil((resultEndsAt - Date.now()) / 1000),
    );
    $("#resultDetail").textContent =
      `${resultMessage} Tự động chuyển sang Chiến tích sau ${secondsLeft} giây.`;
  };
  clearTimeout(resultTimeout);
  clearInterval(resultCountdown);
  updateCountdown();
  // Trận đấu đang chạy ở fullscreen; thoát ra trước khi hiện bảng kết quả
  // vì bảng kết quả nằm ngoài phần tử #game đang được fullscreen.
  releaseGameInputMode();
  show("result");
  resultCountdown = setInterval(updateCountdown, 250);
  resultTimeout = setTimeout(showTrophies, 20000);
}
// Danh sách đối thủ mình đã hạ trong trận (cho màn Chiến tích).
let matchKills = [];
function renderTrophies() {
  setText($("#trophyKills"), local.kills || matchKills.length);
  const heads = matchKills.filter((k) => k.headshot).length;
  const longest = matchKills.reduce((m, k) => Math.max(m, k.distance || 0), 0);
  setText(
    $("#trophySub"),
    matchKills.length
      ? `HEADSHOT: ${heads} · XA NHẤT: ${longest} M`
      : "Chưa hạ được ai trong trận này — lần sau sẽ khác!",
  );
  const list = $("#trophyList");
  list.innerHTML = "";
  if (!matchKills.length) {
    const li = document.createElement("li");
    li.className = "trophy-empty";
    li.textContent = "Không có lượt hạ gục nào.";
    list.append(li);
    return;
  }
  matchKills.forEach((k, i) => {
    const li = document.createElement("li");
    const t = Math.floor(k.at / 1000);
    li.innerHTML = `<i>HẠ: #${i + 1}</i><div><strong></strong><small>PHÚT ${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}${k.distance ? ` · ${k.distance} M` : ""}</small></div><span class="${k.headshot ? "hs" : ""}">${k.weapon}${k.headshot ? " · HEADSHOT" : ""}</span>`;
    li.querySelector("strong").textContent = k.name; // tên người chơi: không chèn HTML
    list.append(li);
  });
}
// Bảng kết quả → Chiến tích → Trang chủ.
function showTrophies() {
  renderTrophies();
  returnHome("trophies");
}
function returnHome(target = "menu") {
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
  show(target);
}
$("#returnBtn").onclick = showTrophies;
$("#trophyHomeBtn").onclick = () => show("menu");
