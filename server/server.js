// Minimal room and authoritative match server for a 4–5 player student prototype.
// The server owns health, hits, kills and match state; clients only send inputs.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { WebSocketServer } = require("ws");
const Terrain = require("../public/terrain.js");
// Nhà sàn + thành chính: hình học dùng chung với client (public/structures.js).
const Structures = require("../public/structures.js");
const Attach = require("../public/attachments.js");
const { createObstacles } = require("./mapgen.js");

const ROOT = path.join(__dirname, "..", "public");
const PORT = Number(process.env.PORT || 3000);
const rooms = new Map();
// Đo "server bận": độ trễ vòng lặp sự kiện (p99, cửa sổ ~5 s). Trên Render gói
// free (0.1 CPU) tiến trình bị HĐH tạm dừng khi dùng hết hạn mức CPU → mọi gói
// tin (kể cả ping) phải chờ. Giá trị này được gửi kèm "pong" để HUD phân biệt
// trễ do MẠNG hay do SERVER nghẽn.
const { monitorEventLoopDelay } = require("node:perf_hooks");
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
let serverLagMs = 0;
setInterval(() => {
  // Trừ đi độ phân giải lấy mẫu (10 ms) để đo đúng phần bị "kẹt".
  serverLagMs = Math.max(0, Math.round(loopDelay.percentile(99) / 1e6 - 10));
  loopDelay.reset();
}, 5000).unref();

// ---- Luồng trận: waiting -> staging -> countdown -> plane -> playing -> finished ----
//  waiting   : phòng chờ (chưa vào map), người chơi nhập mã và vào phòng.
//  staging   : chủ phòng bấm bắt đầu; mọi người vào map, đứng chờ tay không.
//              Khi TẤT CẢ người chơi báo "ready" (đã dựng xong map) mới sang countdown.
//  countdown : đếm ngược COUNTDOWN_MS.
//  plane     : tất cả lên chung một máy bay bay thẳng qua map; nhảy dù khi máy bay vào vùng map.
//  playing   : mọi người đã nhảy; ai tiếp đất rồi mới được cầm súng / nhặt đồ / bắn.
const MAP_HALF = 200; // map 400 × 400 m: gấp 4 lần diện tích hiện tại (200 × 200)
const MAP_SCALE = MAP_HALF / 50;
const COUNTDOWN_MS = 5000;
/* WEATHER SCHEDULING TEMPORARILY COMMENTED OUT FOR PERFORMANCE TESTING.
const WEATHER_START_DELAY_MS = [25000, 75000]; // chờ ngẫu nhiên trước khi thời tiết bắt đầu
const WEATHER_DURATION_MS = [30000, 70000]; // thời tiết kéo dài ngẫu nhiên trước khi kết thúc
const randomBetween = ([min, max]) => min + Math.random() * (max - min);
*/
// Trận không kết thúc ngay khi hạ người chơi cuối cùng — cho người thắng vài
// giây để nhặt hòm tiếp tế vừa rơi ra trước khi chuyển sang màn kết quả.
const MATCH_END_DELAY_MS = 20000;
const STAGING_TIMEOUT_MS = 20000; // chờ tối đa bấy nhiêu ms cho máy chậm dựng map

// ---- Vòng bo (an toàn thu hẹp dần theo thời gian, giống PUBG) ----
// Vòng đầu tiên phủ hết bản đồ (không gây sát thương). Cứ hết một lượt "chờ"
// là vòng lại thu hẹp về một vòng tròn nhỏ hơn, nằm ngẫu nhiên bên trong vòng
// cũ; càng về sau vòng càng nhỏ và sát thương mỗi giây cho người đứng ngoài
// càng cao.
const ZONE_STAGES = [
  // Vòng đầu chờ lâu (người chơi vừa tiếp đất, cần thời gian nhặt đồ / tìm xe),
  // các vòng sau cũng thu chậm hơn trước khoảng gấp đôi.
  { radiusRatio: 0.62, waitMs: 90000, shrinkMs: 60000, damage: 1.5 },
  { radiusRatio: 0.55, waitMs: 70000, shrinkMs: 50000, damage: 3 },
  { radiusRatio: 0.5, waitMs: 60000, shrinkMs: 45000, damage: 5 },
  { radiusRatio: 0.45, waitMs: 50000, shrinkMs: 40000, damage: 8 },
  { radiusRatio: 0.4, waitMs: 45000, shrinkMs: 35000, damage: 11 },
  { radiusRatio: 0.35, waitMs: 40000, shrinkMs: 30000, damage: 15 },
  { radiusRatio: 0.3, waitMs: 35000, shrinkMs: 25000, damage: 20 },
];
const ZONE_FULL_RADIUS = MAP_HALF * Math.SQRT2; // đủ phủ hết bản đồ hình vuông
const ZONE_TICK_SECONDS = 0.1; // tickRoom chạy mỗi 100ms

const PLANE_ALT = 200; // độ cao máy bay (m)
const PLANE_SPEED = 12; // m/s
const PLANE_LEAD = 65; // máy bay xuất phát cách góc xa nhất của zone ít nhất bấy nhiêu m
// Chỗ đứng trong khoang máy bay (x phải, z lùi về sau), gần nhau, cùng hướng về phía trước.
const PLANE_SEATS = [
  [-0.9, 2.2],
  [0.9, 2.2],
  [-0.9, 0.6],
  [0.9, 0.6],
  [-0.9, -1.0],
];
// Giới hạn tốc độ để server chặn gian lận thô (client dùng các số nhỏ hơn một chút).
const AIR = {
  freefallHoriz: 20,
  chuteHoriz: 9,
  maxFall: 55,
  maxLandingHeight: 40,
};
// ---- Xác nhận trúng đạn theo "thấy gì bắn nấy" ----
// Client hiển thị địch ở vị trí cũ hơn vị trí thật trên server (độ trễ mạng +
// tick), nên tia ngắm đúng trên màn hình vẫn có thể trượt nếu chỉ so với vị
// trí mới nhất. Ta lưu lịch sử vị trí ngắn và chấp nhận cú bắn nếu tia đi
// qua gần địch ở BẤT KỲ mốc nào trong cửa sổ này.
const POSITION_HISTORY_MS = 1000;
const CLAIM_WINDOW_MS = 450;
const poseSample = (q, now) => ({
  t: now,
  x: q.x,
  z: q.z,
  baseY:
    q.state === "freefall" || q.state === "parachute"
      ? Number(q.y) || 0
      : q.swimming
        ? q.swimY || 0
        : q.groundY || 0,
  jumpY: q.jumpY || 0,
  crouching: Boolean(q.crouching),
  prone: Boolean(q.prone),
});
function recordPositionHistory(room, now) {
  for (const q of room.players.values()) {
    q.history ||= [];
    q.history.push(poseSample(q, now));
    while (q.history.length > 1 && now - q.history[0].t > POSITION_HISTORY_MS)
      q.history.shift();
  }
}
// Trả về khoảng cách dọc theo tia tới mục tiêu nếu tia đi đủ gần (null nếu không).
function claimAlong(q, part, origin, dir, now) {
  const samples = (q.history || []).filter((s) => now - s.t <= CLAIM_WINDOW_MS);
  samples.push(poseSample(q, now));
  const tolerance = part === "head" ? 0.8 : 1.1;
  let best = null;
  for (const s of samples) {
    const py = s.prone
      ? s.baseY + 0.35
      : s.baseY +
        s.jumpY +
        (part === "head" ? (s.crouching ? 1.34 : 1.8) : s.crouching ? 0.65 : 1.0);
    const vx = s.x - origin.x,
      vy = py - origin.y,
      vz = s.z - origin.z;
    const along = vx * dir.x + vy * dir.y + vz * dir.z;
    if (along < 0.1 || along > 140) continue;
    const perp = Math.hypot(
      vx - dir.x * along,
      vy - dir.y * along,
      vz - dir.z * along,
    );
    if (perp <= tolerance && (best === null || along < best)) best = along;
  }
  return best;
}
// Bộ hộp hitbox theo tư thế (đơn vị mét, chân ở y = 0; y cộng thêm độ cao nền).
// Số liệu giống HITBOX trong public/avatar.js — sửa một bên thì sửa cả hai.
const HIT_STAND = [
  { part: "head", c: [0, 1.8, 0], h: [0.28, 0.3, 0.27], peek: 0.32 },
  { part: "body", c: [0, 1.14, 0], h: [0.31, 0.36, 0.21], peek: 0.2 },
  { part: "body", c: [0, 0.45, 0], h: [0.2, 0.45, 0.15], peek: 0 },
];
const HIT_CROUCH = [
  { part: "head", c: [0, 1.34, -0.25], h: [0.28, 0.3, 0.27], peek: 0.24 },
  { part: "body", c: [0, 0.8, -0.08], h: [0.31, 0.3, 0.24], peek: 0.14 },
  { part: "body", c: [0, 0.3, -0.15], h: [0.2, 0.3, 0.3], peek: 0 },
];
// Nằm sấp: mô hình đứng xoay nằm xuống (trục cao → hướng trước mặt), tâm cao 0.35 m.
const HIT_PRONE = [
  { part: "head", c: [0, 0.35, -1.8], h: [0.28, 0.27, 0.3] },
  { part: "body", c: [0, 0.35, -1.14], h: [0.31, 0.21, 0.36] },
  { part: "body", c: [0, 0.35, -0.45], h: [0.2, 0.15, 0.45] },
];
const HIT_SEAT = [
  { part: "head", c: [0, 1.38, 0.06], h: [0.28, 0.3, 0.27] },
  { part: "body", c: [0, 0.87, 0.02], h: [0.31, 0.3, 0.21] },
  { part: "body", c: [0, 0.45, -0.25], h: [0.2, 0.18, 0.3] },
];
const HIT_FREEFALL = [
  { part: "head", c: [0, 0.5 + Math.cos(1.35) * 1.8, -1.8], h: [0.28, 0.27, 0.3] },
  { part: "body", c: [0, 0.5 + Math.cos(1.35) * 1.14, -1.14], h: [0.31, 0.21, 0.36] },
  { part: "body", c: [0, 0.5 + Math.cos(1.35) * 0.45, -0.45], h: [0.2, 0.15, 0.45] },
];
function playerHitboxes(q) {
  if (q.vehicleId) return { boxes: HIT_SEAT };
  if (q.state === "freefall") return { boxes: HIT_FREEFALL };
  if (q.prone) return { boxes: HIT_PRONE };
  const base = q.crouching ? HIT_CROUCH : HIT_STAND;
  const jump = q.jumpY || 0;
  const peek = Math.max(-1, Math.min(1, Number(q.peek) || 0));
  if (!jump && !peek) return { boxes: base };
  // Peek nghiêng người sang phải/trái quanh bàn chân: đầu và thân dịch ngang.
  return {
    boxes: base.map((b) => ({
      ...b,
      c: [b.c[0] + peek * (b.peek || 0), b.c[1] + jump, b.c[2]],
    })),
  };
}
const isGrounded = (p) => p.state === "lobby" || p.state === "ground";
// Đi lại: đứng chờ trong map (staging/countdown) hoặc đã tiếp đất.
const canWalk = (room, p) =>
  p.alive &&
  ((p.state === "lobby" &&
    (room.phase === "staging" || room.phase === "countdown")) ||
    (p.state === "ground" &&
      (room.phase === "plane" || room.phase === "playing")));
// Súng / nhặt đồ / hồi máu chỉ sau khi tiếp đất.
const canFight = (room, p) =>
  p.alive &&
  p.state === "ground" &&
  (room.phase === "plane" || room.phase === "playing");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
};
// File tĩnh được đọc + nén gzip MỘT lần rồi giữ trong RAM. Trước đây mỗi lượt
// tải trang lại đọc đĩa và gửi nguyên 245 KB game.js chưa nén — trên gói free
// (CPU/băng thông thấp) việc này tranh CPU với vòng lặp trận đấu.
const staticCache = new Map();
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".svg", ".json", ".webmanifest", ".txt"]);
function loadStatic(file, done) {
  // stat() rất rẻ; nhờ nó sửa file khi đang chạy vẫn có hiệu lực ngay.
  fs.stat(file, (statErr, stat) => {
    if (statErr || !stat.isFile()) return done(statErr || new Error("not a file"));
    const cached = staticCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs) return done(null, cached);
    readStatic(file, stat.mtimeMs, done);
  });
}
function readStatic(file, mtimeMs, done) {
  fs.readFile(file, (err, data) => {
    if (err) return done(err);
    const ext = path.extname(file);
    const entry = {
      mtimeMs,
      data,
      gz: COMPRESSIBLE.has(ext) ? zlib.gzipSync(data, { level: 9 }) : null,
      etag: `"${crypto.createHash("sha1").update(data).digest("base64url").slice(0, 16)}"`,
      type: types[ext] || "application/octet-stream",
      // Mã nguồn / trang luôn kiểm tra lại (ETag → 304) để bản cập nhật có hiệu lực
      // ngay; ảnh/âm thanh ít đổi nên cho trình duyệt giữ 1 ngày.
      cacheControl: COMPRESSIBLE.has(ext) ? "no-cache" : "public, max-age=86400",
    };
    staticCache.set(file, entry);
    done(null, entry);
  });
}
const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const file = path.resolve(
    ROOT,
    "." + (urlPath === "/" ? "/index.html" : urlPath),
  );
  if (
    !file.startsWith(ROOT + path.sep) &&
    file !== path.join(ROOT, "index.html")
  ) {
    res.writeHead(403).end();
    return;
  }
  loadStatic(file, (err, entry) => {
    if (err) {
      res.writeHead(404).end("Not found");
      return;
    }
    const headers = {
      "Content-Type": entry.type,
      "Cache-Control": entry.cacheControl,
      ETag: entry.etag,
      Vary: "Accept-Encoding",
    };
    if (req.headers["if-none-match"] === entry.etag) {
      res.writeHead(304, headers).end();
      return;
    }
    const useGzip =
      entry.gz && /\bgzip\b/.test(req.headers["accept-encoding"] || "");
    if (useGzip) headers["Content-Encoding"] = "gzip";
    res.writeHead(200, headers);
    res.end(useGzip ? entry.gz : entry.data);
  });
});
// Nén từng gói WebSocket tốn CPU server và thêm độ trễ; gói state đã được làm gọn.
const wss = new WebSocketServer({ server, perMessageDeflate: false });
const send = (ws, data) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
};
// Làm tròn số trước khi gửi: JSON của 20 gói/giây × mỗi người chơi ngắn đi
// gần một nửa (tọa độ 1 cm, góc 0.001 rad là quá đủ cho hiển thị và hitbox).
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);
const snapshot = (room) => ({
  type: "state",
  phase: room.phase,
  now: Date.now(),
  countdownEndsAt: room.countdownEndsAt || 0,
  plane: room.plane || null,
  mapSeed: room.mapSeed,
  mapId: room.mapId,
  // weatherActive: Boolean(room.weather?.active), // weather sync disabled
  // Lựu đạn đang bay / lăn trên đất (server mô phỏng, client chỉ vẽ).
  grenades: (room.grenades || []).map((g) => ({ id: g.id, kind: g.kind, x: r2(g.x), y: r2(g.y), z: r2(g.z), vx: r2(g.vx), vy: r2(g.vy), vz: r2(g.vz) })),
  vehicles: (room.vehicles || []).map((v) => ({
    id: v.id,
    color: v.color,
    x: r2(v.x),
    z: r2(v.z),
    yaw: r3(v.yaw),
    speed: r2(v.speed),
    // Điều khiển hiện tại giúp client dự đoán xe người khác giữa hai gói tin.
    steer: v.controls?.steer || 0,
    throttle: v.controls?.throttle || 0,
    brake: Boolean(v.controls?.brake),
    engineOff: Boolean(v.engineOff), // tài xế bấm Z: tắt tiếng máy khi không ga
    hp: v.hp,
    destroyed: v.destroyed,
    smoke: v.smoke,
    submerged: v.submerged,
    sinkDepth: r2(v.sinkDepth || 0),
  })),
  zone: room.zone || null,
  hostId: [...room.players.keys()][0] || null,
  lastElimination: room.lastElimination || null,
  crates: room.crates || [],
  lastHit: room.lastHit || null,
  players: [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    skin: p.skin || "green",
    x: r2(p.x),
    z: r2(p.z),
    groundY: r2(p.groundY || 0),
    state: p.state || "lobby",
    seat: p.seat || 0,
    y: p.state === "freefall" || p.state === "parachute" ? r2(p.y) : null,
    ready: Boolean(p.ready),
    swimming: Boolean(p.swimming),
    swimY: p.swimming ? r2(p.swimY) : null,
    yaw: r3(p.yaw),
    pitch: r2(p.pitch || 0),
    peek: r2(p.peek || 0),
    hp: Math.round(p.hp),
    kills: p.kills,
    placement: p.placement || 0,
    alive: p.alive,
    crouching: p.crouching,
    prone: p.prone,
    slowWalking: p.slowWalking,
    sprinting: Boolean(p.sprinting && p.alive && !p.vehicleId && !p.swimming),
    vehicleId: p.vehicleId || null,
    vehicleSeat: Number.isInteger(p.vehicleSeat) ? p.vehicleSeat : -1,
    jumpY: r2(p.jumpY),
    ammo: p.ammo,
    weapon: p.weapon || "none",
    punchId: p.punchId || 0,
    reserveAmmo: p.reserveAmmo,
    medkits: p.medkits || 0,
    frags: p.frags || 0,
    flashes: p.flashes || 0,
    // Người khác nhìn thấy: đang cầm lựu đạn loại nào, đã rút chốt chưa, số lần ném.
    throwable: p.alive && !p.vehicleId ? p.throwable || null : null,
    cooking: Boolean(p.cook),
    aiming: Boolean(p.aimThrow) && p.alive && !p.vehicleId, // đang giữ chuột lấy đà ném
    throwId: p.throwId || 0,
    pickupId: p.pickupId || 0,
    att: Attach.encode(p.att), // phụ kiện đang gắn: mọi người thấy + nghe (giảm thanh)
    packAtt: (p.packAtt || []).join(","),
    healing: p.alive && p.healingUntil > Date.now(),
    healLeftMs: p.alive ? Math.max(0, (p.healingUntil || 0) - Date.now()) : 0,
    reloading: p.reloadingUntil > Date.now(),
    shotId: p.shotId || 0,
    shooting: Date.now() - (p.lastShotAt || 0) < 150,
  })),
  alive: [...room.players.values()].filter((p) => p.alive).length,
  // Keep the round denominator fixed even if a disconnected player is removed.
  total: room.matchTotal ?? room.players.size,
});
// Gộp nhiều lần gọi broadcast() liên tiếp trong cùng 1 tick mạng thành ĐÚNG
// MỘT lần gửi thật sự (xem flushRoomState, chạy mỗi 50ms ngay sau tickRoom).
// Trước đây mỗi gói "move" của MỖI người chơi (~20 lần/giây/người) đều lập
// tức dựng lại toàn bộ state rồi gửi cho tất cả — chi phí tăng theo O(số
// người chơi²), chính là nguyên nhân giật/lag/tele khi phòng đông người, ảnh
// hưởng luôn cả bắn súng, nạp đạn, lái xe vì tất cả dùng chung vòng lặp sự
// kiện của Node (đơn luồng).
function broadcast(room) {
  room.dirty = true;
}
function flushRoomState(room) {
  if (!room.dirty) return;
  room.dirty = false;
  const data = JSON.stringify(snapshot(room));
  for (const p of room.players.values()) {
    if (p.ws.readyState !== 1) continue;
    // Mạng của người này đang nghẽn: bỏ qua gói cũ thay vì xếp hàng thêm —
    // gói sau (50 ms nữa) đã chứa trạng thái mới nhất, nên họ đỡ bị trễ dồn.
    if (p.ws.bufferedAmount > 64 * 1024) {
      room.dirty = true;
      continue;
    }
    p.ws.send(data);
  }
}
function broadcastRaw(room, payload) {
  const data = JSON.stringify(payload);
  for (const p of room.players.values())
    if (p.ws.readyState === 1) p.ws.send(data);
}
function roomCode() {
  let n;
  do {
    n = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(n));
  return n;
}
// Map được sinh trong server/mapgen.js (địa hình tự nhiên, làng, đường cong, cầu có rào).
function createVehicles(obstacles) {
  const roads = obstacles.filter(
    (item) =>
      item.type === "road" &&
      Math.abs(item.x) < MAP_HALF - 20 &&
      Math.abs(item.z) < MAP_HALF - 20,
  );
  const colors = ["#426846", "#a4763e", "#596c83", "#8b4e43"].sort(
    () => Math.random() - 0.5,
  );
  const usedPositions = [];
  const spawnProbeRoom = { obstacles, players: new Map(), vehicles: [] }; // chỉ để dò va chạm
  const carClearance = 2.8; // bán kính thân xe + khoảng hở an toàn
  const isClear = (x, z, selectedRoad) => {
    if (
      Math.abs(x) > MAP_HALF - carClearance ||
      Math.abs(z) > MAP_HALF - carClearance
    )
      return false;
    // Tránh đặt xe lên làn đường khác, nhất là tại giao lộ.
    for (const road of roads) {
      if (road === selectedRoad) continue;
      const dx = (Math.sin(road.yaw || 0) * road.length) / 2;
      const dz = (Math.cos(road.yaw || 0) * road.length) / 2;
      const ax = road.x - dx,
        az = road.z - dz;
      const vx = dx * 2,
        vz = dz * 2;
      const t = Math.max(
        0,
        Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz || 1)),
      );
      if (Math.hypot(x - (ax + t * vx), z - (az + t * vz)) < road.w / 2 + 2.2)
        return false;
    }
    for (const o of obstacles) {
      if (o.type === "road") continue;
      const dx = x - o.x,
        dz = z - o.z;
      const c = Math.cos(o.yaw || 0),
        s = Math.sin(o.yaw || 0);
      const lx = c * dx - s * dz,
        lz = s * dx + c * dz;
      if (o.type === "hill") {
        // Dù đồi không phải collider đặc, không spawn xe trên dốc/đỉnh.
        const rx = o.w / 2 + carClearance;
        const rz = (o.length || o.w) / 2 + carClearance;
        if ((lx / rx) ** 2 + (lz / rz) ** 2 < 1) return false;
      } else if (o.type === "river" || o.type === "lake") {
        const rx = (o.type === "lake" ? o.w : o.w / 2) + carClearance;
        const rz = (o.type === "lake" ? o.length : o.length / 2) + carClearance;
        if ((lx / rx) ** 2 + (lz / rz) ** 2 < 1) return false;
      } else if (o.type === "house" || o.type === "hut") {
        // Nhà/chòi dùng vùng vuông mở rộng để tính cả thân xe và khoảng lùi.
        const half = o.w / 2 + carClearance;
        if (Math.abs(lx) < half && Math.abs(lz) < half) return false;
      } else {
        const obstacleRadius =
          o.type === "rock"
            ? o.w * 0.5
            : o.type === "tree"
              ? o.w * 0.3
              : o.type === "cactus"
                ? o.w * 0.5
                : o.w * 0.35;
        if (Math.hypot(dx, dz) < obstacleRadius + carClearance) return false;
      }
    }
    // Kiểm thêm TOÀN BỘ thân xe bằng đúng va chạm của game (tường thành, hàng rào,
    // tháp, thành chính, cầu thang nhà sàn, đá, cây...): trước đây chỉ so khoảng
    // cách tới TÂM vật thể nên tường / hàng rào dài vẫn xuyên qua thân xe → kẹt.
    const yaw = selectedRoad?.yaw || 0,
      c = Math.cos(yaw),
      sn = Math.sin(yaw);
    for (let lx = -1.6; lx <= 1.6001; lx += 0.4)
      for (let lz = -2.8; lz <= 2.8001; lz += 0.4) {
        const px = x + c * lx + sn * lz,
          pz = z - sn * lx + c * lz;
        if (blockedPosition(spawnProbeRoom, px, pz, null, null, true, 0.25)) return false;
      }
    // Phía trước / sau đầu xe phải trống ~9 m (lên xe là chạy được ngay, không
    // đâm cây / đá ngay trước mũi).
    for (const dir of [-1, 1])
      for (let d = 3; d <= 9.01; d += 1)
        for (const lx of [-0.9, 0, 0.9]) {
          const px = x + c * lx + sn * dir * d,
            pz = z - sn * lx + c * dir * d;
          if (blockedPosition(spawnProbeRoom, px, pz, null, null, true, 0.25)) return false;
        }
    // Không đặt xe sát các điểm bắt đầu ở khu chờ.
    if (
      [
        [-3, 8],
        [0, 8],
        [3, 8],
        [-3, -8],
        [0, -8],
      ].some(([sx, sz]) => Math.hypot(x - sx, z - sz) < 8)
    )
      return false;
    return usedPositions.every(
      (point) => Math.hypot(point.x - x, point.z - z) > 55,
    );
  };
  return [0, 1].map((index) => {
    let road = roads[0],
      x = 0,
      z = 0,
      found = false;
    for (let attempt = 0; attempt < 600 && !found; attempt++) {
      road = roads[Math.floor(Math.random() * roads.length)];
      const side = Math.random() < 0.5 ? -1 : 1;
      const offsetX = side * (road.w / 2 + 4.2);
      const offsetZ = (Math.random() - 0.5) * road.length * 0.8;
      x = road.x + Math.cos(road.yaw) * offsetX + Math.sin(road.yaw) * offsetZ;
      z = road.z - Math.sin(road.yaw) * offsetX + Math.cos(road.yaw) * offsetZ;
      found = isClear(x, z, road);
    }
    // Không sinh xe trong đá/nhà nếu seed hiện tại quá dày: fallback tiếp tục
    // quét các làn đường cho tới khi tìm được điểm hợp lệ.
    if (!found) {
      outer: for (const candidateRoad of roads) {
        for (const side of [-1, 1]) {
          for (let t = -0.4; t <= 0.4; t += 0.1) {
            const offsetX = side * (candidateRoad.w / 2 + 4.2);
            const offsetZ = t * candidateRoad.length;
            const cx =
              candidateRoad.x +
              Math.cos(candidateRoad.yaw) * offsetX +
              Math.sin(candidateRoad.yaw) * offsetZ;
            const cz =
              candidateRoad.z -
              Math.sin(candidateRoad.yaw) * offsetX +
              Math.cos(candidateRoad.yaw) * offsetZ;
            if (isClear(cx, cz, candidateRoad)) {
              road = candidateRoad;
              x = cx;
              z = cz;
              found = true;
              break outer;
            }
          }
        }
      }
    }
    usedPositions.push({ x, z });
    return {
      id: `car-${index + 1}`,
      x,
      z,
      color: colors[index],
      yaw: road.yaw,
      speed: 0,
      hp: 60,
      hits: 0,
      destroyed: false,
      smoke: 0,
      submerged: false,
      sinkDepth: 0,
      controls: { throttle: 0, steer: 0, brake: false },
      lastTickAt: Date.now(),
    };
  });
}
function vehicleSeatPosition(vehicle, seat = 0) {
  const offsetX = seat === 0 ? -0.43 : 0.43;
  const offsetZ = 0.18;
  return {
    x:
      vehicle.x +
      Math.cos(vehicle.yaw) * offsetX +
      Math.sin(vehicle.yaw) * offsetZ,
    z:
      vehicle.z -
      Math.sin(vehicle.yaw) * offsetX +
      Math.cos(vehicle.yaw) * offsetZ,
  };
}
// ---- Vật phẩm rơi trên map: đạn và bịch máu ----
const PICKUP_RADIUS = 2.5; // mét; client hiện gợi ý F ở 2 m, server dư 0.5 m để bù độ trễ vị trí
const AMMO_PER_BOX = 30;
const AMMO_BOX_COUNT = 416;
const MEDKIT_COUNT = 224;
const HEAL_AMOUNT = 20;
const HEAL_DURATION_MS = 5000;
const MAX_HP = 100;
// Sức chứa balo (đạn dự trữ và bịch máu). Không tính đạn đang lắp trong súng.
const MAX_RESERVE_AMMO = 210;
const MAX_MEDKITS = 5;
// Lựu đạn: nổ (frag) và choáng (flash). Mỗi loại mang tối đa MAX_THROWABLES quả.
const MAX_THROWABLES = 3;
const FRAG_COUNT = 60,
  FLASH_COUNT = 40;
