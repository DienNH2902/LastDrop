// Minimal room and authoritative match server for a 4–5 player student prototype.
// The server owns health, hits, kills and match state; clients only send inputs.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { WebSocketServer } = require("ws");
const Terrain = require("../public/terrain.js");
const { createObstacles } = require("./mapgen.js");

const ROOT = path.join(__dirname, "..", "public");
const PORT = Number(process.env.PORT || 3000);
const rooms = new Map();

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
  { radiusRatio: 0.62, waitMs: 35000, shrinkMs: 26000, damage: 2 },
  { radiusRatio: 0.55, waitMs: 28000, shrinkMs: 22000, damage: 4 },
  { radiusRatio: 0.5, waitMs: 24000, shrinkMs: 18000, damage: 6 },
  { radiusRatio: 0.45, waitMs: 20000, shrinkMs: 15000, damage: 9 },
  { radiusRatio: 0.4, waitMs: 16000, shrinkMs: 12000, damage: 13 },
  { radiusRatio: 0.35, waitMs: 14000, shrinkMs: 10000, damage: 18 },
  { radiusRatio: 0.3, waitMs: 12000, shrinkMs: 8000, damage: 25 },
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
    peek: r2(p.peek || 0),
    hp: Math.round(p.hp),
    kills: p.kills,
    placement: p.placement || 0,
    alive: p.alive,
    crouching: p.crouching,
    prone: p.prone,
    slowWalking: p.slowWalking,
    vehicleId: p.vehicleId || null,
    vehicleSeat: Number.isInteger(p.vehicleSeat) ? p.vehicleSeat : -1,
    jumpY: r2(p.jumpY),
    ammo: p.ammo,
    weapon: p.weapon || "ranger",
    reserveAmmo: p.reserveAmmo,
    medkits: p.medkits || 0,
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
  return Math.hypot(w, length) * 0.6;
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
  const order = houses.map((_, i) => i);
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
        amount,
      });
      made++;
    }
  };
  place("ammo", AMMO_BOX_COUNT, AMMO_PER_BOX);
  place("medkit", MEDKIT_COUNT, 1);
  // Two sniper rifles spawn in two different houses each round.
  place("weapon", 2, 1);
  for (const item of items.filter((entry) => entry.type === "weapon")) {
    item.weapon = "sniper";
    item.ammo = 5;
  }
  return items;
}
const magazineSize = (player) => (player.weapon === "sniper" ? 5 : 30);

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
function raisedSurfaceAt(room, x, z) {
  let best = null;
  for (const o of nearObstacles(room.obstacles, x, z)) {
    // Chỉ nhà, chòi và đá mới có mặt "đứng được".
    if (o.type !== "house" && o.type !== "hut" && o.type !== "rock") continue;
    if (o.type === "house" || o.type === "hut") {
      const dx = x - o.x,
        dz = z - o.z;
      const c = Math.cos(o.yaw || 0),
        s = Math.sin(o.yaw || 0);
      const lx = c * dx - s * dz,
        lz = s * dx + c * dz;
      const halfX = Math.max(o.w * 0.53, o.w / 2 + 0.6);
      const halfZ = o.w / 2 + 0.6;
      if (Math.abs(lx) > halfX || Math.abs(lz) > halfZ) continue;
      const base = obstacleBaseY(room, o);
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
      const topRadius = o.w * 0.46 + 0.6;
      if (dist > topRadius) continue;
      const base = obstacleBaseY(room, o);
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
function landingHeightAt(room, x, z, previousY) {
  const terrain = groundHeightAt(room, x, z);
  const raised = raisedSurfaceAt(room, x, z);
  return raised && previousY >= raised.height - 0.25
    ? Math.max(terrain, raised.height)
    : terrain;
}
function standingHeightAt(room, x, z, previousGroundY) {
  const terrain = groundHeightAt(room, x, z);
  const raised = raisedSurfaceAt(room, x, z);
  return raised && previousGroundY > raised.base + 0.55
    ? Math.max(terrain, raised.height)
    : terrain;
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
// Keep server movement blockers aligned with the visible prop footprints.
function obstacleFootprintRadius(o) {
  if (o.type === "tree") return o.w * 0.25;
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
) {
  if (
    x < -MAP_HALF + 1 ||
    x > MAP_HALF - 1 ||
    z < -MAP_HALF + 1 ||
    z > MAP_HALF - 1
  )
    return true;
  const mover = room.players.get(ignoreId);
  const moverRadius = mover?.prone ? 1.15 : PLAYER_RADIUS;
  const obstacleRadius = mover?.prone ? 0.55 : PLAYER_RADIUS;
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
      if (blockedByBuilding(o, x, z, obstacleRadius)) return true;
      continue;
    }
    if (o.type === "fence") {
      if (blockedByFence(o, x, z, obstacleRadius)) return true;
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
      room.crates ||= [];
      room.crates.push({
        id: `crate-${room.nextCrateId++}`,
        x: p.x,
        z: p.z,
        contents: {
          ammo: (p.reserveAmmo || 0) + (p.ammo || 0),
          medkit: p.medkits || 0,
        },
      });
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
    limits: { ammo: MAX_RESERVE_AMMO, medkits: MAX_MEDKITS },
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
    killerName:
      cause === "explosion"
        ? "Nổ xe"
        : killer?.name ||
          (candidateKiller === victim ? "Rời xe khi đang chạy" : "Xe tông"),
  };
  room.crates ||= [];
  room.crates.push({
    id: `crate-${room.nextCrateId++}`,
    x: victim.x,
    z: victim.z,
    contents: {
      ammo: (victim.reserveAmmo || 0) + (victim.ammo || 0),
      medkit: victim.medkits || 0,
    },
  });
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
function vehicleFootprintBlocked(room, vehicle, x, z, yaw) {
  // Unbridged water stalls and sinks cars; flagged road crossings are bridges.
  if (waterAt(room, x, z) && !isOnBridge(room.obstacles, x, z, 1.2))
    return false;
  const halfX = 1.03,
    halfZ = 1.84;
  const samples = [];
  for (const side of [-1, 0, 1]) {
    for (const forward of [-1, 0, 1]) {
      if (Math.abs(side) !== 1 && Math.abs(forward) !== 1) continue;
      const lx = side * halfX,
        lz = forward * halfZ;
      samples.push({
        x: x + Math.cos(yaw) * lx + Math.sin(yaw) * lz,
        z: z - Math.sin(yaw) * lx + Math.cos(yaw) * lz,
      });
    }
  }
  // Xe không cần phép thử bề mặt mái/đá dành cho người đi bộ; bỏ mover để
  // tránh quét lại toàn bộ địa hình tìm bề mặt hỗ trợ cho từng góc xe.
  return samples.some((point) =>
    blockedPosition(room, point.x, point.z, null, vehicle.id, true),
  );
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
    } else vehicle.speed *= Math.max(0, 1 - 0.8 * dt);
    const speedFactor = Math.min(1, Math.abs(vehicle.speed) / 4);
    vehicle.yaw +=
      controls.steer * 1.35 * speedFactor * dt * (vehicle.speed < 0 ? -1 : 1);
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
      if (vehicleFootprintBlocked(room, vehicle, nx, nz, vehicle.yaw)) {
        vehicle.speed *= -0.12;
        break;
      }
      vehicle.x = nx;
      vehicle.z = nz;
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
function tickRoom(room) {
  const now = Date.now();
  if (room.phase === "playing" || room.phase === "plane")
    tickVehicles(room, now);
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
      room.phase = "playing";
      initZone(room); // vòng bo chỉ bắt đầu tính giờ từ lúc này (máy bay đã bay hết map)
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
    if (m.type === "ping") return send(ws, { type: "pong", t: m.t });
    if (m.type === "create" || m.type === "join") {
      if (room) return;
      const code = m.type === "create" ? roomCode() : String(m.code || "");
      room = rooms.get(code);
      if (m.type === "join" && !room)
        return send(ws, { type: "error", message: "Không tìm thấy phòng." });
      if (!room) {
        const mapId = m.mapId === "desert" ? "desert" : "forest";
        const mapSeed = Math.floor(Math.random() * 0xffffffff);
        const obstacles = attachObstacleGrid(createObstacles(mapSeed, mapId));
        const terrain = Terrain.build(obstacles);
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
        ammo: 30,
        weapon: "ranger",
        reserveAmmo: 90,
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
      if (p.y - groundHeightAt(room, p.x, p.z) > AIR.maxLandingHeight) return;
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
        const exitX = vehicle.x + Math.cos(vehicle.yaw) * side * 1.65;
        const exitZ = vehicle.z - Math.sin(vehicle.yaw) * side * 1.65;
        if (blockedPosition(room, exitX, exitZ, p.id, vehicle.id))
          return send(ws, { type: "toast", text: "KHÔNG ĐỦ CHỖ ĐỂ RA XE" });
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
      p.jumpY = Math.max(0, Math.min(1.7, Number(m.jumpY) || 0));
      p.jumping = p.jumpY > 0.02;
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
              ? 3.8
              : p.slowWalking
                ? 3.2
                : 7;
      let dx = Number(m.x) - p.x;
      let dz = Number(m.z) - p.z;
      if (!Number.isFinite(dx)) dx = 0;
      if (!Number.isFinite(dz)) dz = 0;
      const distance = Math.hypot(dx, dz);
      const maxDistance = moveSpeed * elapsed + 0.15;
      if (distance > maxDistance && distance > 0) {
        dx *= maxDistance / distance;
        dz *= maxDistance / distance;
      }
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.1));
      const stepX = dx / steps,
        stepZ = dz / steps;
      for (let i = 0; i < steps; i++) {
        const nextX = p.x + stepX;
        if (
          !blockedPosition(room, nextX, p.z, p.id) &&
          (!stayInWaterWhileSubmerged ||
            waterAt(room, nextX, p.z) ||
            isOnBridge(room.obstacles, nextX, p.z, 0.8))
        )
          p.x = nextX;
        const nextZ = p.z + stepZ;
        if (
          !blockedPosition(room, p.x, nextZ, p.id) &&
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
        send(ws, {
          type: "toast",
          text:
            `+${taken} ĐẠN 5.56` +
            (p.reserveAmmo >= MAX_RESERVE_AMMO ? " · BALO ĐẦY ĐẠN" : ""),
        });
      } else if (best.type === "weapon") {
        const oldWeapon = p.weapon || "ranger";
        const dropped = {
          id: room.nextLootId++,
          type: "weapon",
          weapon: oldWeapon,
          x: Math.round(p.x * 100) / 100,
          z: Math.round(p.z * 100) / 100,
          amount: 1,
          ammo: p.ammo,
        };
        room.loot.push(dropped);
        p.weapon = best.weapon === "sniper" ? "sniper" : "ranger";
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
        broadcastRaw(room, { type: "lootAdded", item: dropped });
        send(ws, {
          type: "toast",
          text: `ĐÃ ĐỔI SANG ${p.weapon === "sniper" ? "KAR98K" : "AUG"}`,
        });
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
      const type = m.itemType === "medkit" ? "medkit" : "ammo";
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
          : MAX_MEDKITS - (p.medkits || 0);
      const amount = Math.min(requested, crate.contents[type] || 0, space);
      if (amount <= 0)
        return send(ws, { type: "toast", text: "KHÔNG ĐỦ CHỖ TRONG BALO" });
      if (type === "ammo") p.reserveAmmo += amount;
      else p.medkits = (p.medkits || 0) + amount;
      crate.contents[type] -= amount;
      send(ws, {
        type: "toast",
        text: `ĐÃ LẤY ${amount} ${type === "ammo" ? "VIÊN ĐẠN" : "BỊCH MÁU"}`,
      });
      if (!crate.contents.ammo && !crate.contents.medkit)
        room.crates = room.crates.filter((item) => item !== crate);
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
      const type = m.itemType === "medkit" ? "medkit" : "ammo";
      const requested = Math.floor(Number(m.amount));
      const owned = type === "ammo" ? p.reserveAmmo : p.medkits || 0;
      if (!Number.isFinite(requested) || requested <= 0 || requested > owned)
        return send(ws, { type: "toast", text: "SỐ LƯỢNG KHÔNG HỢP LỆ" });
      if (type === "ammo") p.reserveAmmo -= requested;
      else p.medkits -= requested;
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
      send(ws, {
        type: "toast",
        text: `ĐÃ THẢ ${requested} ${type === "ammo" ? "VIÊN ĐẠN" : "BỊCH MÁU"}`,
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
      p.reloadingUntil = now + 1800;
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
      }, 1800);
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
      if (
        p.healingUntil > shotTime ||
        p.reloadingUntil > shotTime ||
        p.ammo <= 0 ||
        shotTime - p.lastShotAt < (p.weapon === "sniper" ? 1500 : 55)
      ) {
        broadcast(room);
        return;
      }
      p.lastShotAt = shotTime;
      p.shotId = (p.shotId || 0) + 1;
      p.ammo--;
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
              (p.prone ? 0.48 : p.crouching ? 1.05 : 1.65),
        z: freshPosition ? sz : p.z,
      };
      // Ray tests cover the full playable map (the previous 32-unit cap made
      // correctly aimed shots at distant players silently miss).
      let target = null,
        targetPart = null,
        struckVehicle = null,
        nearest = 140;
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
        const baseY = obstacleBaseY(room, o);
        const half = o.w / 2;
        const wallHeight = o.h * 0.72;
        const thickness = 0.16;
        const doorHalf = 1.05;
        const centerAt = (lx, lz, y) => ({
          x: o.x + Math.cos(o.yaw || 0) * lx + Math.sin(o.yaw || 0) * lz,
          y: baseY + y,
          z: o.z - Math.sin(o.yaw || 0) * lx + Math.cos(o.yaw || 0) * lz,
        });
        const distances = [
          rayBox(
            centerAt(-half + thickness / 2, 0, wallHeight / 2),
            o.yaw || 0,
            { x: thickness / 2, y: wallHeight / 2, z: half },
          ),
          rayBox(
            centerAt(half - thickness / 2, 0, wallHeight / 2),
            o.yaw || 0,
            { x: thickness / 2, y: wallHeight / 2, z: half },
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
        if (o.type === "house" || o.type === "hut") {
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
        } else if (o.type === "fence") {
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
      for (const vehicle of room.vehicles || []) {
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
        target.hp = Math.max(
          0,
          target.hp -
            (p.weapon === "sniper"
              ? targetPart === "head"
                ? 100
                : 60
              : targetPart === "head"
                ? 70
                : 10),
        );
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
          };
          room.crates ||= [];
          room.crates.push({
            id: `crate-${room.nextCrateId++}`,
            x: target.x,
            z: target.z,
            contents: {
              ammo: (target.reserveAmmo || 0) + (target.ammo || 0),
              medkit: target.medkits || 0,
            },
          });
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
server.listen(PORT, () =>
  console.log(`Last Drop Arena listening on http://localhost:${PORT}`),
);