const GRENADE = {
  frag: { fuse: 6000, kill: 3.5, reach: 11, name: "LỰU ĐẠN NỔ" },
  flash: { fuse: 2000, name: "LỰU ĐẠN CHOÁNG" }, // choáng nổ nhanh hơn
};
const THROW_SPEED = 25; // m/s — ném xa ~30 m (góc 45°), khớp client
const throwKey = (kind) => (kind === "flash" ? "flashes" : "frags");
// ---------------------------------------------------------------------------
// LƯỚI KHÔNG GIAN (spatial grid) cho vật cản tĩnh
// ---------------------------------------------------------------------------
// Map có ~500 vật cản. Trước đây MỌI phép kiểm tra va chạm / độ cao / nước đều
// quét hết cả 500 cái, và mỗi gói "move" gọi hàng chục phép như vậy. Chia map
// thành ô 16 m; mỗi vật cản được ghi vào mọi ô mà nó (cộng biên an toàn) chạm
// tới, nên một điểm chỉ cần xét vài vật cản trong đúng ô của nó.
const GRID_CELL = 16;
const GRID_MARGIN = 3; // > khoảng hở lớn nhất khi truy vấn (loot cách đường 2.5, nằm sấp 1.15, mái +0.6, cầu +1.2)
const EMPTY_CELL = Object.freeze([]);
function obstacleBoundRadius(o) {
  const w = o.w || 1;
  const length = o.length || w;
  if (o.type === "lake") return Math.max(w, length);
  // Đường được đo như hình con nhộng (đoạn thẳng + nửa bề rộng ở hai đầu).
  if (o.type === "road" || o.type === "river") return (length + w) / 2;
  return Math.hypot(w, length) * 0.6 + (o.lift ? 4 : 0); // nhà sàn: + cầu thang
}
// Gắn hàm tra ô trực tiếp lên mảng obstacles (JSON.stringify bỏ qua thuộc tính
// không phải chỉ số nên dữ liệu gửi cho client không đổi).
const TERRAIN_ONLY = new Set(["hill", "terrain", "plateau", "pad", "swamp"]);
function attachObstacleGrid(obstacles) {
  const cells = new Map();
  const key = (ix, iz) => (ix + 512) * 1024 + (iz + 512);
  for (const o of obstacles) {
    // Đồi / cao nguyên / nền nhà / đầm lầy chỉ dùng để dựng địa hình.
    if (TERRAIN_ONLY.has(o.type) || !Number.isFinite(o.x)) continue;
    const r = obstacleBoundRadius(o) + GRID_MARGIN;
    const x0 = Math.floor((o.x - r) / GRID_CELL),
      x1 = Math.floor((o.x + r) / GRID_CELL);
    const z0 = Math.floor((o.z - r) / GRID_CELL),
      z1 = Math.floor((o.z + r) / GRID_CELL);
    for (let ix = x0; ix <= x1; ix++)
      for (let iz = z0; iz <= z1; iz++) {
        const k = key(ix, iz);
        let cell = cells.get(k);
        if (!cell) cells.set(k, (cell = []));
        cell.push(o);
      }
  }
  Object.defineProperty(obstacles, "cellAt", {
    value: (x, z) =>
      cells.get(key(Math.floor(x / GRID_CELL), Math.floor(z / GRID_CELL))) ||
      EMPTY_CELL,
    enumerable: false,
  });
  return obstacles;
}
// Vật cản có thể ảnh hưởng tới điểm (x, z); rơi về toàn bộ danh sách khi chưa có lưới.
const nearObstacles = (obstacles, x, z) =>
  obstacles.cellAt ? obstacles.cellAt(x, z) : obstacles;
function isNearRoad(obstacles, x, z, clearance = 0) {
  return nearObstacles(obstacles, x, z).some((road) => {
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
function isOnBridge(obstacles, x, z, clearance = 0) {
  return nearObstacles(obstacles, x, z).some((road) => {
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
      Math.hypot(x - (ax + t * vx), z - (az + t * vz)) < road.w / 2 + clearance
    );
  });
}
// Vật phẩm chỉ nằm TRONG các căn nhà/chòi: mỗi nhà có một lưới ô trên sàn
// (cách tường ≥ 0.8 m, chừa lối cửa), mỗi ô tối đa một món → không chồng lên nhau.
// Vật phẩm được chia vòng quanh các nhà theo thứ tự ngẫu nhiên nên nhà nào cũng có đồ.
function createLoot(room) {
  const items = [];
  let nextId = 1;
  const houses = room.obstacles.filter(
    (o) => o.type === "house" || o.type === "hut",
  );
  // Thành chính: mỗi tầng là một "nhà" riêng trong vòng chia đồ (đồ nằm đúng tầng).
  const keepFloors = [];
  for (const keep of room.obstacles.filter((o) => o.type === "keep")) {
    const ground = obstacleBaseY(room, keep);
    const byLevel = new Map();
    for (const slot of Structures.keepLootSlots()) {
      const [x, z] = Structures.toWorld(keep, slot.lx, slot.lz);
      if (!byLevel.has(slot.level)) byLevel.set(slot.level, []);
      byLevel.get(slot.level).push({ x, z, y: Math.round((ground + slot.y) * 100) / 100 });
    }
    for (const cells of byLevel.values()) keepFloors.push(cells);
  }
  const slots = houses.map((house) => {
    const inner = house.w / 2 - 0.8;
    const cells = [];
    for (let lx = -inner; lx <= inner + 1e-6; lx += 1.2)
      for (let lz = -inner; lz <= inner + 1e-6; lz += 1.2) {
        // Lối vào ngay sau cửa (mặt -Z) để trống cho người chơi đi vào.
        if (lz < -inner + 1.3 && Math.abs(lx) < 1.3) continue;
        const c = Math.cos(house.yaw || 0),
          sn = Math.sin(house.yaw || 0);
        // Toạ độ cục bộ → thế giới (nghịch đảo phép xoay dùng trong blockedByBuilding).
        cells.push({
          x: house.x + c * lx + sn * lz,
          z: house.z - sn * lx + c * lz,
        });
      }
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }
    return cells;
  });
  for (const cells of keepFloors) {
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }
    // Mỗi tầng thành chính được chia đồ nhiều lượt (công trình lớn, nhiều đồ hơn nhà).
    for (let k = 0; k < 3; k++) slots.push(cells);
  }
  const order = slots.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  let cursor = 0;
  const place = (type, count, amount) => {
    let made = 0,
      misses = 0;
    while (made < count && misses < order.length) {
      const cells = slots[order[cursor % order.length]];
      cursor++;
      const cell = cells?.pop();
      if (!cell) {
        misses++;
        continue;
      }
      misses = 0;
      items.push({
        id: nextId++,
        type,
        x: Math.round(cell.x * 100) / 100,
        z: Math.round(cell.z * 100) / 100,
        ...(cell.y !== undefined ? { y: cell.y } : {}), // đồ ở tầng trên thành chính
        amount,
      });
      made++;
    }
  };
  // Súng đặt trước (luôn đủ chỗ), rồi tới đạn và bịch máu. Mọi người tiếp
  // đất tay không → phải vào nhà tìm súng; mỗi khẩu nằm ngang, hướng ngẫu nhiên.
  for (const [weapon, count] of Object.entries(WEAPON_SPAWNS)) {
    const before = items.length;
    place("weapon", count, 1);
    for (const item of items.slice(before)) {
      item.weapon = weapon;
      item.ammo = 0; // súng mới nhặt KHÔNG có đạn sẵn — phải tìm hộp đạn rồi nạp (R)
      item.yaw = Math.round(Math.random() * 628) / 100;
    }
  }
  place("frag", FRAG_COUNT, 1);
  place("flash", FLASH_COUNT, 1);
  place("ammo", AMMO_BOX_COUNT, AMMO_PER_BOX);
  place("medkit", MEDKIT_COUNT, 1);
  for (const [att, count] of Object.entries(Attach.SPAWNS)) {
    const before = items.length;
    place("attach", count, 1);
    for (const item of items.slice(before)) {
      item.att = att;
      item.yaw = Math.round(Math.random() * 628) / 100;
    }
  }
  return items;
}
// Thông số vũ khí (server là nơi quyết định). "none" = tay không.
const WEAPON_STATS = {
  none: { name: "TAY KHÔNG", mag: 0, cooldown: 450, head: 50, body: 5, range: 1.9 },
  ranger: { name: "AUG", mag: 30, cooldown: 55, head: 50, body: 10, range: 140 },
  beryl: { name: "BERYL M762", mag: 30, cooldown: 65, head: 60, body: 13, range: 140 },
  sniper: { name: "KAR98K", mag: 5, cooldown: 1500, head: 100, body: 60, range: 140 },
};
// Số súng rải trong các khu nhà mỗi trận (sniper tăng từ 2 lên 7 cho dễ tìm hơn).
const WEAPON_SPAWNS = { ranger: 14, beryl: 10, sniper: 7 };
const weaponStats = (player) => WEAPON_STATS[player.weapon] || WEAPON_STATS.none;
// Thời gian nạp đạn (ms): Kar98k mở khóa nòng, ấn kẹp đạn, đóng khóa nòng —
// lâu hơn nhịp lên đạn giữa 2 phát; súng trường thay băng 1.8 s. Khớp client.
const RELOAD_MS = { ranger: 1800, beryl: 1800, sniper: 3400 };
const reloadMs = (player) => RELOAD_MS[player.weapon] || 1800;
const magazineSize = (player) =>
  weaponStats(player).mag +
  (player.att && player.att.mag && Attach.fits(player.att.mag, player.weapon) ? Attach.magBonus(player.att) : 0);

// ================= PHỤ KIỆN SÚNG =================
// p.att: { scope, muzzle, grip, mag } đang gắn trên súng · p.packAtt: [id] trong balo.
function dropAttLoot(room, p, id, x = p.x, z = p.z) {
  const a = Math.random() * Math.PI * 2,
    r = 0.35 + Math.random() * 0.4;
  const item = {
    id: room.nextLootId++,
    type: "attach",
    att: id,
    x: Math.round((x + Math.cos(a) * r) * 100) / 100,
    z: Math.round((z + Math.sin(a) * r) * 100) / 100,
    yaw: Math.round(Math.random() * 628) / 100,
    amount: 1,
  };
  // Đứng trên tầng cao (thành chính / nhà sàn): đồ nằm đúng tầng đó.
  if ((p.groundY || 0) - groundHeightAt(room, x, z) > 1) item.y = Math.round((p.groundY || 0) * 100) / 100;
  room.loot ||= [];
  room.loot.push(item);
  broadcastRaw(room, { type: "lootAdded", item });
}
function attToPack(room, p, id) {
  p.packAtt ||= [];
  if (p.packAtt.length < Attach.PACK_MAX) p.packAtt.push(id);
  else dropAttLoot(room, p, id); // balo đầy: rơi xuống đất
}
// Súng rời tay (vứt / đổi súng): phụ kiện đang gắn chuyển vào balo.
function stripGunAttachments(room, p) {
  for (const s of Attach.SLOTS) if (p.att && p.att[s]) attToPack(room, p, p.att[s]);
  p.att = {};
}
// Cầm súng mới: tự gắn các phụ kiện hợp trong balo vào ô còn trống.
function autoAttachFromPack(p) {
  p.att ||= {};
  p.packAtt ||= [];
  for (const s of Attach.SLOTS) {
    if (p.att[s]) continue;
    const i = p.packAtt.findIndex((id) => Attach.ATTACH[id].slot === s && Attach.fits(id, p.weapon));
    if (i >= 0) p.att[s] = p.packAtt.splice(i, 1)[0];
  }
}
// Tháo băng mở rộng: số đạn dư trong súng trả về balo.
function clampMagazine(p) {
  const cap = magazineSize(p);
  if (p.ammo > cap) {
    p.reserveAmmo = (p.reserveAmmo || 0) + (p.ammo - cap);
    p.ammo = cap;
  }
}

// Vật thể trên map đứng yên nên độ cao nền dưới chân chúng không bao giờ đổi:
// tính 1 lần rồi nhớ lại.
const obstacleBaseCache = new WeakMap();
function obstacleBaseY(room, o) {
  let base = obstacleBaseCache.get(o);
  if (base === undefined) {
    base = groundHeightAt(room, o.x, o.z);
    obstacleBaseCache.set(o, base);
  }
  return base;
}

// Độ cao nền: tra lưới địa hình dùng chung (public/terrain.js), O(1).
function groundHeightAt(room, x, z) {
  room.terrain ||= Terrain.build(room.obstacles || []);
  let height = room.terrain.heightAt(x, z);
  if (isOnBridge(room.obstacles || [], x, z, 0.2))
    height = Math.max(height, 0.3);
  return height;
}
// Walkable upper surfaces: the pitched roof and the safe crown of large rocks.
// Mọi mặt cao hơn đất tại (x, z): mái nhà, đỉnh đá, sàn / cầu thang nhà sàn.
function raisedSurfacesAt(room, x, z) {
  const out = [];
  for (const o of nearObstacles(room.obstacles, x, z)) {
    if (o.type === "keep") {
      const [lx, lz] = Structures.toLocal(o, x, z);
      Structures.keepSurfaces(o, obstacleBaseY(room, o), lx, lz, out);
      continue;
    }
    if (o.type === "stonewall" || o.type === "tower" || o.type === "fortramp") {
      const [lx, lz] = Structures.toLocal(o, x, z);
      Structures.fortSurfaces(o, obstacleBaseY(room, o), lx, lz, out, (gx, gz) => groundHeightAt(room, gx, gz));
      continue;
    }
    if (o.type !== "house" && o.type !== "hut" && o.type !== "rock") continue;
    if (o.type === "house" || o.type === "hut") {
      const dx = x - o.x,
        dz = z - o.z;
      const c = Math.cos(o.yaw || 0),
        s = Math.sin(o.yaw || 0);
      const lx = c * dx - s * dz,
        lz = s * dx + c * dz;
      if (o.lift) Structures.stiltSurfaces(o, obstacleBaseY(room, o), lx, lz, out);
      const halfX = Math.max(o.w * 0.53, o.w / 2 + 0.6);
      const halfZ = o.w / 2 + 0.6;
      if (Math.abs(lx) > halfX || Math.abs(lz) > halfZ) continue;
      const base = obstacleBaseY(room, o) + (o.lift || 0); // nhà sàn: mái trên sàn cao
      const wallH = o.h * 0.72;
      const height =
        base +
        wallH +
        o.w * 0.16 +
        0.12 * Math.cos(0.48) +
        (o.w * 0.245 - Math.abs(lx)) * Math.sin(0.48);
      out.push({ height, base, type: "roof", obstacle: o });
    } else {
      const dx = x - o.x,
        dz = z - o.z;
      const dist = Math.hypot(dx, dz);
      const topRadius = o.w * 0.46 + 0.6;
      if (dist > topRadius) continue;
      const base = obstacleBaseY(room, o);
      const nx = dx / (o.w * 0.48),
        nz = dz / (o.w * 0.4);
      const r2 = Math.min(1, nx * nx + nz * nz);
      const height = base + o.h * (0.42 + 0.5 * Math.sqrt(1 - r2));
      out.push({ height, base, type: "rock", obstacle: o });
    }
  }
  return out;
}
// Mặt cao nhất (giữ nguyên nghĩa cũ cho các chỗ chỉ cần "đang đứng trên gì").
function raisedSurfaceAt(room, x, z) {
  let best = null;
  for (const c of raisedSurfacesAt(room, x, z)) if (!best || c.height > best.height) best = c;
  return best;
}
// Xét MỌI mặt: đứng trên sàn nhà sàn thì mái ở trên không được chọn nhầm.
function landingHeightAt(room, x, z, previousY) {
  let h = groundHeightAt(room, x, z);
  for (const c of raisedSurfacesAt(room, x, z))
    if (previousY >= c.height - 0.25 && c.height > h) h = c.height;
  return h;
}
function standingHeightAt(room, x, z, previousGroundY) {
  let h = groundHeightAt(room, x, z);
  for (const c of raisedSurfacesAt(room, x, z))
    if (previousGroundY > c.base + 0.55 && c.height > h) h = c.height;
  return h;
}
function waterAt(room, x, z) {
  for (const water of nearObstacles(room.obstacles, x, z)) {
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
      // Players and vehicles use the same bridge footprint as the rendered deck.
      if (isOnBridge(room.obstacles, x, z, 0.8)) continue;
      return { surfaceY: 0.08, depth: water.depth || 4 };
    }
  }
  return null;
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
// Hàng rào / lan can cầu: hộp mỏng xoay theo yaw, dài theo trục length.
function blockedByFence(o, x, z, radius) {
  const dx = x - o.x,
    dz = z - o.z;
  const c = Math.cos(o.yaw || 0),
    s = Math.sin(o.yaw || 0);
  return (
    Math.abs(c * dx - s * dz) < o.w / 2 + radius &&
    Math.abs(s * dx + c * dz) < o.length / 2 + radius
  );
}
const PLAYER_RADIUS = 0.38;
// Tốc độ chạy nhanh (Shift) — khớp SPRINT_SPEED ở client.
const SPRINT_SPEED = 9.5;
// Keep server movement blockers aligned with the visible prop footprints.
function obstacleFootprintRadius(o) {
  if (o.type === "tree") return o.w * 0.25;
  if (o.type === "banana") return o.w * 0.14; // thân chuối mảnh, lách qua được
  if (o.type === "palm") return o.w * 0.2;
  if (o.type === "deadTree") return o.w * 0.28;
  if (o.type === "cactus") return o.w * 0.48;
  if (o.type === "rock") return o.w * 0.46;
  return null;
}
function blockedPosition(
  room,
  x,
  z,
  ignoreId,
  ignoreVehicleId = null,
  ignorePlayers = false,
  radiusOverride = null, // đang kẹt trong vùng đệm: chỉ chặn khi TÂM lọt vào vật rắn
) {
  if (
    x < -MAP_HALF + 1 ||
    x > MAP_HALF - 1 ||
    z < -MAP_HALF + 1 ||
    z > MAP_HALF - 1
  )
    return true;
  const mover = room.players.get(ignoreId);
  const moverRadius = radiusOverride ?? (mover?.prone ? 1.15 : PLAYER_RADIUS);
  const obstacleRadius = radiusOverride ?? (mover?.prone ? 0.55 : PLAYER_RADIUS);
  // Tương tự client: dùng vị trí hiện tại của người chơi để biết họ đang đứng
  // trên mái/đá nào, không dùng điểm đến — tránh chặn nhầm khi đi xuống.
  const support =
    mover?.groundY > 0.45 ? raisedSurfaceAt(room, mover.x, mover.z) : null;
  for (const o of nearObstacles(room.obstacles, x, z)) {
    if (o.solid === false) continue;
    if (o.type === "house" || o.type === "hut") {
      const moverIsOnRoof =
        mover &&
        support?.type === "roof" &&
        support.obstacle === o &&
        mover.groundY > support.base + o.h * 0.72 + 0.1;
      if (moverIsOnRoof) continue;
      if (o.lift) {
        // Gầm nhà sàn: chỉ vướng cột gỗ khi NGỒI / NẰM; đứng thẳng / xe thì vướng sàn.
        const [lx, lz] = Structures.toLocal(o, x, z);
        const rel = mover ? mover.groundY - obstacleBaseY(room, o) : null;
        const hit = Structures.stiltBlocked(o, lx, lz, obstacleRadius, rel, Boolean(mover?.crouching || mover?.prone));
        if (hit !== null) {
          if (hit) return true;
          continue;
        }
      }
      if (blockedByBuilding(o, x, z, obstacleRadius)) return true;
      continue;
    }
    if (o.type === "stonewall" || o.type === "tower" || o.type === "fortramp") {
      // Đứng trên đỉnh tường / tháp / cầu thang thì đi lại được; thấp hơn thì chặn.
      const [lx, lz] = Structures.toLocal(o, x, z);
      const rel = mover ? mover.groundY - obstacleBaseY(room, o) : null;
      if (Structures.fortBlocked(o, lx, lz, obstacleRadius, rel, (gx, gz) => groundHeightAt(room, gx, gz))) return true;
      continue;
    }
    if (o.type === "fence") {
      if (blockedByFence(o, x, z, obstacleRadius)) return true;
      continue;
    }
    if (o.type === "keep") {
      const [lx, lz] = Structures.toLocal(o, x, z);
      const rel = mover ? mover.groundY - obstacleBaseY(room, o) : null;
      if (Structures.keepBlocked(o, lx, lz, obstacleRadius, rel)) return true;
      continue;
    }
    const footprint = obstacleFootprintRadius(o);
    if (footprint !== null) {
      const rockTop =
        o.type === "rock" &&
        support?.type === "rock" &&
        support.obstacle === o &&
        // The drawn top surface is only ~42% of rock height at its rim.
        // Keep the rock passable from above there so walking off the edge
        // does not turn into a collision with the vertical side.
        mover.groundY > support.base + o.h * 0.35;
      if (rockTop) continue;
      if (Math.hypot(x - o.x, z - o.z) < footprint + obstacleRadius)
        return true;
      continue;
    }
    const nearestX = Math.max(o.x - o.w / 2, Math.min(x, o.x + o.w / 2));
    const nearestZ = Math.max(o.z - o.w / 2, Math.min(z, o.z + o.w / 2));
    if (Math.hypot(x - nearestX, z - nearestZ) < obstacleRadius) return true;
  }
  for (const other of room.players.values()) {
    if (ignorePlayers) continue;
    const otherRadius = other.prone ? 1.15 : PLAYER_RADIUS;
    if (
      other.id !== ignoreId &&
      !(mover?.vehicleId && other.vehicleId === mover.vehicleId) &&
      other.alive &&
      isGrounded(other) &&
      Math.hypot(x - other.x, z - other.z) < moverRadius + otherRadius + 0.02
    )
      return true;
  }
  // Vehicles use a footprint matching the rendered body; wrecks remain solid.
  for (const vehicle of room.vehicles || []) {
    if (vehicle.id === ignoreVehicleId) continue;
    const dx = x - vehicle.x;
    const dz = z - vehicle.z;
    const c = Math.cos(vehicle.yaw),
      s = Math.sin(vehicle.yaw);
    const lx = c * dx - s * dz;
    const lz = s * dx + c * dz;
    if (
      Math.abs(lx) < 1.03 + obstacleRadius &&
      Math.abs(lz) < 1.84 + obstacleRadius
    )
      return true;
  }
  return false;
}
// ---------------------------------------------------------------------------
// MÁY BAY / NHẢY DÙ
// ---------------------------------------------------------------------------
// Đường bay thẳng, xuất phát từ ngoài zone, đi xuyên qua map theo một hướng ngẫu nhiên.
function createFlight() {
  const angle = Math.random() * Math.PI * 2;
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);
  const offset = (Math.random() * 2 - 1) * 20 * MAP_SCALE; // lệch khỏi tâm map tối đa 40 m
  const cx = -dz * offset;
  const cz = dx * offset;
  const lead = MAP_HALF * Math.SQRT2 + PLANE_LEAD;
  const sx = cx - dx * lead;
  const sz = cz - dz * lead;
  // Giao đường bay với hình vuông ±MAP_HALF (slab method) -> lúc vào / ra zone.
  let dEnter = -Infinity;
  let dExit = Infinity;
  for (const [origin, dir] of [
    [sx, dx],
    [sz, dz],
  ]) {
    if (Math.abs(dir) < 1e-9) continue;
    let a = (-MAP_HALF - origin) / dir;
    let b = (MAP_HALF - origin) / dir;
    if (a > b) [a, b] = [b, a];
    dEnter = Math.max(dEnter, a);
    dExit = Math.min(dExit, b);
  }
  return {
    sx,
    sz,
    dx,
    dz,
    speed: PLANE_SPEED,
    alt: PLANE_ALT,
    tEnter: dEnter / PLANE_SPEED,
    tExit: dExit / PLANE_SPEED,
  };
}
const planeYaw = (plane) => Math.atan2(-plane.dx, -plane.dz);
function seatWorldPosition(plane, seat, t) {
  const px = plane.sx + plane.dx * plane.speed * t;
  const pz = plane.sz + plane.dz * plane.speed * t;
  const [lx, lz] = PLANE_SEATS[seat % PLANE_SEATS.length];
  const yaw = planeYaw(plane);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { x: px + lx * c + lz * s, z: pz - lx * s + lz * c };
}
const clampToMap = (v) =>
  Math.max(-MAP_HALF + 0.5, Math.min(MAP_HALF - 0.5, v));
function initZone(room) {
  const now = Date.now();
  const full = { x: 0, z: 0 };
  const zone = {
    stageIndex: -1, // -1 = còn nguyên bản đồ, chưa vòng nào hình thành
    phase: "wait", // "wait" (đang chờ thu hẹp) | "shrink" (đang thu hẹp) | "done" (đã tới vòng cuối)
    fromCenter: full,
    fromRadius: ZONE_FULL_RADIUS,
    toCenter: full,
    toRadius: ZONE_FULL_RADIUS,
    shrinkStartAt: now,
    shrinkEndsAt: now,
    waitEndsAt: now + ZONE_STAGES[0].waitMs,
    damage: 0,
  };
  // Pick and replicate the first destination as soon as the current circle
  // starts waiting, so players can plan their rotation before the shrink.
  const firstStage = ZONE_STAGES[0];
  const next = firstStage
    ? pickNextZoneCircle(
        { center: full, radius: ZONE_FULL_RADIUS },
        firstStage.radiusRatio,
      )
    : null;
  zone.nextCenter = next?.center || null;
  zone.nextRadius = next?.radius || 0;
  room.zone = zone;
}
// Chọn vòng kế tiếp: bán kính nhỏ hơn theo tỉ lệ, tâm ngẫu nhiên sao cho vòng
// mới luôn nằm trọn bên trong vòng hiện tại.
function pickNextZoneCircle(fromCircle, ratio) {
  const nextRadius = Math.max(6, fromCircle.radius * ratio);
  const maxOffset = Math.max(0, fromCircle.radius - nextRadius);
  const angle = Math.random() * Math.PI * 2;
  const dist = Math.random() * maxOffset;
  return {
    center: {
      x: clampToMap(fromCircle.center.x + Math.cos(angle) * dist),
      z: clampToMap(fromCircle.center.z + Math.sin(angle) * dist),
    },
    radius: nextRadius,
  };
}
// Vòng tại đúng thời điểm "now": nếu đang thu hẹp thì nội suy giữa vòng cũ và
// vòng đích; nếu không thì đứng yên ở vòng đích (đã hình thành xong).
function currentZoneCircle(zone, now) {
  if (zone.phase !== "shrink")
    return { center: zone.toCenter, radius: zone.toRadius };
  const span = Math.max(1, zone.shrinkEndsAt - zone.shrinkStartAt);
  const t = Math.min(1, Math.max(0, (now - zone.shrinkStartAt) / span));
  return {
    center: {
      x: zone.fromCenter.x + (zone.toCenter.x - zone.fromCenter.x) * t,
      z: zone.fromCenter.z + (zone.toCenter.z - zone.fromCenter.z) * t,
    },
    radius: zone.fromRadius + (zone.toRadius - zone.fromRadius) * t,
  };
}
function tickZone(room, now) {
  const zone = room.zone;
  if (!zone) return;
  let changed = false;
  if (zone.phase === "wait" && now >= zone.waitEndsAt) {
    const nextIndex = zone.stageIndex + 1;
    const stage = ZONE_STAGES[nextIndex];
    if (stage) {
      const from = currentZoneCircle(zone, now);
      const next = zone.nextCenter
        ? { center: zone.nextCenter, radius: zone.nextRadius }
        : pickNextZoneCircle(from, stage.radiusRatio);
      zone.fromCenter = from.center;
      zone.fromRadius = from.radius;
      zone.toCenter = next.center;
      zone.toRadius = next.radius;
      zone.shrinkStartAt = now;
      zone.shrinkEndsAt = now + stage.shrinkMs;
      zone.damage = stage.damage;
      zone.stageIndex = nextIndex;
      zone.phase = "shrink";
    } else {
      zone.phase = "done"; // hết danh sách vòng — giữ nguyên vòng cuối
    }
    changed = true;
  } else if (zone.phase === "shrink" && now >= zone.shrinkEndsAt) {
    zone.phase = "wait";
    zone.waitEndsAt = now + (ZONE_STAGES[zone.stageIndex + 1]?.waitMs ?? 20000);
    const followingStage = ZONE_STAGES[zone.stageIndex + 1];
    const settled = { center: zone.toCenter, radius: zone.toRadius };
    const next = followingStage
      ? pickNextZoneCircle(settled, followingStage.radiusRatio)
      : null;
    zone.nextCenter = next?.center || null;
    zone.nextRadius = next?.radius || 0;
    changed = true;
  }
  // Sát thương cho người đứng ngoài vòng an toàn hiện tại (chỉ tính người đã tiếp đất).
  if (zone.damage > 0) {
    const circle = currentZoneCircle(zone, now);
    for (const p of room.players.values()) {
      if (!p.alive || p.state !== "ground") continue;
      if (
        Math.hypot(p.x - circle.center.x, p.z - circle.center.z) <=
        circle.radius
      )
        continue;
      p.hp = Math.max(0, p.hp - zone.damage * ZONE_TICK_SECONDS);
      changed = true;
      if (p.hp) continue;
      p.alive = false;
      detachFromVehicle(room, p);
      p.placement =
        [...room.players.values()].filter((pl) => pl.alive).length + 1;
      room.eliminationSequence = (room.eliminationSequence || 0) + 1;
      room.lastElimination = {
        id: room.eliminationSequence,
        victimId: p.id,
        victimName: p.name,
        killerId: null,
        killerName: "Vòng bo",
      };
      dropDeathLoot(room, p);
      const remaining = [...room.players.values()].filter((pl) => pl.alive);
      if (remaining.length <= 1 && !room.finishAt) {
        room.finishAt = now + MATCH_END_DELAY_MS;
        if (remaining[0])
          send(remaining[0].ws, {
            type: "toast",
            text: `CHIẾN THẮNG! VÒNG BO ĐÃ NẮC ĐỐI THỦ CỦA BẠN`,
          });
      }
    }
  }
  if (changed) broadcast(room);
}
// Sự kiện âm thanh loot (nhặt / thả) — client phát tiếng theo loại vật phẩm.
function lootSfx(room, p, sound, x = p.x, z = p.z) {
  // Nhặt được đồ: tăng bộ đếm để mọi người thấy động tác cúi xuống nhặt.
  if (sound.startsWith("pickup-")) {
    p.pickupId = (p.pickupId || 0) + 1;
    broadcast(room);
  }
  broadcastRaw(room, {
    type: "lootSfx",
    sound,
    by: p.id,
    x: Math.round(x * 100) / 100,
    z: Math.round(z * 100) / 100,
  });
}
// ---- BỂ MAP SINH SẴN ----
// Sinh 1 map (địa hình + ~800 vật cản) tốn ~100–150 ms CPU. Render gói free
// chỉ cho 0.1 CPU (10 ms mỗi 100 ms) → sinh map ngay lúc tạo phòng làm CẢ
// server đứng ~1.5–2 s: mọi trận đang đánh ở phòng khác bị khựng, ping đỏ.
// Nay map được sinh SẴN lúc server rảnh (không có trận nào đang diễn ra);
// tạo phòng chỉ lấy ra dùng. Hết bể (hiếm) mới sinh tại chỗ như cũ.
const MAP_POOL_SIZE = 2; // mỗi loại map giữ sẵn 2 bản (~vài MB RAM)
const mapPool = { forest: [], desert: [], jungle: [] };
function buildMap(mapId) {
  const mapSeed = Math.floor(Math.random() * 0xffffffff);
  const obstacles = attachObstacleGrid(createObstacles(mapSeed, mapId));
  return { mapSeed, obstacles, terrain: Terrain.build(obstacles) };
}
function takeMap(mapId) {
  const map = mapPool[mapId].pop() || buildMap(mapId);
  scheduleMapRefill();
  return map;
}
// Chỉ sinh map khi KHÔNG AI đang kết nối. Bản trước chỉ tránh lúc có trận
// đang đánh nên vẫn sinh map lúc mọi người ở sảnh chờ → trên Render (0.1 CPU)
// server khựng ~1.5 s ngay trước khi bay (ping vọt 310 ms lúc đầu trận).
function matchInProgress() {
  return wss.clients.size > 0;
}
let mapRefillTimer = null;
function scheduleMapRefill(delay = 4000) {
  if (mapRefillTimer) return;
  mapRefillTimer = setTimeout(() => {
    mapRefillTimer = null;
    refillMapPool();
  }, delay);
  mapRefillTimer.unref?.();
}
function refillMapPool() {
  const missing = Object.keys(mapPool).find((id) => mapPool[id].length < MAP_POOL_SIZE);
  if (!missing) return;
  if (matchInProgress()) return scheduleMapRefill(15000); // thử lại sau
  mapPool[missing].push(buildMap(missing)); // mỗi lần 1 map để không giữ CPU lâu
  scheduleMapRefill(1000);
}
function startPlane(room) {
  room.phase = "plane";
  room.plane = { ...createFlight(), startedAt: Date.now() };
  room.loot = createLoot(room);
  room.nextLootId =
    Math.max(0, ...room.loot.map((item) => Number(item.id) || 0)) + 1;
  let seat = 0;
  for (const p of room.players.values()) {
    p.state = "plane";
    p.seat = seat++;
    p.y = room.plane.alt;
    p.healingUntil = 0;
    p.reloadingUntil = 0;
  }
  broadcastRaw(room, {
    type: "loot",
    items: room.loot,
    limits: { ammo: MAX_RESERVE_AMMO, medkits: MAX_MEDKITS, throwables: MAX_THROWABLES },
  });
  broadcast(room);
}
function jumpPlayer(room, p) {
  const t = (Date.now() - room.plane.startedAt) / 1000;
  const pos = seatWorldPosition(room.plane, p.seat, t);
  p.x = clampToMap(pos.x);
  p.z = clampToMap(pos.z);
  p.y = room.plane.alt;
  p.state = "freefall";
  p.peek = 0;
  p.lastAirAt = Date.now();
}
// Tìm chỗ trống gần nhất để không kẹt trong cây / đá / tường khi tiếp đất.
function findFreeSpot(room, x, z, id, landingY = null) {
  const roofOrRock = raisedSurfaceAt(room, x, z);
  if (
    roofOrRock &&
    Number.isFinite(landingY) &&
    landingY >= roofOrRock.height - 0.35 &&
    landingY <= roofOrRock.height + 2
  )
    return { x, z };
  if (!blockedPosition(room, x, z, id)) return { x, z };
  for (let r = 0.5; r <= 12; r += 0.5) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const nx = x + Math.cos(a) * r;
      const nz = z + Math.sin(a) * r;
      if (!blockedPosition(room, nx, nz, id)) return { x: nx, z: nz };
    }
  }
  return { x, z };
}
// Đồ rơi khi bị hạ (dùng chung cho: bị bắn, bị xe tông / nổ xe, chết trong bo):
//  - HÒM chứa đạn dự trữ + bịch máu;
//  - KHẨU SÚNG đang cầm nằm ngay cạnh hòm (kèm đạn còn trong băng).
// Trước đây hòm đặt đúng chỗ người chết — người lái xe chết thì hòm nằm TRONG
// thân xe: tới gần bấm F là vào xe chứ không mở được hòm → tưởng hòm rỗng.
// Nay hòm/súng được đặt ở chỗ trống cạnh đó (ngoài xe, ngoài tường).
function dropDeathLoot(room, victim) {
  // Chỗ trống: không tường/đá/cây, cách thân mọi xe ≥ 0.8 m (hòm rộng ~1 m,
  // chỉ ra khỏi xe thôi thì vẫn lấn vào hông xe) và không đè lên vật vừa rơi.
  const placed = [];
  const clearOfCars = (x, z) =>
    (room.vehicles || []).every((v) => {
      const dx = x - v.x,
        dz = z - v.z,
        c = Math.cos(v.yaw),
        s = Math.sin(v.yaw);
      return Math.abs(c * dx - s * dz) > 1.03 + 0.8 || Math.abs(s * dx + c * dz) > 1.84 + 0.8;
    });
  const ok = (x, z) =>
    !blockedPosition(room, x, z, victim.id, null, true) &&
    clearOfCars(x, z) &&
    placed.every((p) => Math.hypot(p.x - x, p.z - z) > 0.9);
  const freeNear = (x, z) => {
    for (let r = 0; r <= 8; r += 0.5)
      for (let k = 0; k < (r ? 16 : 1); k++) {
        const a = (k / 16) * Math.PI * 2;
        const nx = x + Math.cos(a) * r,
          nz = z + Math.sin(a) * r;
        if (ok(nx, nz)) return placed.push({ x: nx, z: nz }), { x: nx, z: nz };
      }
    return { x, z }; // hiếm: kẹt giữa nhiều vật cản → để nguyên chỗ
  };
  const spot = freeNear(victim.x, victim.z);
  const weapon = victim.weapon && victim.weapon !== "none" ? victim.weapon : null;
  // Súng nằm trong băng đạn của súng; hòm chỉ giữ đạn dự trữ (tay không thì
  // không có băng nào → dồn hết vào hòm như cũ).
  const crateAmmo = (victim.reserveAmmo || 0) + (weapon ? 0 : victim.ammo || 0);
  const medkit = victim.medkits || 0;
  const frag = victim.frags || 0,
    flash = victim.flashes || 0;
  if (victim.cook) {
    // Đang rút chốt mà bị hạ: quả lựu đạn rơi tại chỗ, vẫn nổ đúng giờ.
    spawnGrenade(room, victim, victim.cook.kind, { x: victim.x, y: (victim.groundY || 0) + 0.6, z: victim.z }, { x: 0, y: 0, z: 0 }, victim.cook.at);
    victim[throwKey(victim.cook.kind)] = Math.max(0, (victim[throwKey(victim.cook.kind)] || 0) - 1);
    victim.cook = null;
  }
  room.crates ||= [];
  if (crateAmmo > 0 || medkit > 0 || frag > 0 || flash > 0)
    room.crates.push({
      id: `crate-${room.nextCrateId++}`,
      x: Math.round(spot.x * 100) / 100,
      z: Math.round(spot.z * 100) / 100,
      contents: { ammo: crateAmmo, medkit, frag: victim.frags || 0, flash: victim.flashes || 0 },
      owner: victim.name || "NGƯỜI CHƠI", // tên người chết — hiện khi loot hòm
    });
  if (weapon) {
    // Ngay cạnh hòm (bên phải theo hướng nhìn của người chết), không chồng lên hòm.
    const yaw = victim.yaw || 0;
    const side = freeNear(spot.x + Math.cos(yaw) * 1.1, spot.z - Math.sin(yaw) * 1.1);
    const dropped = {
      id: room.nextLootId++,
      type: "weapon",
      weapon,
      x: Math.round(side.x * 100) / 100,
      z: Math.round(side.z * 100) / 100,
      yaw: Math.round(Math.random() * 628) / 100,
      amount: 1,
      ammo: Math.max(0, victim.ammo || 0),
    };
    room.loot ||= [];
    room.loot.push(dropped);
    broadcastRaw(room, { type: "lootAdded", item: dropped });
  }
  for (const id of [...Attach.SLOTS.map((s) => victim.att && victim.att[s]), ...(victim.packAtt || [])])
    if (id) dropAttLoot(room, victim, id, spot.x, spot.z);
  victim.att = {};
  victim.packAtt = [];
  // Người chết không còn giữ gì (tránh rơi đồ 2 lần nếu có đường chết khác).
  victim.reserveAmmo = 0;
  victim.medkits = 0;
  victim.frags = 0;
  victim.flashes = 0;
  victim.throwable = null;
  victim.aimThrow = false;
  victim.ammo = 0;
  victim.weapon = "none";
}
function killByVehicle(
  room,
  victim,
  vehicle,
  now = Date.now(),
  cause = "vehicle",
) {
  if (!victim.alive) return;
  victim.hp = 0;
  victim.alive = false;
  victim.vehicleId = null;
  victim.vehicleSeat = -1;
  victim.placement =
    [...room.players.values()].filter((player) => player.alive).length + 1;
  const candidateKiller = room.players.get(vehicle.lastDriverId);
  const killer = candidateKiller === victim ? null : candidateKiller;
  if (killer && killer !== victim) killer.kills++;
  room.eliminationSequence = (room.eliminationSequence || 0) + 1;
  room.lastElimination = {
    id: room.eliminationSequence,
    victimId: victim.id,
    victimName: victim.name,
    killerId: killer?.id || null,
    cause,
    weapon: "XE",
    killerName:
      cause === "explosion"
        ? "Nổ xe"
        : killer?.name ||
          (candidateKiller === victim ? "Rời xe khi đang chạy" : "Xe tông"),
  };
  dropDeathLoot(room, victim);
  const alive = [...room.players.values()].filter((player) => player.alive);
  if (alive.length <= 1 && !room.finishAt) {
    room.finishAt = now + MATCH_END_DELAY_MS;
    if (alive[0])
      send(alive[0].ws, {
        type: "toast",
        text: `CHIẾN THẮNG! RA NGOÀI NHỚ ĐỪNG LÁI XE TÔNG NGƯỜI VẬY NHÉ`,
      });
  }
}
function detachFromVehicle(room, player) {
  if (!player.vehicleId) return;
  const vehicle = room.vehicles.find((v) => v.id === player.vehicleId);
  if (vehicle && player.vehicleSeat === 0)
    vehicle.controls = { throttle: 0, steer: 0, brake: true };
  player.vehicleId = null;
  player.vehicleSeat = -1;
}
// ---------------------------------------------------------------------------
// VA CHẠM XE (client game.js dùng ĐÚNG thuật toán này để dự đoán xe mình lái).
// Điểm lấy mẫu quanh thân xe (đơn vị = nửa rộng / nửa dài): 4 góc, giữa mũi,
// giữa đuôi và 3 điểm dọc mỗi hông (lan can cầu mỏng không lọt giữa 2 mẫu).
// ---------------------------------------------------------------------------
const CAR_HALF_X = 1.03,
  CAR_HALF_Z = 1.84;
const CAR_SAMPLES = [
  [-1, -1], [-1, -0.5], [-1, 0], [-1, 0.5], [-1, 1],
  [1, -1], [1, -0.5], [1, 0], [1, 0.5], [1, 1],
  [0, -1], [0, 1],
];
// Số điểm mẫu bị chặn; trả về cả vật cản đầu tiên để tính hướng trượt.
function vehicleBlockInfo(room, vehicle, x, z, yaw) {
  // Unbridged water stalls and sinks cars; flagged road crossings are bridges.
  if (waterAt(room, x, z) && !isOnBridge(room.obstacles, x, z, 1.2))
    return { count: 0, fences: [] };
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  let count = 0;
  const fences = [];
  for (const [sx, sz] of CAR_SAMPLES) {
    const lx = sx * CAR_HALF_X,
      lz = sz * CAR_HALF_Z;
    const px = x + c * lx + s * lz,
      pz = z - s * lx + c * lz;
    // Xe không cần phép thử bề mặt mái/đá dành cho người đi bộ (mover = null).
    if (blockedPosition(room, px, pz, null, vehicle.id, true)) {
      count++;
      const fence = fenceAt(room, px, pz);
      if (fence && !fences.includes(fence)) fences.push(fence);
    }
  }
  return { count, fences };
}
function vehicleFootprintBlocked(room, vehicle, x, z, yaw) {
  return vehicleBlockInfo(room, vehicle, x, z, yaw).count > 0;
}
// Lan can / hàng rào đang chặn điểm này (để xe trượt dọc theo nó).
function fenceAt(room, x, z) {
  for (const o of nearObstacles(room.obstacles, x, z))
    if ((o.type === "fence" || o.type === "stonewall") && blockedByFence(o, x, z, PLAYER_RADIUS)) return o;
  return null;
}
// Di chuyển xe một bước có xử lý va chạm:
//  - trống → đi thẳng;
//  - đụng lan can/rào → TRƯỢT dọc theo nó (mất chút tốc độ) thay vì dội ngược
//    và kẹt cứng như trước;
//  - đã lỡ lún vào vật cản → cho phép mọi bước làm giảm độ lún (tự thoát ra).
// Trả về: "moved" | "slid" | "blocked".
function moveVehicleStep(room, vehicle, stepX, stepZ, current) {
  const nx = vehicle.x + stepX,
    nz = vehicle.z + stepZ;
  const next = vehicleBlockInfo(room, vehicle, nx, nz, vehicle.yaw);
  if (next.count === 0 || next.count < current.count) {
    vehicle.x = nx;
    vehicle.z = nz;
    current.count = next.count;
    return "moved";
  }
  // Thử trượt theo từng đoạn lan can đang chạm (ở chỗ nối 2 đoạn của cầu
  // cong, đoạn thứ nhất đẩy mũi xe vào đoạn thứ hai → thử luôn đoạn thứ hai).
  for (const fence of next.fences) {
    const tx = Math.sin(fence.yaw || 0),
      tz = Math.cos(fence.yaw || 0);
    const along = (stepX * tx + stepZ * tz) * 0.92;
    if (Math.abs(along) < 1e-4) continue;
    const sx = vehicle.x + tx * along,
      sz = vehicle.z + tz * along;
    const slide = vehicleBlockInfo(room, vehicle, sx, sz, vehicle.yaw);
    // Trượt DỌC lan can: cho phép khi không lún thêm (đang cạ thì số điểm
    // chạm giữ nguyên — trước đây đòi phải giảm nên xe cạ rào là kẹt cứng).
    if (slide.count > current.count) continue;
    vehicle.x = sx;
    vehicle.z = sz;
    current.count = slide.count;
    alignVehicleToFence(room, vehicle, fence, current, Math.hypot(stepX, stepZ));
    return "slid";
  }
  // Chỗ lan can gập vào trong (cầu cong): trượt tịnh tiến vẫn cắm mũi xe vào
  // đoạn kế tiếp. Cho xe đi hết bước rồi ĐẨY RA khỏi lan can theo pháp tuyến
  // (mỗi lần 12 cm, tối đa ~0.7 m) — cách xử lý va chạm chuẩn của game xe.
  if (next.fences.length) {
    let px = nx,
      pz = nz,
      info = next;
    for (let k = 0; k < 6 && info.count > current.count && info.fences.length; k++) {
      const fence = info.fences[0];
      const fy = fence.yaw || 0;
      const nxv = Math.cos(fy),
        nzv = -Math.sin(fy); // pháp tuyến của lan can
      const side = (px - fence.x) * nxv + (pz - fence.z) * nzv >= 0 ? 1 : -1;
      px += nxv * side * 0.12;
      pz += nzv * side * 0.12;
      info = vehicleBlockInfo(room, vehicle, px, pz, vehicle.yaw);
    }
    if (info.count <= current.count) {
      vehicle.x = px;
      vehicle.z = pz;
      current.count = info.count;
      alignVehicleToFence(room, vehicle, next.fences[0], current, Math.hypot(stepX, stepZ));
      return "slid";
    }
  }
  // Đâm chéo vào đá / gốc cây / góc tường: thử lệch hướng nhẹ (±20°, ±40°) để
  // xe trượt dần ra thay vì đứng khựng (cùng luật ở client và server).
  for (const ang of [0.35, -0.35, 0.7, -0.7]) {
    const c = Math.cos(ang),
      sn = Math.sin(ang);
    const tx = (stepX * c - stepZ * sn) * c * 0.85,
      tz = (stepX * sn + stepZ * c) * c * 0.85;
    const info = ((x, z) => vehicleBlockInfo(room, vehicle, x, z, vehicle.yaw))(vehicle.x + tx, vehicle.z + tz);
    if (info.count === 0 || info.count < current.count) {
      vehicle.x += tx;
      vehicle.z += tz;
      current.count = info.count;
      return "slid";
    }
  }
  return "blocked";
}
// Xe cạ lan can bị nắn dần cho song song với lan can (như xe thật quệt rào),
// nhờ vậy đi tiếp được qua chỗ nối các đoạn lan can của cầu cong.
// Nắn theo QUÃNG ĐƯỜNG (≈0.29 rad mỗi mét cạ) để client — bước nhỏ theo
// khung hình — cho đúng kết quả như server bước 0.45 m.
function alignVehicleToFence(room, vehicle, fence, current, stepLen) {
  const fy = fence.yaw || 0;
  // Hướng mũi xe = (-sin yaw, -cos yaw); lan can = (sin fy, cos fy).
  const forwardDot = -Math.sin(vehicle.yaw) * Math.sin(fy) - Math.cos(vehicle.yaw) * Math.cos(fy);
  const targetYaw = forwardDot >= 0 ? fy + Math.PI : fy;
  const diff = Math.atan2(Math.sin(targetYaw - vehicle.yaw), Math.cos(targetYaw - vehicle.yaw));
  const maxTurn = 0.13 * stepLen;
  const turn = Math.max(-maxTurn, Math.min(maxTurn, diff));
  if (Math.abs(turn) < 1e-4) return;
  const turned = vehicleBlockInfo(room, vehicle, vehicle.x, vehicle.z, vehicle.yaw + turn);
  if (turned.count <= current.count) {
    vehicle.yaw += turn;
    current.count = turned.count;
  }
}
function tickVehicles(room, now) {
  let changed = false;
  for (const vehicle of room.vehicles || []) {
    if (vehicle.blastPending) {
      vehicle.blastPending = false;
      for (const victim of room.players.values()) {
        if (
          victim.alive &&
          Math.hypot(victim.x - vehicle.x, victim.z - vehicle.z) <= 8
        )
          killByVehicle(room, victim, vehicle, now, "explosion");
      }
      changed = true;
    }
    if (vehicle.destroyed) continue;
    const dt = Math.min(0.1, Math.max(0.01, (now - vehicle.lastTickAt) / 1000));
    vehicle.lastTickAt = now;
    if (vehicle.submerged) {
      vehicle.speed = 0;
      vehicle.controls = { throttle: 0, steer: 0, brake: false };
      const water = waterAt(room, vehicle.x, vehicle.z);
      const previousSinkDepth = vehicle.sinkDepth || 0;
      vehicle.sinkDepth = Math.min(
        water?.depth || 4,
        previousSinkDepth + dt * 1.2,
      );
      for (const occupant of room.players.values()) {
        if (occupant.vehicleId !== vehicle.id) continue;
        const seat = vehicleSeatPosition(vehicle, occupant.vehicleSeat);
        occupant.x = seat.x;
        occupant.z = seat.z;
        occupant.yaw = vehicle.yaw;
        occupant.groundY =
          groundHeightAt(room, vehicle.x, vehicle.z) - vehicle.sinkDepth;
      }
      changed ||= vehicle.sinkDepth > previousSinkDepth + 0.001;
      continue;
    }
    const driver = [...room.players.values()].find(
      (p) => p.vehicleId === vehicle.id && p.vehicleSeat === 0,
    );
    // Xe đỗ, không tài xế: không có gì để mô phỏng (trước đây vẫn quét va chạm
    // 8 góc xe cho mọi xe đứng yên, 20 lần/giây).
    if (!driver && Math.abs(vehicle.speed) < 0.01) {
      vehicle.speed = 0;
      continue;
    }
    const controls = driver
      ? vehicle.controls
      : { throttle: 0, steer: 0, brake: false };
    const oldSpeed = vehicle.speed;
    if (controls.brake) vehicle.speed *= Math.max(0, 1 - 7 * dt);
    else if (controls.throttle) {
      vehicle.speed += controls.throttle * 8 * dt;
      vehicle.speed = Math.max(-7, Math.min(22, vehicle.speed));
    } else {
      // Nhả ga: xe trôi theo quán tính, chậm dần vì ma sát lăn + lực cản gió
      // (từ 80 km/h mất ~10 s mới dừng), thay vì khựng lại gần như ngay.
      const drag = (0.9 + 0.08 * Math.abs(vehicle.speed)) * dt;
      vehicle.speed -= Math.sign(vehicle.speed) * Math.min(Math.abs(vehicle.speed), drag);
    }
    const speedFactor = Math.min(1, Math.abs(vehicle.speed) / 4);
    const steerYaw =
      controls.steer * 1.35 * speedFactor * dt * (vehicle.speed < 0 ? -1 : 1);
    // Độ lún hiện tại (0 = không chạm gì) — tính 1 lần mỗi tick.
    const current = vehicleBlockInfo(room, vehicle, vehicle.x, vehicle.z, vehicle.yaw);
    if (steerYaw) {
      // KHÔNG cho xe xoay lún vào lan can/tường: trước đây xoay trước, kiểm tra
      // sau → thân xe cắm vào rào, mọi vị trí kế tiếp đều bị chặn → kẹt cứng.
      const turned = vehicleBlockInfo(room, vehicle, vehicle.x, vehicle.z, vehicle.yaw + steerYaw);
      if (turned.count <= current.count) {
        vehicle.yaw += steerYaw;
        current.count = turned.count;
      }
    }
    const distance = vehicle.speed * dt;
    const dx = -Math.sin(vehicle.yaw) * distance;
    const dz = -Math.cos(vehicle.yaw) * distance;
    // Mỗi tick xe đi tối đa ~1.1 m; bước 0.45 m vẫn bắt được chướng ngại vật
    // nhưng giảm gần một nửa số lần quét collider so với bước 0.25 m.
    const steps = Math.max(1, Math.ceil(Math.abs(distance) / 0.45));
    let moved = false;
    for (let i = 0; i < steps; i++) {
      const nx = vehicle.x + dx / steps,
        nz = vehicle.z + dz / steps;
      if (waterAt(room, nx, nz) && !isOnBridge(room.obstacles, nx, nz, 1.2)) {
        vehicle.x = nx;
        vehicle.z = nz;
        vehicle.submerged = true;
        vehicle.speed = 0;
        vehicle.controls = { throttle: 0, steer: 0, brake: false };
        changed = true;
        break;
      }
      const result = moveVehicleStep(room, vehicle, dx / steps, dz / steps, current);
      const stepLen = Math.abs(distance) / steps;
      if (result === "blocked") {
        // Đâm thẳng: dội nhẹ rồi dừng (không nảy qua lại mỗi tick).
        vehicle.speed *= -0.12;
        break;
      }
      // Cạ lan can: mất ~3.3% tốc độ mỗi mét (tính theo quãng đường, khớp client).
      if (result === "slid") vehicle.speed *= 1 - 0.033 * stepLen;
      moved = true;
    }
    vehicle.speed = Math.max(-22, Math.min(22, vehicle.speed));
    vehicle.lastDriverId = driver?.id || vehicle.lastDriverId || null;
    for (const occupant of room.players.values()) {
      if (occupant.vehicleId !== vehicle.id) continue;
      const seat = vehicleSeatPosition(vehicle, occupant.vehicleSeat);
      occupant.x = seat.x;
      occupant.z = seat.z;
      occupant.yaw = vehicle.yaw;
      occupant.groundY = groundHeightAt(room, vehicle.x, vehicle.z);
    }
    if (moved && Math.abs(vehicle.speed) > 0.05) {
      for (const victim of room.players.values()) {
        if (!victim.alive || victim.vehicleId || victim.state !== "ground")
          continue;
        const dx = victim.x - vehicle.x,
          dz = victim.z - vehicle.z;
        const c = Math.cos(vehicle.yaw),
          s = Math.sin(vehicle.yaw);
        const lx = c * dx - s * dz,
          lz = s * dx + c * dz;
        const touching = Math.abs(lx) < 1.42 && Math.abs(lz) < 2.22;
        victim.vehicleContacts ||= new Set();
        if (!touching) {
          victim.vehicleContacts.delete(vehicle.id);
          continue;
        }
        // Chỉ tính một lần cho mỗi lần va chạm; giữ chạm liên tục không gây
        // sát thương 30 HP lặp lại mỗi tick mạng.
        if (victim.vehicleContacts.has(vehicle.id)) continue;
        victim.vehicleContacts.add(vehicle.id);
        if (Math.abs(vehicle.speed) >= 12) {
          killByVehicle(room, victim, vehicle, now, "collision");
        } else {
          victim.hp = Math.max(0, victim.hp - 30);
          if (victim.hp <= 0)
            killByVehicle(room, victim, vehicle, now, "collision");
          else {
            send(victim.ws, { type: "toast", text: "VA CHẠM XE · -30 HP" });
            changed = true;
          }
        }
      }
    }
    changed ||= moved || Math.abs(oldSpeed - vehicle.speed) > 0.2;
  }
  if (changed) broadcast(room);
}
// ---------------------------------------------------------------------------
// LỰU ĐẠN: server mô phỏng quỹ đạo (trọng lực, nảy trên đất / mái / sàn, dội
// tường) và nổ đúng giờ. Kíp nổ tính từ lúc rút chốt (R, cook) nếu có, không
// thì từ lúc ném. Giữ quá giờ trên tay thì nổ ngay tại người ném.
// ---------------------------------------------------------------------------
let nextGrenadeId = 1;
function spawnGrenade(room, owner, kind, pos, vel, fuseStart) {
  room.grenades ||= [];
  room.grenades.push({
    id: nextGrenadeId++,
    kind,
    ownerId: owner.id,
    ownerName: owner.name,
    x: pos.x,
    y: pos.y,
    z: pos.z,
    vx: vel.x,
    vy: vel.y,
    vz: vel.z,
    explodeAt: fuseStart + GRENADE[kind].fuse,
    lastAt: Date.now(),
  });
}
// Điểm (x, y, z) có nằm TRONG vật rắn không — tính cả độ cao: cửa sổ, cửa ra
// vào, khoảng trống giữa cột nhà sàn đều để lọt; tường, đá, cây, sàn thì chặn.
function solidPoint(room, x, y, z, skipGround = false) {
  if (!skipGround && groundHeightAt(room, x, z) > y + 0.05) return true;
  for (const o of nearObstacles(room.obstacles, x, z)) {
    if (o.solid === false) continue;
    const base = obstacleBaseY(room, o);
    if (y < base - 0.5) continue;
    if (o.type === "house" || o.type === "hut") {
      const [lx, lz] = Structures.toLocal(o, x, z);
      const half = o.w / 2;
      if (Math.abs(lx) > half + 0.05 || Math.abs(lz) > half + 0.05) continue;
      if (o.lift) {
        const ry = y - base;
        if (ry < o.lift + 0.1) {
          for (const b of Structures.stiltBulletBoxes(o))
            if (Math.abs(lx - b.x) < b.hx && Math.abs(ry - b.y) < b.hy && Math.abs(lz - b.z) < b.hz) return true;
          continue;
        }
      }
      const floor = base + (o.lift || 0);
      const wallH = o.h * 0.72;
      const ry = y - floor;
      if (ry < 0 || ry > wallH) continue;
      const side = Math.abs(lx) >= half - 0.2,
        end = Math.abs(lz) >= half - 0.2;
      if (!side && !end) continue; // trong phòng: không khí
      if (side && Math.abs(lz) < 0.72 && ry > wallH * 0.34 && ry < wallH * 0.73) continue; // cửa sổ
      if (end && lz < 0 && Math.abs(lx) < 1.05 && ry < Math.min(2.25, wallH * 0.78)) continue; // cửa ra vào
      return true;
    }
    if (o.type === "keep") {
      const [lx, lz] = Structures.toLocal(o, x, z);
      const ry = y - base;
      for (const b of Structures.keepParts(o))
        if (b.kind !== "floor" && Math.abs(lx - b.x) < b.hx && Math.abs(ry - b.y) < b.hy && Math.abs(lz - b.z) < b.hz) return true;
      if (Structures.keepRampSolid(lx, ry, lz)) return true; // khối cầu thang đặc
      continue;
    }
    if (o.type === "fence" || o.type === "stonewall") {
      if (y < base + o.h && blockedByFence(o, x, z, 0)) return true;
      continue;
    }
    if (o.type === "tower") {
      if (y < base + o.h && Math.abs(x - o.x) < o.w / 2 && Math.abs(z - o.z) < o.w / 2) return true;
      continue;
    }
    if (o.type === "fortramp") {
      const [lx, lz] = Structures.toLocal(o, x, z);
      if (Structures.fortRampSolid(o, lx, y - base, lz, (gx, gz) => groundHeightAt(room, gx, gz))) return true;
      continue;
    }
    const d = Math.hypot(x - o.x, z - o.z);
    if (o.type === "tree") {
      if (d < o.w * 0.25 && y < base + o.h * 0.62) return true;
    } else if (o.type === "deadTree") {
      if (d < o.w * 0.28 && y < base + o.h) return true;
    } else if (o.type === "cactus") {
      if (d < o.w * 0.48 && y < base + o.h) return true;
    } else if (o.type === "banana" || o.type === "palm") {
      if (d < o.w * (o.type === "palm" ? 0.2 : 0.14) && y < base + o.h * 0.6) return true;
    } else if (o.type === "rock") {
      const r = o.w * 0.46;
      if (d < r && y < base + o.h * (0.42 + 0.5 * Math.sqrt(Math.max(0, 1 - (d / r) ** 2)))) return true;
    }
  }
  return false;
}
// Đoạn thẳng a → b có bị vật rắn chắn không (bước 0.1 m: tường chỉ dày ~0.2 m).
function blastBlocked(room, a, b) {
  const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const n = Math.ceil(len / 0.1);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (solidPoint(room, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t)) return true;
  }
  return false;
}
// Tỉ lệ thân người LỘ ra trước tâm nổ (đầu, ngực, chân): che kín hết = 0.
function exposure(room, blast, q) {
  const base = q.swimming ? q.swimY || 0 : q.groundY || 0;
  const heights = q.prone ? [0.35, 0.3, 0.25] : q.crouching ? [1.25, 0.8, 0.35] : [1.6, 1.1, 0.4];
  let open = 0;
  for (const h of heights) if (!blastBlocked(room, blast, { x: q.x, y: base + h, z: q.z })) open++;
  return open / heights.length;
}
function damageVehicleBy(vehicle, hits) {
  if (vehicle.destroyed || hits <= 0) return;
  vehicle.hits = (vehicle.hits || 0) + hits;
  vehicle.hp = Math.max(0, 60 - vehicle.hits);
  vehicle.smoke = vehicle.hits >= 50 ? 2 : vehicle.hits >= 30 ? 1 : 0;
  if (vehicle.hits >= 60) {
    vehicle.destroyed = true;
    vehicle.speed = 0;
    vehicle.blastPending = true;
    vehicle.controls = { throttle: 0, steer: 0, brake: false };
  }
}
function killByBlast(room, victim, g, distance) {
  if (!victim.alive) return;
  victim.hp = 0;
  victim.alive = false;
  detachFromVehicle(room, victim);
  victim.placement = [...room.players.values()].filter((pl) => pl.alive).length + 1;
  const killer = g.ownerId !== victim.id ? room.players.get(g.ownerId) : null;
  if (killer) killer.kills++;
  room.eliminationSequence = (room.eliminationSequence || 0) + 1;
  room.lastElimination = {
    id: room.eliminationSequence,
    victimId: victim.id,
    victimName: victim.name,
    killerId: killer?.id || null,
    killerName: killer?.name || (g.ownerId === victim.id ? "Lựu đạn của chính mình" : g.ownerName || "Lựu đạn"),
    weapon: GRENADE[g.kind].name,
    headshot: false,
    distance: Math.round(distance),
  };
  dropDeathLoot(room, victim);
  const alive = [...room.players.values()].filter((pl) => pl.alive);
  if (alive.length <= 1 && !room.finishAt) {
    room.finishAt = Date.now() + MATCH_END_DELAY_MS;
    if (alive[0]) send(alive[0].ws, { type: "toast", text: "CHIẾN THẮNG! TIẾNG NỔ CUỐI CÙNG ĐÃ DỨT" });
  }
}
function explodeGrenade(room, g) {
  const blast = { x: g.x, y: g.y + 0.25, z: g.z };
  if (g.kind === "flash") {
    // Chỉ ai có đường nhìn tới quả choáng (không bị tường / đá / cây che mắt)
    // mới bị loá; client tự tính thêm độ mạnh theo khoảng cách + hướng nhìn.
    const seen = [];
    for (const q of room.players.values()) {
      if (!q.alive || Math.hypot(q.x - g.x, q.z - g.z) > 22) continue;
      const eye = { x: q.x, y: (q.swimming ? q.swimY || 0 : q.groundY || 0) + (q.prone ? 0.45 : q.crouching ? 1.34 : 1.8), z: q.z };
      if (!blastBlocked(room, blast, eye)) seen.push(q.id);
    }
    broadcastRaw(room, { type: "explosion", kind: g.kind, x: r2(g.x), y: r2(g.y), z: r2(g.z), ownerId: g.ownerId, seen });
    return;
  }
  broadcastRaw(room, { type: "explosion", kind: g.kind, x: r2(g.x), y: r2(g.y), z: r2(g.z), ownerId: g.ownerId });
  const spec = GRENADE.frag;
  for (const q of room.players.values()) {
    if (!q.alive || !["ground", "parachute", "freefall"].includes(q.state)) continue;
    const chest = { x: q.x, y: (q.swimming ? q.swimY || 0 : q.groundY || 0) + (q.prone ? 0.35 : q.crouching ? 0.8 : 1.1), z: q.z };
    const d = Math.hypot(chest.x - blast.x, chest.y - blast.y, chest.z - blast.z);
    if (d >= spec.reach) continue;
    // Núp KÍN người sau tường / đá / sườn đồi: không mất máu. Lộ một phần
    // (đầu / ngực / chân) thì chịu đúng phần đó.
    const open = exposure(room, blast, q);
    if (open <= 0) continue;
    let dmg = d <= spec.kill ? 100 : 95 * Math.pow(1 - (d - spec.kill) / (spec.reach - spec.kill), 1.4) + 5;
    if (open < 1) dmg *= open;
    dmg = Math.round(dmg);
    if (dmg <= 0) continue;
    q.hp = Math.max(0, q.hp - dmg);
    room.hitSequence = (room.hitSequence || 0) + 1;
    room.lastHit = { id: room.hitSequence, targetId: q.id, shooterId: g.ownerId, point: blast };
    if (q.hp <= 0) killByBlast(room, q, g, d);
    else if (q.ws) send(q.ws, { type: "toast", text: `TRÚNG MẢNH LỰU ĐẠN · -${dmg} HP` });
  }
  for (const v of room.vehicles || []) {
    const d = Math.hypot(v.x - blast.x, v.z - blast.z);
    if (d < 6) damageVehicleBy(v, Math.round(45 * (1 - d / 6)));
  }
}
function grenadeHits(room, g, nx, nz) {
  if (nx < -MAP_HALF + 1 || nx > MAP_HALF - 1 || nz < -MAP_HALF + 1 || nz > MAP_HALF - 1) return true;
  // Kiểm cả điểm giữa bước để không xuyên tường mỏng khi bay nhanh.
  for (const t of [0.5, 1]) {
    const x = g.x + (nx - g.x) * t,
      z = g.z + (nz - g.z) * t;
    if (solidPoint(room, x, g.y, z, true)) return true;
  }
  for (const v of room.vehicles || []) {
    const dx = nx - v.x,
      dz = nz - v.z;
    const c = Math.cos(v.yaw),
      s = Math.sin(v.yaw);
    if (Math.abs(c * dx - s * dz) < 1.05 && Math.abs(s * dx + c * dz) < 1.86 && g.y < (v.y ?? groundHeightAt(room, v.x, v.z)) + 1.5) return true;
  }
  return false;
}
function tickGrenades(room, now) {
  let changed = false;
  // Rút chốt quá giờ mà chưa ném: nổ trên tay.
  for (const p of room.players.values()) {
    if (!p.cook || now < p.cook.at + GRENADE[p.cook.kind].fuse) continue;
    const key = throwKey(p.cook.kind);
    p[key] = Math.max(0, (p[key] || 0) - 1);
    const g = { id: nextGrenadeId++, kind: p.cook.kind, ownerId: p.id, ownerName: p.name, x: p.x, y: (p.groundY || 0) + 1.1, z: p.z };
    p.cook = null;
    explodeGrenade(room, g);
    changed = true;
  }
  if (!room.grenades?.length) return changed;
  const remaining = [];
  for (const g of room.grenades) {
    const dt = Math.min(0.2, Math.max(0, (now - g.lastAt) / 1000));
    g.lastAt = now;
    const sub = Math.max(1, Math.ceil(dt / 0.01));
    const h = dt / sub;
    for (let i = 0; i < sub; i++) {
      g.vy -= 20 * h;
      const nx = g.x + g.vx * h,
        nz = g.z + g.vz * h;
      // Dội tường / đá / cây / xe theo 3D: bay QUA được cửa sổ, cửa ra vào,
      // trên đầu lan can pháo đài, trên nóc nhà; chỉ chạm vật rắn thật mới nảy lại.
      if (grenadeHits(room, g, nx, nz)) {
        g.vx *= -0.35;
        g.vz *= -0.35;
      } else {
        g.x = nx;
        g.z = nz;
      }
      g.y += g.vy * h;
      const floor = landingHeightAt(room, g.x, g.z, g.y + 0.3) + 0.08;
      if (g.y <= floor) {
        g.y = floor;
        if (g.vy < -1.5) {
          // Va đập: nảy lên, mất bớt tốc độ ngang.
          g.vy = -g.vy * 0.32;
          g.vx *= 0.7;
          g.vz *= 0.7;
        } else {
          // Đang LĂN: ma sát lăn + lăn xuống theo độ dốc mặt đất.
          g.vy = 0;
          const e = 0.35;
          const gx = (landingHeightAt(room, g.x + e, g.z, g.y + 0.3) - landingHeightAt(room, g.x - e, g.z, g.y + 0.3)) / (2 * e);
          const gz = (landingHeightAt(room, g.x, g.z + e, g.y + 0.3) - landingHeightAt(room, g.x, g.z - e, g.y + 0.3)) / (2 * e);
          g.vx -= 11 * gx * h;
          g.vz -= 11 * gz * h;
          const fr = Math.max(0, 1 - 1.0 * h);
          g.vx *= fr;
          g.vz *= fr;
          if (Math.hypot(g.vx, g.vz) < 0.08 && Math.hypot(gx, gz) < 0.12) g.vx = g.vz = 0;
        }
      }
    }
    changed = true;
    if (now >= g.explodeAt) explodeGrenade(room, g);
    else remaining.push(g);
  }
  room.grenades = remaining;
  return changed;
}
function tickRoom(room) {
  const now = Date.now();
  if (room.phase === "playing" || room.phase === "plane")
    tickVehicles(room, now);
  if (room.phase === "playing" && tickGrenades(room, now)) broadcast(room);
  const players = [...room.players.values()];
  /* Weather start/end polling disabled for performance testing.
  const w = room.weather;
  if (w && room.phase !== "waiting" && room.phase !== "finished") {
    if (!w.active && now >= w.startAt && now < w.endAt) {
      w.active = true;
      broadcast(room);
    } else if (w.active && now >= w.endAt) {
      w.active = false;
      broadcast(room);
    }
  }
  */
  // Vòng bo chỉ bắt đầu tính giờ khi MÁY BAY BAY HẾT MAP (tExit), không phải
  // lúc người cuối cùng nhảy: cả phòng nhảy sớm thì bo vẫn chờ máy bay rời map.
  if (
    (room.phase === "plane" || room.phase === "playing") &&
    !room.zone &&
    room.plane &&
    (now - room.plane.startedAt) / 1000 >= room.plane.tExit
  ) {
    initZone(room);
    broadcast(room);
  }
  if (room.phase === "plane" || room.phase === "playing") tickZone(room, now);
  if (room.phase === "plane" || room.phase === "playing")
    recordPositionHistory(room, now);
  if (room.phase === "staging") {
    if (
      players.every((p) => p.ready) ||
      now - room.stagingStartedAt > STAGING_TIMEOUT_MS
    ) {
      room.phase = "countdown";
      room.countdownEndsAt = now + COUNTDOWN_MS;
      broadcast(room);
    }
    return;
  }
  if (room.phase === "countdown") {
    if (now >= room.countdownEndsAt) startPlane(room);
    return;
  }
  if (room.phase === "plane") {
    const t = (now - room.plane.startedAt) / 1000;
    let changed = false;
    // Ai chưa nhảy khi máy bay ra khỏi zone thì bị đẩy ra khỏi máy bay.
    if (t >= room.plane.tExit) {
      for (const p of players) {
        if (p.state === "plane") {
          jumpPlayer(room, p);
          changed = true;
        }
      }
    }
    if (players.every((p) => p.state !== "plane")) {
      room.phase = "playing"; // vòng bo khởi tạo riêng khi máy bay bay hết map (xem trên)
      changed = true;
    }
    if (changed) broadcast(room);
    return;
  }
  // Người sống sót cuối cùng vẫn "playing" thêm MATCH_END_DELAY_MS để có thời
  // gian nhặt hòm tiếp tế của đối thủ vừa bị hạ trước khi trận thật sự kết thúc.
  if (room.phase === "playing" && room.finishAt && now >= room.finishAt) {
    const winner = [...room.players.values()].find((player) => player.alive);
    if (winner) winner.placement = 1;
    room.phase = "finished";
    broadcast(room);
  }
}
wss.on("connection", (ws) => {
  let room;
  const handleMessage = (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    // Đo độ trễ khứ hồi: client dùng để dự đoán xe và hiển thị ping.
    if (m.type === "ping") return send(ws, { type: "pong", t: m.t, lag: serverLagMs });
    if (m.type === "create" || m.type === "join" || m.type === "play") {
      if (room) return;
      // "play" (nút CHƠI): vào phòng CHUNG đang chờ còn chỗ — không cần mã phòng;
      // chưa có (hoặc phòng chung đang đánh / đã đủ người) thì mở phòng chung mới.
      let code = m.type === "create" ? roomCode() : String(m.code || "");
      if (m.type === "play") {
        const open = [...rooms.values()].find((r) => r.isPublic && r.phase === "waiting" && r.players.size < 5);
        code = open ? open.code : roomCode();
      }
      room = rooms.get(code);
      if (m.type === "join" && !room)
        return send(ws, { type: "error", message: "Không tìm thấy phòng." });
      if (!room) {
        const mapId = ["desert", "jungle"].includes(m.mapId) ? m.mapId : "forest";
        const { mapSeed, obstacles, terrain } = takeMap(mapId);
        room = {
          code,
          phase: "waiting",
          players: new Map(),
          mapSeed,
          mapId,
          obstacles,
          terrain,
          vehicles: createVehicles(obstacles),
          hills: obstacles.filter((obstacle) => obstacle.type === "hill"),
          crates: [],
          nextCrateId: 1,
          nextLootId: 1,
        };
        if (m.type === "play") room.isPublic = true;
        rooms.set(code, room);
        // Vòng lặp gửi state phải chạy NGAY từ lúc tạo phòng — không đợi tới
        // lúc bấm Start — nếu không thì mọi broadcast() lúc đang chờ trong
        // sảnh (có người vào/ra) chỉ đánh dấu "dirty" mà không ai thực sự gửi
        // đi, khiến chủ phòng và người mới vào bị lệch danh sách người chơi.
        room.timer = setInterval(() => {
          try {
            tickRoom(room);
          } catch (error) {
            console.error("tick error:", error);
          }
          flushRoomState(room);
        }, 50);
      }
      if (room.phase !== "waiting" || room.players.size >= 5)
        return send(ws, {
          type: "error",
          message: "Phòng đã bắt đầu hoặc đã đủ 5 người.",
        });
      const id = Math.random().toString(36).slice(2, 10);
      const player = {
        id,
        ws,
        name: String(m.name || "Player").slice(0, 18),
        skin: /^[a-z]{2,12}$/.test(String(m.skin || "")) ? String(m.skin) : "green", // màu nhân vật
        x: ((room.players.size % 3) - 1) * 3,
        z: room.players.size > 2 ? -8 : 8,
        groundY: 0,
        state: "lobby",
        seat: 0,
        y: null,
        ready: false,
        swimming: false,
        swimY: null,
        yaw: 0,
        peek: 0,
        hp: 100,
        kills: 0,
        placement: 0,
        alive: true,
        crouching: false,
        prone: false,
        slowWalking: false,
        vehicleId: null,
        vehicleSeat: -1,
        jumpY: 0,
        lastMoveAt: Date.now(),
        ammo: 0,
        weapon: "none", // tiếp đất tay không, phải tự tìm súng
        reserveAmmo: 0, // balo rỗng: đạn phải tự nhặt trong nhà
        medkits: 0,
        healingUntil: 0,
        reloadingUntil: 0,
        lastShotAt: 0,
        shotId: 0,
      };
      room.players.set(id, player);
      ws.player = player;
      ws.room = room;
      send(ws, {
        type: "joined",
        code,
        playerId: id,
        isHost: room.players.size === 1,
        spawn: { x: player.x, z: player.z },
        mapId: room.mapId,
        obstacles: room.obstacles,
      });
      broadcast(room);
      flushRoomState(room);
      return;
    }
    if (!room || !ws.player) return;
    const p = ws.player;
    if (
      m.type === "start" &&
      room.players.size > 0 &&
      [...room.players.values()][0] === p &&
      room.phase === "waiting"
    ) {
      // Cả phòng vào map chờ (tay không, không có vật phẩm). Loot chỉ sinh ra khi lên máy bay.
      room.phase = "staging";
      room.matchTotal = room.players.size;
      room.lastHit = null;
      room.lastElimination = null;
      room.eliminationSequence = 0;
      room.loot = [];
      room.crates = [];
      room.stagingStartedAt = Date.now();
      /* Weather scheduling disabled for performance testing.
      const weatherStartAt =
        room.stagingStartedAt + randomBetween(WEATHER_START_DELAY_MS);
      room.weather = {
        startAt: weatherStartAt,
        endAt: weatherStartAt + randomBetween(WEATHER_DURATION_MS),
        active: false,
      };
      */
      for (const q of room.players.values()) {
        q.state = "lobby";
        q.ready = false;
        q.placement = 0;
      }
      broadcast(room);
      flushRoomState(room);
      return;
    }
    // Client báo đã dựng xong map trong phòng chờ.
    if (m.type === "ready" && room.phase === "staging") {
      p.ready = true;
      return;
    }
    // Nhảy khỏi máy bay (chỉ khi máy bay đã vào zone của map).
    if (m.type === "jump" && room.phase === "plane" && p.state === "plane") {
      const t = (Date.now() - room.plane.startedAt) / 1000;
      if (t < room.plane.tEnter - 0.25)
        return send(ws, { type: "toast", text: "CHƯA TỚI VÙNG NHẢY" });
      jumpPlayer(room, p);
      broadcast(room);
      return;
    }
    // Bung dù.
    if (
      m.type === "chute" &&
      (room.phase === "plane" || room.phase === "playing") &&
      p.state === "freefall"
    ) {
      p.state = "parachute";
      broadcast(room);
      return;
    }
    // Vị trí khi đang bay trên không (client mô phỏng, server chặn tốc độ bất thường).
    if (
      m.type === "air" &&
      (room.phase === "plane" || room.phase === "playing") &&
      (p.state === "freefall" || p.state === "parachute")
    ) {
      const now = Date.now();
      const elapsed = Math.max(
        0.01,
        Math.min(0.25, (now - (p.lastAirAt || now)) / 1000),
      );
      p.lastAirAt = now;
      const cap = p.state === "parachute" ? AIR.chuteHoriz : AIR.freefallHoriz;
      let dx = Number(m.x) - p.x;
      let dz = Number(m.z) - p.z;
      if (!Number.isFinite(dx)) dx = 0;
      if (!Number.isFinite(dz)) dz = 0;
      const maxStep = cap * 1.5 * elapsed + 0.5;
      const dist = Math.hypot(dx, dz);
      if (dist > maxStep) {
        dx *= maxStep / dist;
        dz *= maxStep / dist;
      }
      p.x = clampToMap(p.x + dx);
      p.z = clampToMap(p.z + dz);
      let ny = Number(m.y);
      if (!Number.isFinite(ny)) ny = p.y;
      // Chỉ rơi xuống, và không nhanh hơn giới hạn.
      p.y = Math.max(p.y - AIR.maxFall * elapsed - 1, Math.min(p.y, ny));
      p.yaw = Number(m.yaw) || 0;
      p.peek = 0;
      broadcast(room);
      return;
    }
    // Tiếp đất: từ giờ mới được cầm súng.
    if (
      m.type === "land" &&
      (room.phase === "plane" || room.phase === "playing") &&
      (p.state === "freefall" || p.state === "parachute")
    ) {
      // Độ cao server ghi nhận có thể trễ hơn client (giới hạn tốc độ rơi): vẫn cho
      // tiếp đất, chỉ chặn trường hợp vô lý (còn quá cao).
      if (p.y - groundHeightAt(room, p.x, p.z) > AIR.maxLandingHeight * 4) return;
      const reportedLandingY = Number(m.y);
      const landingY =
        Number.isFinite(reportedLandingY) &&
        Math.abs(reportedLandingY - p.y) <= 5
          ? reportedLandingY
          : p.y;
      let lx = Number(m.x);
      let lz = Number(m.z);
      if (
        !Number.isFinite(lx) ||
        !Number.isFinite(lz) ||
        Math.hypot(lx - p.x, lz - p.z) > 4
      ) {
        lx = p.x;
        lz = p.z;
      }
      const spot = findFreeSpot(
        room,
        Math.max(-MAP_HALF + 1.5, Math.min(MAP_HALF - 1.5, lx)),
        Math.max(-MAP_HALF + 1.5, Math.min(MAP_HALF - 1.5, lz)),
        p.id,
        landingY,
      );
      p.x = spot.x;
      p.z = spot.z;
      p.groundY = landingHeightAt(room, p.x, p.z, landingY);
      p.y = null;
      p.state = "ground";
      p.peek = 0;
      p.jumpY = 0;
      p.swimming = false;
      p.swimY = null;
      p.lastMoveAt = Date.now();
      send(ws, { type: "landed", x: p.x, z: p.z, groundY: p.groundY });
      broadcast(room);
      return;
    }
    if (m.type === "vehicleInteract" && canFight(room, p)) {
      if (p.vehicleId) {
        const vehicle = room.vehicles.find((v) => v.id === p.vehicleId);
        if (!vehicle) {
          p.vehicleId = null;
          p.vehicleSeat = -1;
          return;
        }
        const exitedSeat = p.vehicleSeat;
        const speed = Math.abs(vehicle.speed);
        const side = p.vehicleSeat === 0 ? -1 : 1;
        // Thử cửa bên mình → cửa bên kia → đầu xe → đuôi xe → chỗ trống gần
        // nhất. Trước đây chỉ thử cửa bên mình: xe cạ sát lan can cầu thì
        // "KHÔNG ĐỦ CHỖ ĐỂ RA XE" mãi mãi — xe kẹt, người cũng kẹt.
        const c = Math.cos(vehicle.yaw),
          s = Math.sin(vehicle.yaw);
        const exits = [
          [side * 1.65, 0],
          [-side * 1.65, 0],
          [0, -2.6],
          [0, 2.6],
        ].map(([lx, lz]) => ({ x: vehicle.x + c * lx + s * lz, z: vehicle.z - s * lx + c * lz }));
        let exit = exits.find((e) => !blockedPosition(room, e.x, e.z, p.id, vehicle.id));
        if (!exit) {
          const spot = findFreeSpot(room, exits[0].x, exits[0].z, p.id);
          if (!blockedPosition(room, spot.x, spot.z, p.id)) exit = spot;
        }
        if (!exit) return send(ws, { type: "toast", text: "KHÔNG ĐỦ CHỖ ĐỂ RA XE" });
        const exitX = exit.x,
          exitZ = exit.z;
        p.vehicleId = null;
        p.vehicleSeat = -1;
        p.x = exitX;
        p.z = exitZ;
        p.yaw = vehicle.yaw;
        p.groundY = groundHeightAt(room, exitX, exitZ);
        if (exitedSeat === 0)
          vehicle.controls = { throttle: 0, steer: 0, brake: false };
        const damage = speed >= 19.5 ? p.hp : Math.max(0, (speed - 9) * 5);
        if (damage > 0) {
          p.hp = Math.max(0, p.hp - damage);
          send(ws, {
            type: "toast",
            text:
              damage >= 100
                ? "BẠN ĐÃ BỊ NGU KHI NHẢY KHỎI XE ĐANG CHẠY QUÁ NHANH"
                : `RA XE KHI ĐANG CHẠY · -${Math.round(damage)} HP`,
          });
          if (p.hp <= 0) killByVehicle(room, p, vehicle, Date.now(), "exit");
        }
        broadcast(room);
        return;
      }
      if (p.state !== "ground" || p.swimming) return;
      if (p.healingUntil > Date.now())
        return send(ws, {
          type: "toast",
          text: "HÃY HỦY HỒI MÁU TRƯỚC KHI VÀO XE",
        });
      const vehicle = (room.vehicles || [])
        .filter(
          (v) =>
            !v.destroyed &&
            !v.submerged &&
            Math.hypot(v.x - p.x, v.z - p.z) <= 3.2,
        )
        .sort(
          (a, b) =>
            Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z),
        )[0];
      if (!vehicle) return;
      const seat = [...room.players.values()].some(
        (other) => other.vehicleId === vehicle.id && other.vehicleSeat === 0,
      )
        ? 1
        : 0;
      if (
        [...room.players.values()].some(
          (other) =>
            other.vehicleId === vehicle.id && other.vehicleSeat === seat,
        )
      )
        return send(ws, { type: "toast", text: "XE ĐÃ ĐỦ 2 NGƯỜI" });
      p.vehicleId = vehicle.id;
      p.vehicleSeat = seat;
      p.crouching = false;
      p.sprinting = false;
      p.prone = false;
      p.jumping = false;
      p.swimming = false;
      p.reloadingUntil = 0;
      const seatPos = vehicleSeatPosition(vehicle, seat);
      p.x = seatPos.x;
      p.z = seatPos.z;
      p.yaw = vehicle.yaw;
      p.groundY = groundHeightAt(room, vehicle.x, vehicle.z);
      vehicle.controls = { throttle: 0, steer: 0, brake: false };
      broadcast(room);
      return;
    }
    if (
      m.type === "vehicleControl" &&
      p.vehicleId &&
      p.vehicleSeat === 0 &&
      canFight(room, p)
    ) {
      const vehicle = room.vehicles.find((v) => v.id === p.vehicleId);
      if (!vehicle || vehicle.destroyed || vehicle.submerged) return;
      vehicle.controls = {
        throttle: Math.max(-1, Math.min(1, Number(m.throttle) || 0)),
        steer: Math.max(-1, Math.min(1, Number(m.steer) || 0)),
        brake: Boolean(m.brake),
      };
      vehicle.lastDriverId = p.id;
      return;
    }
    if (
      m.type === "horn" &&
      p.vehicleId &&
      p.vehicleSeat === 0 &&
      canFight(room, p)
    ) {
      const vehicle = room.vehicles.find(
        (v) => v.id === p.vehicleId && !v.destroyed,
      );
      if (!vehicle) return;
      broadcastRaw(room, {
        type: "horn",
        senderId: p.id,
        x: vehicle.x,
        y: groundHeightAt(room, vehicle.x, vehicle.z) + 0.8,
        z: vehicle.z,
      });
      return;
    }
    if (m.type === "move" && canWalk(room, p) && !p.vehicleId) {
      p.crouching = Boolean(m.crouching);
      p.prone = Boolean(m.prone);
      if (p.prone) p.crouching = false;
      p.slowWalking = Boolean(m.slowWalking);
      // Chạy nhanh (Shift): chỉ khi đứng, không đi chậm; hết chạy khi ngồi/nằm.
      p.sprinting = Boolean(m.sprinting) && !p.prone && !p.slowWalking; // ngồi + Shift = đi khom nhanh
      p.jumpY = Math.max(0, Math.min(1.7, Number(m.jumpY) || 0));
      p.jumping = p.jumpY > 0.02;
      p.pitch = Math.max(-1.4, Math.min(1.4, Number(m.pitch) || 0)); // người xem trực tiếp thấy đúng góc nhìn
      p.yaw = Number(m.yaw) || 0;
      p.peek =
        p.state === "ground" && !p.prone && !p.swimming && !p.jumping
          ? Math.max(-1, Math.min(1, Number(m.peek) || 0))
          : 0;
      const now = Date.now();
      const elapsed = Math.max(0, Math.min(0.2, (now - p.lastMoveAt) / 1000));
      p.lastMoveAt = now;
      const inWaterBeforeMove = Boolean(waterAt(room, p.x, p.z));
      const waterBeforeMove = inWaterBeforeMove
        ? waterAt(room, p.x, p.z)
        : null;
      const stayInWaterWhileSubmerged = Boolean(
        waterBeforeMove &&
        p.swimming &&
        p.swimY < waterBeforeMove.surfaceY - 1.73,
      );
      const moveSpeed = inWaterBeforeMove
        ? 3.6
        : p.prone
          ? 1.3
          : p.crouching && p.slowWalking
            ? 2
            : p.crouching
              ? p.sprinting
                ? 5.4 // ngồi + Shift: đi khom nhanh
                : 3.8
              : p.slowWalking
                ? 3.2
                : p.sprinting
                  ? SPRINT_SPEED
                  : 7;
      let dx = Number(m.x) - p.x;
      let dz = Number(m.z) - p.z;
      if (!Number.isFinite(dx)) dx = 0;
      if (!Number.isFinite(dz)) dz = 0;
      const distance = Math.hypot(dx, dz);
      // "Ngân sách" quãng đường tích luỹ theo thời gian thực (tối đa ~0.35 s
      // chạy). Wi-Fi hay dồn gói: 2 gói "move" tới cách nhau vài ms — tính riêng
      // từng gói thì gói sau bị cắt cụt, vị trí server tụt sau client (người
      // khác thấy trễ, núp rồi vẫn trúng đạn). Ngân sách vẫn chặn chạy nhanh bất thường.
      const budgetCap = moveSpeed * 0.35 + 0.15;
      p.moveBudget = Math.min(budgetCap, (p.moveBudget ?? budgetCap) + moveSpeed * elapsed);
      const maxDistance = Math.max(p.moveBudget, moveSpeed * elapsed) + 0.15;
      p.moveBudget = Math.max(0, p.moveBudget - Math.min(distance, maxDistance));
      if (distance > maxDistance && distance > 0) {
        dx *= maxDistance / distance;
        dz *= maxDistance / distance;
      }
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.1));
      const stepX = dx / steps,
        stepZ = dz / steps;
      // Đã lọt vào vùng đệm va chạm (vd. rơi khỏi mép cầu thang xuống sát chân
      // tường): mọi bước đều "chạm" → kẹt cứng. Khi đó chỉ chặn nếu TÂM người
      // chơi lọt vào vật rắn → bước ra được, vẫn không đi xuyên tường.
      const stuck = blockedPosition(room, p.x, p.z, p.id);
      const blockedStep = (x, z) => blockedPosition(room, x, z, p.id, null, false, stuck ? 0.05 : null);
      const waterOk = (x, z) =>
        !stayInWaterWhileSubmerged || waterAt(room, x, z) || isOnBridge(room.obstacles, x, z, 0.8);
      for (let i = 0; i < steps; i++) {
        // Bước CHÉO đầy đủ trước (đi sát lan can / tường nằm xéo: tách trục X, Z
        // thì cả hai đều chạm nhưng bước chéo vẫn đi được → trước đây kẹt cứng
        // và lệch với client). Bị chặn thì thử lệch hướng nhẹ (trượt quanh đá /
        // gốc cây như client), cuối cùng mới tách trục.
        if (!blockedStep(p.x + stepX, p.z + stepZ) && waterOk(p.x + stepX, p.z + stepZ)) {
          p.x += stepX;
          p.z += stepZ;
          continue;
        }
        let slid = false;
        for (const ang of [0.35, -0.35, 0.7, -0.7, 1.05, -1.05]) {
          const c = Math.cos(ang),
            sn = Math.sin(ang);
          const tx = (stepX * c - stepZ * sn) * c,
            tz = (stepX * sn + stepZ * c) * c;
          if (!blockedStep(p.x + tx, p.z + tz) && waterOk(p.x + tx, p.z + tz)) {
            p.x += tx;
            p.z += tz;
            slid = true;
            break;
          }
        }
        if (slid) continue;
        const nextX = p.x + stepX;
        if (
          !blockedStep(nextX, p.z) &&
          (!stayInWaterWhileSubmerged ||
            waterAt(room, nextX, p.z) ||
            isOnBridge(room.obstacles, nextX, p.z, 0.8))
        )
          p.x = nextX;
        const nextZ = p.z + stepZ;
        if (
          !blockedStep(p.x, nextZ) &&
          (!stayInWaterWhileSubmerged ||
            waterAt(room, p.x, nextZ) ||
            isOnBridge(room.obstacles, p.x, nextZ, 0.8))
        )
          p.z = nextZ;
      }
      p.groundY = standingHeightAt(room, p.x, p.z, p.groundY);
      const water = waterAt(room, p.x, p.z);
      if (water) {
        p.swimming = true;
        p.prone = false;
        p.crouching = false;
        p.jumpY = 0;
        const maxDive = Math.max(0, water.depth - 1.8);
        const minSwimY = water.surfaceY - water.depth + 0.2;
        const maxSwimY = water.surfaceY - 1.58;
        const requestedSwimY = Number(m.swimY);
        p.swimY = Number.isFinite(requestedSwimY)
          ? Math.max(minSwimY, Math.min(maxSwimY, requestedSwimY))
          : maxSwimY;
        p.swimY = Math.max(water.surfaceY - 1.58 - maxDive, p.swimY);
      } else {
        p.swimming = false;
        p.swimY = null;
      }
      if (p.swimming || p.jumping) p.peek = 0;
      broadcast(room);
      return;
    }
    if (m.type === "pickup" && canFight(room, p)) {
      // The client sends the item targeted by the crosshair; validate that exact item here.
      if (p.healingUntil > Date.now() || p.swimming) return;
      const best = (room.loot || []).find((item) => item.id === m.itemId);
      if (!best || Math.hypot(best.x - p.x, best.z - p.z) > PICKUP_RADIUS)
        return;
      if (Number.isFinite(best.y) && Math.abs((p.groundY || 0) - best.y) > 1.6) return; // khác tầng
      // Keep the active magazine size stable for the duration of a reload.
      if (best.type === "weapon" && p.reloadingUntil > Date.now())
        return send(ws, {
          type: "toast",
          text: "CHỜ NẠP ĐẠN XONG ĐỂ ĐỔI SÚNG",
        });
      if (best.type === "ammo") {
        const space = MAX_RESERVE_AMMO - p.reserveAmmo;
        if (space <= 0)
          return send(ws, {
            type: "toast",
            text: `BALO ĐẦY ĐẠN (${p.reserveAmmo}/${MAX_RESERVE_AMMO})`,
          });
        // Balo chỉ đủ chỗ một phần: lấy phần vừa, phần còn lại nằm lại trên đất.
        const taken = Math.min(best.amount, space);
        p.reserveAmmo += taken;
        best.amount -= taken;
        if (best.amount > 0)
          broadcastRaw(room, {
            type: "lootUpdate",
            id: best.id,
            amount: best.amount,
          });
        else {
          room.loot = room.loot.filter((item) => item !== best);
          broadcastRaw(room, { type: "lootRemoved", id: best.id });
        }
        lootSfx(room, p, "pickup-ammo", best.x, best.z);
        send(ws, {
          type: "toast",
          text:
            `+${taken} ĐẠN 5.56` +
            (p.reserveAmmo >= MAX_RESERVE_AMMO ? " · BALO ĐẦY ĐẠN" : ""),
        });
      } else if (best.type === "weapon") {
        const oldWeapon = p.weapon || "none";
        // Đang tay không thì chỉ nhặt, không có gì để thả.
        const dropped =
          oldWeapon === "none"
            ? null
            : {
                id: room.nextLootId++,
                type: "weapon",
                weapon: oldWeapon,
                x: Math.round(p.x * 100) / 100,
                z: Math.round(p.z * 100) / 100,
                yaw: Math.round(Math.random() * 628) / 100,
                amount: 1,
                ammo: p.ammo,
              };
        if (dropped) room.loot.push(dropped);
        stripGunAttachments(room, p);
        p.weapon =
          WEAPON_STATS[best.weapon] && best.weapon !== "none" ? best.weapon : "ranger";
        autoAttachFromPack(p);
        const storedMagazineAmmo = Number(best.ammo);
        p.ammo = Math.max(
          0,
          Math.min(
            magazineSize(p),
            Number.isFinite(storedMagazineAmmo)
              ? storedMagazineAmmo
              : magazineSize(p),
          ),
        );
        room.loot = room.loot.filter((item) => item !== best);
        broadcastRaw(room, { type: "lootRemoved", id: best.id });
        if (dropped) {
          broadcastRaw(room, { type: "lootAdded", item: dropped });
          lootSfx(room, p, "drop-" + dropped.weapon);
        }
        lootSfx(room, p, "pickup-" + p.weapon, best.x, best.z);
        send(ws, {
          type: "toast",
          text: `${dropped ? "ĐÃ ĐỔI SANG" : "ĐÃ NHẶT"} ${weaponStats(p).name}`,
        });
      } else if (best.type === "attach") {
        const id = best.att;
        const A = Attach.ATTACH[id];
        if (!A) return;
        let text;
        if (p.weapon && Attach.fits(id, p.weapon)) {
          // Có súng hợp: gắn luôn; đang có món cùng ô thì món cũ rơi xuống đất.
          if (p.reloadingUntil > Date.now() && A.slot === "mag")
            return send(ws, { type: "toast", text: "CHỜ NẠP ĐẠN XONG" });
          p.att ||= {};
          const old = p.att[A.slot];
          p.att[A.slot] = id;
          if (old) dropAttLoot(room, p, old);
          clampMagazine(p);
          text = `ĐÃ GẮN ${A.name}${old ? " · ĐÃ BỎ " + Attach.ATTACH[old].short : ""}`;
        } else {
          p.packAtt ||= [];
          if (p.packAtt.length >= Attach.PACK_MAX)
            return send(ws, { type: "toast", text: `BALO ĐẦY PHỤ KIỆN (${Attach.PACK_MAX})` });
          p.packAtt.push(id);
          text = `+ ${A.name} · VÀO BALO`;
        }
        room.loot = room.loot.filter((item) => item !== best);
        broadcastRaw(room, { type: "lootRemoved", id: best.id });
        lootSfx(room, p, "pickup-attach", best.x, best.z);
        send(ws, { type: "toast", text });
      } else if (best.type === "frag" || best.type === "flash") {
        const key = throwKey(best.type);
        const name = GRENADE[best.type].name;
        if ((p[key] || 0) >= MAX_THROWABLES)
          return send(ws, { type: "toast", text: `BALO ĐẦY ${name} (${p[key]}/${MAX_THROWABLES})` });
        p[key] = (p[key] || 0) + 1;
        room.loot = room.loot.filter((item) => item !== best);
        broadcastRaw(room, { type: "lootRemoved", id: best.id });
        lootSfx(room, p, "pickup-grenade", best.x, best.z);
        send(ws, { type: "toast", text: `+1 ${name} (${p[key]}/${MAX_THROWABLES})` });
      } else {
        if ((p.medkits || 0) >= MAX_MEDKITS) {
          return send(ws, {
            type: "toast",
            text: `BALO ĐẦY BỊCH MÁU (${p.medkits}/${MAX_MEDKITS})`,
          });
        }
        p.medkits = (p.medkits || 0) + best.amount;
        room.loot = room.loot.filter((item) => item !== best);
        broadcastRaw(room, { type: "lootRemoved", id: best.id });
        lootSfx(room, p, "pickup-medkit", best.x, best.z);
        send(ws, {
          type: "toast",
          text:
            `+${best.amount} BỊCH MÁU` +
            (p.medkits >= MAX_MEDKITS ? " · BALO ĐẦY BỊCH MÁU" : ""),
        });
      }
      broadcast(room);
      return;
    }
    if (m.type === "transferCrate") {
      if (!canFight(room, p))
        return send(ws, {
          type: "toast",
          text: "CHỈ CÓ THỂ LẤY ĐỒ KHI ĐANG CHƠI",
        });
      if (p.swimming)
        return send(ws, {
          type: "toast",
          text: "KHÔNG THỂ LẤY ĐỒ KHI ĐANG BƠI",
        });
      const crate = (room.crates || []).find((item) => item.id === m.crateId);
      const type = ["medkit", "frag", "flash"].includes(m.itemType) ? m.itemType : "ammo";
      const requested = Math.floor(Number(m.amount));
      if (!crate)
        return send(ws, { type: "toast", text: "HÒM ĐỒ KHÔNG CÒN TỒN TẠI" });
      if (Math.hypot(crate.x - p.x, crate.z - p.z) > 5)
        return send(ws, { type: "toast", text: "HÃY ĐẾN GẦN HÒM ĐỒ HƠN" });
      if (!Number.isFinite(requested) || requested <= 0)
        return send(ws, { type: "toast", text: "SỐ LƯỢNG KHÔNG HỢP LỆ" });
      const space =
        type === "ammo"
          ? MAX_RESERVE_AMMO - p.reserveAmmo
          : type === "medkit"
            ? MAX_MEDKITS - (p.medkits || 0)
            : MAX_THROWABLES - (p[throwKey(type)] || 0);
      const amount = Math.min(requested, crate.contents[type] || 0, space);
      if (amount <= 0)
        return send(ws, { type: "toast", text: "KHÔNG ĐỦ CHỖ TRONG BALO" });
      if (type === "ammo") p.reserveAmmo += amount;
      else if (type === "medkit") p.medkits = (p.medkits || 0) + amount;
      else p[throwKey(type)] = (p[throwKey(type)] || 0) + amount;
      crate.contents[type] -= amount;
      lootSfx(room, p, "pickup-" + type, crate.x, crate.z);
      send(ws, {
        type: "toast",
        text: `ĐÃ LẤY ${amount} ${type === "ammo" ? "VIÊN ĐẠN" : type === "medkit" ? "BỊCH MÁU" : GRENADE[type].name}`,
      });
      // Lấy hết đồ: hòm vẫn nằm lại tại chỗ (không xoá).
      broadcast(room);
      return;
    }
    if (m.type === "vehicleEngine" && p.vehicleId && p.vehicleSeat === 0) {
      const vehicle = room.vehicles.find((v) => v.id === p.vehicleId);
      if (!vehicle || vehicle.destroyed) return;
      vehicle.engineOff = !vehicle.engineOff;
      send(ws, { type: "toast", text: vehicle.engineOff ? "ĐÃ TẮT MÁY · GA (W/S) ĐỂ NỔ MÁY LẠI" : "ĐÃ NỔ MÁY" });
      broadcast(room);
      return;
    }
    if ((m.type === "attach" || m.type === "detach" || m.type === "dropAtt") && canFight(room, p)) {
      p.att ||= {};
      p.packAtt ||= [];
      const reloading = p.reloadingUntil > Date.now();
      if (m.type === "attach") {
        const i = Number(m.index);
        const id = p.packAtt[i];
        if (!id || id !== m.att) return;
        const A = Attach.ATTACH[id];
        if (!p.weapon || p.weapon === "none") return send(ws, { type: "toast", text: "CHƯA CÓ SÚNG ĐỂ GẮN" });
        if (!Attach.fits(id, p.weapon)) return send(ws, { type: "toast", text: `${A.name} KHÔNG HỢP ${weaponStats(p).name}` });
        if (reloading && A.slot === "mag") return send(ws, { type: "toast", text: "CHỜ NẠP ĐẠN XONG" });
        p.packAtt.splice(i, 1);
        const old = p.att[A.slot];
        p.att[A.slot] = id;
        if (old) p.packAtt.push(old); // đổi chỗ: món cũ vào balo
        clampMagazine(p);
        lootSfx(room, p, "attach");
      } else if (m.type === "detach") {
        const slot = Attach.SLOTS.includes(m.slot) ? m.slot : null;
        const id = slot && p.att[slot];
        if (!id) return;
        if (reloading && slot === "mag") return send(ws, { type: "toast", text: "CHỜ NẠP ĐẠN XONG" });
        delete p.att[slot];
        attToPack(room, p, id);
        clampMagazine(p);
        lootSfx(room, p, "attach");
      } else {
        if (p.swimming) return send(ws, { type: "toast", text: "KHÔNG THỂ THẢ ĐỒ KHI ĐANG BƠI" });
        let id = null;
        if (m.from === "gun" && Attach.SLOTS.includes(m.slot) && p.att[m.slot]) {
          if (reloading && m.slot === "mag") return send(ws, { type: "toast", text: "CHỜ NẠP ĐẠN XONG" });
          id = p.att[m.slot];
          delete p.att[m.slot];
          clampMagazine(p);
        } else if (m.from === "pack" && p.packAtt[Number(m.index)] === m.att) {
          id = p.packAtt.splice(Number(m.index), 1)[0];
        }
        if (!id) return;
        dropAttLoot(room, p, id);
        lootSfx(room, p, "drop-attach");
      }
      broadcast(room);
      return;
    }
    if (m.type === "aimThrow") {
      const on = Boolean(m.on) && Boolean(p.throwable) && canFight(room, p) && !p.vehicleId;
      if (Boolean(p.aimThrow) !== on) {
        p.aimThrow = on;
        broadcast(room);
      }
      return;
    }
    if (m.type === "equip") {
      p.aimThrow = false;
      const kind = m.kind === "frag" || m.kind === "flash" ? m.kind : null;
      if (p.cook) return; // đã rút chốt thì phải ném
      p.throwable = kind && (p[throwKey(kind)] || 0) > 0 ? kind : null;
      broadcast(room);
      return;
    }
    if (m.type === "cook" && canFight(room, p) && !p.vehicleId) {
      const kind = m.kind === "flash" ? "flash" : "frag";
      if (p.cook || (p[throwKey(kind)] || 0) <= 0 || p.healingUntil > Date.now()) return;
      p.cook = { kind, at: Date.now() };
      p.throwable = kind;
      broadcast(room);
      return;
    }
    if (m.type === "throw" && canFight(room, p) && !p.vehicleId) {
      const kind = m.kind === "flash" ? "flash" : "frag";
      const key = throwKey(kind);
      if ((p[key] || 0) <= 0) return;
      const aim = m.aim;
      if (!aim || ![aim.x, aim.y, aim.z].every(Number.isFinite)) return;
      const len = Math.hypot(aim.x, aim.y, aim.z);
      if (len < 0.5) return;
      const now = Date.now();
      const fuseStart = p.cook?.kind === kind ? p.cook.at : now;
      p.cook = null;
      p[key] -= 1;
      p.throwId = (p.throwId || 0) + 1; // client phát hoạt ảnh vung tay ném
      p.aimThrow = false;
      if (p[key] <= 0) p.throwable = null;
      const eyeY = Number(m.eyeY);
      const base = {
        x: p.x,
        y: Number.isFinite(eyeY) && Math.abs(eyeY - (p.groundY || 0)) < 2.5 ? eyeY : (p.groundY || 0) + 1.6,
        z: p.z,
      };
      const d = { x: aim.x / len, y: aim.y / len, z: aim.z / len };
      spawnGrenade(room, p, kind, { x: base.x + d.x * 0.45, y: base.y + d.y * 0.45, z: base.z + d.z * 0.45 }, { x: d.x * THROW_SPEED, y: d.y * THROW_SPEED + 2.5, z: d.z * THROW_SPEED }, fuseStart);
      broadcast(room);
      return;
    }
    if (m.type === "dropWeapon") {
      if (!canFight(room, p) || p.vehicleId || p.swimming) return;
      if (!p.weapon || p.weapon === "none")
        return send(ws, { type: "toast", text: "BẠN ĐANG TAY KHÔNG" });
      const now = Date.now();
      if (p.reloadingUntil > now)
        return send(ws, { type: "toast", text: "CHỜ NẠP ĐẠN XONG ĐỂ BỎ SÚNG" });
      if (p.healingUntil > now) return;
      const dropped = {
        id: room.nextLootId++,
        type: "weapon",
        weapon: p.weapon,
        x: Math.round(p.x * 100) / 100,
        z: Math.round(p.z * 100) / 100,
        yaw: Math.round(Math.random() * 628) / 100,
        amount: 1,
        ammo: p.ammo,
      };
      room.loot ||= [];
      room.loot.push(dropped);
      const name = weaponStats(p).name;
      stripGunAttachments(room, p);
      p.weapon = "none";
      p.ammo = 0;
      broadcastRaw(room, { type: "lootAdded", item: dropped });
      lootSfx(room, p, "drop-" + dropped.weapon);
      send(ws, { type: "toast", text: `ĐÃ BỎ ${name} · TAY KHÔNG` });
      broadcast(room);
      return;
    }
    if (m.type === "dropItem") {
      if (!canFight(room, p))
        return send(ws, {
          type: "toast",
          text: "CHỈ CÓ THỂ THẢ ĐỒ KHI ĐANG CHƠI",
        });
      if (p.swimming)
        return send(ws, {
          type: "toast",
          text: "KHÔNG THỂ THẢ ĐỒ KHI ĐANG BƠI",
        });
      const type = ["medkit", "frag", "flash"].includes(m.itemType) ? m.itemType : "ammo";
      const requested = Math.floor(Number(m.amount));
      const stat = type === "ammo" ? "reserveAmmo" : type === "medkit" ? "medkits" : throwKey(type);
      const owned = p[stat] || 0;
      if (!Number.isFinite(requested) || requested <= 0 || requested > owned)
        return send(ws, { type: "toast", text: "SỐ LƯỢNG KHÔNG HỢP LỆ" });
      p[stat] = owned - requested;
      const dropped = {
        id: room.nextLootId++,
        type,
        x: p.x,
        z: p.z,
        amount: requested,
      };
      room.loot ||= [];
      room.loot.push(dropped);
      broadcastRaw(room, { type: "lootAdded", item: dropped });
      lootSfx(room, p, "drop-" + type);
      send(ws, {
        type: "toast",
        text: `ĐÃ THẢ ${requested} ${type === "ammo" ? "VIÊN ĐẠN" : type === "medkit" ? "BỊCH MÁU" : GRENADE[type].name}`,
      });
      broadcast(room);
      return;
    }
    if (m.type === "heal" && canFight(room, p) && !p.vehicleId) {
      const now = Date.now();
      if (p.healingUntil > now) return;
      if (p.reloadingUntil > now)
        return send(ws, { type: "toast", text: "ĐANG NẠP ĐẠN" });
      if ((p.medkits || 0) <= 0)
        return send(ws, { type: "toast", text: "KHÔNG CÒN BỊCH MÁU" });
      if (p.hp >= MAX_HP)
        return send(ws, { type: "toast", text: "MÁU ĐÃ ĐẦY" });
      p.healingUntil = now + HEAL_DURATION_MS;
      const healFinishesAt = p.healingUntil;
      broadcast(room);
      setTimeout(() => {
        // Bị hủy (F), chết hoặc thoát phòng thì không hồi và không mất bịch máu.
        if (!room.players.has(p.id) || p.healingUntil !== healFinishesAt)
          return;
        p.healingUntil = 0;
        if (p.alive && p.medkits > 0) {
          p.medkits--;
          p.hp = Math.min(MAX_HP, p.hp + HEAL_AMOUNT);
          send(ws, { type: "toast", text: `ĐÃ HỒI +${HEAL_AMOUNT} MÁU` });
        }
        broadcast(room);
      }, HEAL_DURATION_MS);
      return;
    }
    if (m.type === "cancelHeal" && canFight(room, p)) {
      if (p.healingUntil > Date.now()) {
        p.healingUntil = 0;
        send(ws, { type: "toast", text: "ĐÃ HỦY HỒI MÁU" });
        broadcast(room);
      }
      return;
    }
    if (m.type === "reload" && canFight(room, p) && !p.vehicleId) {
      const now = Date.now();
      if (p.weapon === "none" || !p.weapon)
        return send(ws, { type: "toast", text: "CHƯA CÓ SÚNG · HÃY VÀO NHÀ TÌM SÚNG" });
      if (
        p.healingUntil > now ||
        p.reloadingUntil > now ||
        p.ammo >= magazineSize(p) ||
        p.reserveAmmo <= 0
      ) {
        broadcast(room);
        return;
      }
      const reloadCapacity = magazineSize(p);
      p.reloadingUntil = now + reloadMs(p);
      const reloadFinishesAt = p.reloadingUntil;
      broadcast(room);
      setTimeout(() => {
        if (!room.players.has(p.id) || p.reloadingUntil !== reloadFinishesAt)
          return;
        const amount = Math.min(reloadCapacity - p.ammo, p.reserveAmmo);
        p.ammo += amount;
        p.reserveAmmo -= amount;
        p.reloadingUntil = 0;
        broadcast(room);
      }, reloadMs(p));
      return;
    }
    if (m.type === "shoot" && canFight(room, p) && !p.vehicleId) {
      // Use the exact normalized camera ray sent by the client, then intersect
      // the same oriented boxes/sphere used to draw the visible avatar meshes.
      const aim = m.aim;
      if (!aim || ![aim.x, aim.y, aim.z].every(Number.isFinite)) return;
      const length = Math.hypot(aim.x, aim.y, aim.z);
      if (length < 0.99 || length > 1.01) return;
      const shotTime = Date.now();
      const stats = weaponStats(p);
      const melee = stats === WEAPON_STATS.none;
      if (
        (p.sprinting && !melee) || // đang chạy nhanh thì không bắn được (đấm thì vẫn được)
        p.swimming || // dưới nước không dùng được súng
        p.state !== "ground" ||
        p.healingUntil > shotTime ||
        p.reloadingUntil > shotTime ||
        (!melee && p.ammo <= 0) ||
        shotTime - p.lastShotAt < stats.cooldown
      ) {
        broadcast(room);
        return;
      }
      p.lastShotAt = shotTime;
      // Đấm: tăng punchId (client phát hoạt ảnh + tiếng đấm), không tốn đạn.
      if (melee) p.punchId = (p.punchId || 0) + 1;
      else {
        p.shotId = (p.shotId || 0) + 1;
        p.ammo--;
      }
      const dir = { x: aim.x / length, y: aim.y / length, z: aim.z / length };
      // Position packets are sent at 20 Hz. Accept the current client position
      // only within a small movement tolerance to avoid stale shooter origins.
      const sx = Number(m.x),
        sz = Number(m.z),
        eyeY = Number(m.eyeY);
      const freshPosition =
        Number.isFinite(sx) &&
        Number.isFinite(sz) &&
        Math.hypot(sx - p.x, sz - p.z) <= 1;
      const origin = {
        x: freshPosition ? sx : p.x,
        y:
          Number.isFinite(eyeY) &&
          eyeY >= (p.swimming ? (p.swimY || 0) + 0.35 : 0.35) &&
          eyeY <= 20
            ? eyeY
            : (p.swimming ? p.swimY || 0 : p.groundY || 0) +
              (p.prone ? 0.48 : p.crouching ? 1.34 : 1.8), // khớp độ cao mắt ở client
        z: freshPosition ? sz : p.z,
      };
      // Ray tests cover the full playable map (the previous 32-unit cap made
      // correctly aimed shots at distant players silently miss).
      let target = null,
        targetPart = null,
        struckVehicle = null,
        nearest = stats.range; // đấm chỉ với tới ~1.9 m
      const rayBox = (center, yaw, half) => {
        const c = Math.cos(yaw),
          s = Math.sin(yaw);
        const relX = origin.x - center.x,
          relZ = origin.z - center.z;
        // Transform ray into the player's local coordinates (inverse Y rotation).
        const o = [
          c * relX - s * relZ,
          origin.y - center.y,
          s * relX + c * relZ,
        ];
        const d = [c * dir.x - s * dir.z, dir.y, s * dir.x + c * dir.z];
        const h = [half.x, half.y, half.z];
        let lo = 0,
          hi = nearest;
        for (let i = 0; i < 3; i++) {
          if (Math.abs(d[i]) < 1e-8) {
            if (o[i] < -h[i] || o[i] > h[i]) return null;
            continue;
          }
          let a = (-h[i] - o[i]) / d[i],
            b = (h[i] - o[i]) / d[i];
          if (a > b) [a, b] = [b, a];
          lo = Math.max(lo, a);
          hi = Math.min(hi, b);
          if (lo > hi) return null;
        }
        return hi >= 0 ? Math.max(0, lo) : null;
      };
      const raySphere = (center, radius, scaleY = 1) => {
        const ox = origin.x - center.x;
        const oy = (origin.y - center.y) / scaleY;
        const oz = origin.z - center.z;
        const dy = dir.y / scaleY;

        const b = ox * dir.x + oy * dy + oz * dir.z;
        const c = ox * ox + oy * oy + oz * oz - radius * radius;
        const disc = b * b - c;

        if (disc < 0) return null;

        const t = -b - Math.sqrt(disc);
        return t >= 0 && t <= nearest ? t : null;
      };
      const rayBuilding = (o) => {
        const baseY = obstacleBaseY(room, o) + (o.lift || 0); // nhà sàn: tường đứng trên sàn cao
        const half = o.w / 2;
        const wallHeight = o.h * 0.72;
        const thickness = 0.16;
        const doorHalf = 1.05;
        const centerAt = (lx, lz, y) => ({
          x: o.x + Math.cos(o.yaw || 0) * lx + Math.sin(o.yaw || 0) * lz,
          y: baseY + y,
          z: o.z - Math.sin(o.yaw || 0) * lx + Math.cos(o.yaw || 0) * lz,
        });
        // Tường hông có CỬA SỔ trống (khớp đúng khung vẽ ở client: bệ cửa
        // 34% → đỉnh cửa 73% chiều cao tường, rộng ±0.72 m): đạn bay xuyên qua
        // ô cửa, chỉ phần tường quanh nó chặn đạn. Cửa ra vào có lanh tô phía trên.
        const sill = wallHeight * 0.34;
        const windowTop = wallHeight * 0.73;
        const windowHalf = 0.72;
        const doorH = Math.min(2.25, wallHeight * 0.78);
        const sideWalls = [];
        for (const side of [-1, 1]) {
          const lx = side * (half - thickness / 2);
          const hx = thickness / 2;
          sideWalls.push(
            rayBox(centerAt(lx, 0, sill / 2), o.yaw || 0, { x: hx, y: sill / 2, z: half }),
            rayBox(
              centerAt(lx, 0, (wallHeight + windowTop) / 2),
              o.yaw || 0,
              { x: hx, y: (wallHeight - windowTop) / 2, z: half },
            ),
            ...[-1, 1].map((end) =>
              rayBox(
                centerAt(lx, (end * (half + windowHalf)) / 2, (sill + windowTop) / 2),
                o.yaw || 0,
                { x: hx, y: (windowTop - sill) / 2, z: (half - windowHalf) / 2 },
              ),
            ),
          );
        }
        // Tường hồi (ngũ giác dưới mái ở mặt cửa ra vào và mặt đối diện — khớp
        // tường hồi vẽ ở client): xấp xỉ bằng 3 tấm xếp chồng, hẹp dần lên nóc.
        const eave = o.w * 0.027,
          ridge = o.w * 0.2876;
        for (const end of [-1, 1])
          for (let k = 0; k < 3; k++) {
            const y0 = (ridge * k) / 3,
              y1 = (ridge * (k + 1)) / 3,
              mid = (y0 + y1) / 2;
            const halfWidth = mid <= eave ? half : (half * (ridge - mid)) / (ridge - eave);
            sideWalls.push(
              rayBox(
                centerAt(0, end * (half - thickness / 2), wallHeight + mid),
                o.yaw || 0,
                { x: halfWidth, y: (y1 - y0) / 2, z: thickness / 2 },
              ),
            );
          }
        if (o.lift)
          // Gầm nhà sàn: tấm sàn + 9 cột gỗ chặn đạn, khoảng giữa các cột bắn xuyên được.
          for (const b of Structures.stiltBulletBoxes(o))
            sideWalls.push(rayBox(centerAt(b.x, b.z, b.y - o.lift), o.yaw || 0, { x: b.hx, y: b.hy, z: b.hz }));
        const distances = [
          ...sideWalls,
          rayBox(
            centerAt(0, -half + thickness / 2, (wallHeight + doorH) / 2),
            o.yaw || 0,
            { x: doorHalf, y: (wallHeight - doorH) / 2, z: thickness / 2 },
          ),
          rayBox(
            centerAt(0, half - thickness / 2, wallHeight / 2),
            o.yaw || 0,
            { x: half, y: wallHeight / 2, z: thickness / 2 },
          ),
          rayBox(
            centerAt(
              -(half + doorHalf) / 2,
              -half + thickness / 2,
              wallHeight / 2,
            ),
            o.yaw || 0,
            { x: (half - doorHalf) / 2, y: wallHeight / 2, z: thickness / 2 },
          ),
          rayBox(
            centerAt(
              (half + doorHalf) / 2,
              -half + thickness / 2,
              wallHeight / 2,
            ),
            o.yaw || 0,
            { x: (half - doorHalf) / 2, y: wallHeight / 2, z: thickness / 2 },
          ),
        ].filter((distance) => distance !== null);
        return distances.length ? Math.min(...distances) : null;
      };
      // Mặt đất / đồi chắn đạn. Trước đây vòng dò 0.5 m này bị lặp lại cho
      // TỪNG ngọn đồi (18 lần, mỗi bước lại quét toàn bộ vật cản để tìm cầu)
      // → vài triệu phép tính cho MỖI viên đạn, bắn auto là server đứng hình.
      // Dò đúng một lần cho kết quả y hệt; tia đã bay lên cao hơn mọi ngọn
      // đồi thì không thể chạm đất nữa nên dừng sớm.
      room.terrain ||= Terrain.build(room.obstacles);
      const terrainTop = room.terrain.maxHeight;
      for (let distance = 0.5; distance < nearest; distance += 0.5) {
        const y = origin.y + dir.y * distance;
        if (dir.y >= 0 && y > terrainTop + 0.1) break;
        const x = origin.x + dir.x * distance;
        const z = origin.z + dir.z * distance;
        if (y <= groundHeightAt(room, x, z) + 0.08) {
          nearest = distance;
          break;
        }
      }
      // Lọc thô trên mặt phẳng XZ: vật cản cách xa đường đạn thì bỏ qua,
      // không cần dựng các hộp va chạm chi tiết của nó.
      const flatLength = Math.hypot(dir.x, dir.z);
      const ux = flatLength > 1e-6 ? dir.x / flatLength : 0;
      const uz = flatLength > 1e-6 ? dir.z / flatLength : 0;
      const farOnRay = (o) => {
        const r = obstacleBoundRadius(o) + 0.5;
        const vx = o.x - origin.x,
          vz = o.z - origin.z;
        if (flatLength <= 1e-6) return Math.hypot(vx, vz) > r;
        const along = vx * ux + vz * uz;
        if (along < -r || along > nearest * flatLength + r) return true;
        return Math.abs(vx * uz - vz * ux) > r;
      };
      // Hitbox người chơi theo tư thế — trùng khớp public/avatar.js (HITBOX), bao
      // trọn nón (đầu) và áo giáp (thân). Toạ độ cục bộ: mặt nhìn về -Z.
      const playerHitboxHit = (q, baseY) => {
        const set = playerHitboxes(q);
        const c = Math.cos(q.yaw || 0),
          sn = Math.sin(q.yaw || 0);
        let best = null;
        for (const box of set.boxes) {
          const [lx, ly, lz] = box.c;
          const center = {
            x: q.x + c * lx + sn * lz,
            y: baseY + ly,
            z: q.z - sn * lx + c * lz,
          };
          const t = rayBox(center, q.yaw || 0, { x: box.h[0], y: box.h[1], z: box.h[2] });
          if (t !== null && (!best || t < best.distance))
            best = { distance: t, part: box.part };
        }
        return best;
      };
      // A solid map box blocks shots to anything behind it.
      for (const o of room.obstacles) {
        if (o.type === "hill" || o.solid === false) continue;
        if (farOnRay(o)) continue;
        const baseY = obstacleBaseY(room, o);
        let wallDistance;
        if (o.type === "keep") {
          // Thành chính: từng khối tường / sàn / lan can / cột (cửa sổ, cửa bắn xuyên).
          const c = Math.cos(o.yaw || 0),
            sn = Math.sin(o.yaw || 0);
          for (const b of Structures.keepParts(o)) {
            if (b.kind === "floor") continue;
            const d = rayBox({ x: o.x + c * b.x + sn * b.z, y: baseY + b.y, z: o.z - sn * b.x + c * b.z }, o.yaw || 0, { x: b.hx, y: b.hy, z: b.hz });
            if (d !== null && (wallDistance === undefined || wallDistance === null || d < wallDistance)) wallDistance = d;
          }
        } else if (o.type === "house" || o.type === "hut") {
          wallDistance = rayBuilding(o);
        } else if (o.type === "tree") {
          // Only the visible trunk blocks shots; foliage is not a solid wall.
          wallDistance = rayBox({ x: o.x, y: baseY + o.h * 0.31, z: o.z }, 0, {
            x: o.w * 0.25,
            y: o.h * 0.31,
            z: o.w * 0.25,
          });
        } else if (o.type === "deadTree") {
          wallDistance = rayBox({ x: o.x, y: baseY + o.h / 2, z: o.z }, 0, {
            x: o.w * 0.28,
            y: o.h / 2,
            z: o.w * 0.28,
          });
        } else if (o.type === "cactus") {
          wallDistance = rayBox({ x: o.x, y: baseY + o.h / 2, z: o.z }, 0, {
            x: o.w * 0.48,
            y: o.h / 2,
            z: o.w * 0.27,
          });
        } else if (o.type === "banana" || o.type === "palm") {
          const r = o.w * (o.type === "palm" ? 0.2 : 0.14);
          wallDistance = rayBox({ x: o.x, y: baseY + o.h * 0.35, z: o.z }, 0, { x: r, y: o.h * 0.35, z: r });
        } else if (o.type === "fence" || o.type === "stonewall") {
          wallDistance = rayBox({ x: o.x, y: baseY + o.h / 2, z: o.z }, o.yaw || 0, {
            x: o.w / 2,
            y: o.h / 2,
            z: o.length / 2,
          });
        } else if (o.type === "rock") {
          wallDistance = rayBox(
            { x: o.x, y: baseY + o.h * 0.42, z: o.z },
            o.yaw || 0,
            { x: o.w * 0.5, y: o.h * 0.5, z: o.w * 0.41 },
          );
        } else {
          wallDistance = rayBox({ x: o.x, y: baseY + o.h / 2, z: o.z }, 0, {
            x: o.w / 2,
            y: o.h / 2,
            z: o.w / 2,
          });
        }
        if (wallDistance !== null && wallDistance < nearest)
          nearest = wallDistance;
      }
      // Car collider consists of the visible hood, trunk, side rails and wheels;
      // the open seat area remains hittable so occupants are never made invulnerable.
      for (const vehicle of melee ? [] : room.vehicles || []) {
        if (vehicle.destroyed) continue;
        const baseY = groundHeightAt(room, vehicle.x, vehicle.z);
        const parts = [
          [-0.0, 0.66, -1.02, 0.78, 0.28, 0.72], // hood
          [0, 0.48, 1.28, 0.75, 0.22, 0.54], // trunk
          [-0.88, 0.57, 0.08, 0.1, 0.25, 0.82], // driver-side rail
          [0.88, 0.57, 0.08, 0.1, 0.25, 0.82], // passenger-side rail
          [-0.91, 0.3, -1.08, 0.14, 0.3, 0.34],
          [0.91, 0.3, -1.08, 0.14, 0.3, 0.34],
          [-0.91, 0.3, 1.12, 0.14, 0.3, 0.34],
          [0.91, 0.3, 1.12, 0.14, 0.3, 0.34],
        ];
        let vehicleDistance = null;
        for (const [lx, y, lz, hx, hy, hz] of parts) {
          const center = {
            x:
              vehicle.x +
              Math.cos(vehicle.yaw) * lx +
              Math.sin(vehicle.yaw) * lz,
            y: baseY + y,
            z:
              vehicle.z -
              Math.sin(vehicle.yaw) * lx +
              Math.cos(vehicle.yaw) * lz,
          };
          const hit = rayBox(center, vehicle.yaw, { x: hx, y: hy, z: hz });
          if (
            hit !== null &&
            (vehicleDistance === null || hit < vehicleDistance)
          )
            vehicleDistance = hit;
        }
        if (vehicleDistance !== null && vehicleDistance < nearest) {
          nearest = vehicleDistance;
          struckVehicle = vehicle;
          target = null;
          targetPart = null;
        }
      }
      const blockerDistance = nearest; // tường/đá/xe gần nhất chắn giữa tia và người chơi
      for (const q of room.players.values())
        if (
          q !== p &&
          q.alive &&
          ["ground", "freefall", "parachute"].includes(q.state)
        ) {
          const airborne = q.state === "freefall" || q.state === "parachute";
          const targetBaseY = airborne
            ? Number(q.y) || 0
            : q.swimming
              ? q.swimY || 0
              : q.groundY || 0;
          const hit = playerHitboxHit(q, targetBaseY);
          if (hit && hit.distance < nearest) {
            nearest = hit.distance;
            struckVehicle = null;
            target = q;
            targetPart = hit.part;
          }
        }
      // Red dot dính địch trên màn hình = chắc chắn trúng: nếu cách xét cũ trượt
      // (địch đang di chuyển/trễ mạng) nhưng client báo trúng và tia thật sự đi
      // qua địch trong cửa sổ trễ, không bị vật cản che, thì vẫn tính trúng.
      if (!target && m.hit) {
        const q = room.players.get(m.hit.id);
        const part = m.hit.part === "head" ? "head" : "body";
        if (
          q &&
          q !== p &&
          q.alive &&
          ["ground", "freefall", "parachute"].includes(q.state)
        ) {
          const along = claimAlong(q, part, origin, dir, shotTime);
          if (along !== null && along <= blockerDistance + 0.6) {
            struckVehicle = null;
            target = q;
            targetPart = part;
            nearest = Math.min(nearest, along);
          }
        }
      }
      if (struckVehicle) {
        struckVehicle.hits++;
        struckVehicle.hp = Math.max(0, 60 - struckVehicle.hits);
        struckVehicle.smoke =
          struckVehicle.hits >= 50 ? 2 : struckVehicle.hits >= 30 ? 1 : 0;
        if (struckVehicle.hits >= 60) {
          struckVehicle.destroyed = true;
          struckVehicle.speed = 0;
          struckVehicle.blastPending = true;
          struckVehicle.controls = { throttle: 0, steer: 0, brake: false };
        }
      }
      if (target) {
        room.hitSequence = (room.hitSequence || 0) + 1;
        room.lastHit = {
          id: room.hitSequence,
          targetId: target.id,
          shooterId: p.id,
          point: {
            x: origin.x + dir.x * nearest,
            y: origin.y + dir.y * nearest,
            z: origin.z + dir.z * nearest,
          },
        };
        target.hp = Math.max(0, target.hp - (targetPart === "head" ? stats.head : stats.body));
        if (!target.hp) {
          target.alive = false;
          detachFromVehicle(room, target);
          // Place eliminated players by elimination order; the last survivor is first.
          target.placement =
            [...room.players.values()].filter((player) => player.alive).length +
            1;
          p.kills++;
          room.eliminationSequence = (room.eliminationSequence || 0) + 1;
          room.lastElimination = {
            id: room.eliminationSequence,
            victimId: target.id,
            victimName: target.name,
            killerId: p.id,
            killerName: p.name,
            // Cho màn Chiến tích: hạ bằng súng gì, headshot, khoảng cách.
            weapon: stats.name,
            headshot: targetPart === "head",
            distance: Math.round(nearest),
          };
          dropDeathLoot(room, target);
        }
      }
      // Không kết thúc trận ngay: giữ phase "playing" thêm vài giây để người
      // thắng còn cơ hội nhặt hòm tiếp tế vừa rơi ra từ đối thủ cuối cùng.
      if (
        target &&
        !target.alive &&
        [...room.players.values()].filter((player) => player.alive).length <= 1
      ) {
        room.finishAt = Date.now() + MATCH_END_DELAY_MS;
        send(ws, {
          type: "toast",
          text: `CHIẾN THẮNG! BẠN ĐÃ GÕ ĐẦU TẤT CẢ`,
        });
      }
      broadcast(room);
      return;
    }
  };
  // Một gói tin lỗi của MỘT người chơi không được phép làm sập cả server
  // (trước đây ném lỗi ở đây là mọi phòng đều mất kết nối).
  ws.on("message", (raw) => {
    ws.isAlive = true;
    try {
      handleMessage(raw);
    } catch (error) {
      console.error("message handler error:", error);
    }
  });
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  ws.on("error", (error) => console.warn("socket error:", error.message));
  ws.on("close", () => {
    if (room && ws.player) {
      room.players.delete(ws.player.id);
      if (!room.players.size) {
        clearInterval(room.timer);
        rooms.delete(room.code);
      } else broadcast(room);
    }
  });
});
// Kết nối "chết" (Wi-Fi rớt, đóng nắp laptop) không tự gửi close; nếu không dọn,
// người chơi ma vẫn nằm trong phòng và server vẫn gửi state cho họ.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);
server.listen(PORT, () => {
  console.log(`Last Drop Arena listening on http://localhost:${PORT}`);
  scheduleMapRefill(300); // sinh sẵn map rừng + sa mạc ngay khi server rảnh
});




