// Minimal room and authoritative match server for a 4–5 player student prototype.
// The server owns health, hits, kills and match state; clients only send inputs.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { WebSocketServer } = require("ws");

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
const MAP_HALF = 100; // map 200 × 200 m: gấp 4 lần diện tích bản đồ cũ
const MAP_SCALE = MAP_HALF / 50;
const COUNTDOWN_MS = 5000;
// Thời tiết (mưa rừng / bão cát sa mạc): server tự chọn mốc bắt đầu/kết thúc
// ngẫu nhiên cho MỖI TRẬN rồi gửi cho tất cả người chơi trong phòng cùng lúc,
// để ai cũng thấy thời tiết đến/đi ở đúng một thời điểm — không lệch nhau.
const WEATHER_START_DELAY_MS = [25000, 75000]; // chờ ngẫu nhiên trước khi thời tiết bắt đầu
const WEATHER_DURATION_MS = [30000, 70000]; // thời tiết kéo dài ngẫu nhiên trước khi kết thúc
const randomBetween = ([min, max]) => min + Math.random() * (max - min);
// Trận không kết thúc ngay khi hạ người chơi cuối cùng — cho người thắng vài
// giây để nhặt hòm tiếp tế vừa rơi ra trước khi chuyển sang màn kết quả.
const MATCH_END_DELAY_MS = 3000;
const STAGING_TIMEOUT_MS = 20000; // chờ tối đa bấy nhiêu ms cho máy chậm dựng map
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
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(
    new URL(req.url, "http://localhost").pathname,
  );
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
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": types[path.extname(file)] || "application/octet-stream",
    });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server });
const send = (ws, data) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
};
const snapshot = (room) => ({
  type: "state",
  phase: room.phase,
  now: Date.now(),
  countdownEndsAt: room.countdownEndsAt || 0,
  plane: room.plane || null,
  mapSeed: room.mapSeed,
  mapId: room.mapId,
  weatherActive: Boolean(room.weather?.active),
  hostId: [...room.players.keys()][0] || null,
  lastElimination: room.lastElimination || null,
  crates: room.crates || [],
  lastHit: room.lastHit || null,
  players: [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    x: p.x,
    z: p.z,
    groundY: p.groundY || 0,
    state: p.state || "lobby",
    seat: p.seat || 0,
    y: p.state === "freefall" || p.state === "parachute" ? p.y : null,
    ready: Boolean(p.ready),
    swimming: Boolean(p.swimming),
    swimY: p.swimming ? p.swimY : null,
    yaw: p.yaw,
    hp: p.hp,
    kills: p.kills,
    placement: p.placement || 0,
    alive: p.alive,
    crouching: p.crouching,
    prone: p.prone,
    slowWalking: p.slowWalking,
    jumpY: p.jumpY,
    ammo: p.ammo,
    weapon: p.weapon || "ranger",
    reserveAmmo: p.reserveAmmo,
    medkits: p.medkits || 0,
    healing: p.alive && p.healingUntil > Date.now(),
    healLeftMs: p.alive ? Math.max(0, (p.healingUntil || 0) - Date.now()) : 0,
    reloadingUntil: p.reloadingUntil,
    reloading: p.reloadingUntil > Date.now(),
    shotId: p.shotId || 0,
    shooting: Date.now() - (p.lastShotAt || 0) < 150,
  })),
  alive: [...room.players.values()].filter((p) => p.alive).length,
  // Keep the round denominator fixed even if a disconnected player is removed.
  total: room.matchTotal ?? room.players.size,
});
function broadcast(room) {
  const data = JSON.stringify(snapshot(room));
  for (const p of room.players.values())
    if (p.ws.readyState === 1) p.ws.send(data);
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
function createObstacles(seed, mapId) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const forest = mapId === "forest";
  const spawns = [
    [-3, 8],
    [0, 8],
    [3, 8],
    [-3, -8],
    [0, -8],
  ];
  const obstacles = [];
  const riverZ = (x) =>
    (-7 + Math.sin((x + 12 * MAP_SCALE) / (13 * MAP_SCALE)) * 13) * MAP_SCALE;
  if (forest) {
    // Deep water volumes follow the winding stream and can be traversed by swimmers.
    for (let i = 0; i < 10; i++) {
      const x = (-45 + i * 10) * MAP_SCALE;
      const z = riverZ(x);
      const yaw = Math.atan2(2, riverZ(x + 1) - riverZ(x - 1));
      obstacles.push({
        type: "river",
        x,
        z,
        w: 5.2 * MAP_SCALE,
        length: 12 * MAP_SCALE,
        h: 0.08,
        depth: 4.5,
        yaw,
        solid: false,
      });
    }
    obstacles.push({
      type: "lake",
      x: 22 * MAP_SCALE,
      z: -3 * MAP_SCALE,
      w: 12 * MAP_SCALE,
      length: 17 * MAP_SCALE,
      h: 0.08,
      depth: 5.5,
      solid: false,
    });
  }
  const overlapsWater = (x, z, radius) =>
    forest &&
    (Math.hypot(x - 22 * MAP_SCALE, z + 3 * MAP_SCALE) <
      radius + 11 * MAP_SCALE ||
      Array.from({ length: 10 }, (_, i) => (-45 + i * 10) * MAP_SCALE).some(
        (rx) => Math.hypot(x - rx, z - riverZ(rx)) < radius + 3,
      ));
  function add(type, count, minW, maxW, minH, maxH, gap = 1.2) {
    let made = 0;
    for (let attempt = 0; attempt < count * 30 && made < count; attempt++) {
      const x = (random() - 0.5) * 88 * MAP_SCALE;
      const z = (random() - 0.5) * 88 * MAP_SCALE;
      const w = minW + random() * (maxW - minW);
      const h = minH + random() * (maxH - minH);
      const spawnClearance = type === "hill" ? w / 2 + 8 : w / 2 + 5;
      if (
        spawns.some(([sx, sz]) => Math.hypot(x - sx, z - sz) < spawnClearance)
      )
        continue;
      if (overlapsWater(x, z, w / 2)) continue;
      if (
        obstacles.some(
          (o) =>
            (o.solid !== false || o.type === "hill") &&
            Math.hypot(x - o.x, z - o.z) < (w + o.w) / 2 + gap,
        )
      )
        continue;
      obstacles.push({
        type,
        x,
        z,
        w,
        h,
        solid: type !== "hill",
        yaw: type === "house" || type === "hut" ? 0 : random() * Math.PI * 2,
      });
      made++;
    }
  }
  if (forest) {
    add("hill", 16, 18, 25, 6, 11, 5);
  } else {
    add("hill", 12, 20, 28, 7, 13, 5);
  }
  // Shelters are larger now and remain on flatter ground around the hills.
  add("house", 44, 6.5, 8.5, 4.2, 5.4, 3);
  add("hut", 32, 4.5, 6, 3, 3.8, 2.2);
  if (forest) {
    add("rock", 120, 1.3, 3.2, 1, 3.2, 0.8);
    add("tree", 192, 0.65, 1.15, 3.8, 7.2, 0.6);
  } else {
    add("rock", 152, 1.4, 3.8, 1, 3.5, 0.8);
    add("cactus", 96, 0.55, 1.1, 2, 4.2, 0.7);
    add("deadTree", 60, 0.6, 1.1, 3, 5.5, 0.8);
  }
  return obstacles;
}
// ---- Vật phẩm rơi trên map: đạn và bịch máu ----
const PICKUP_RADIUS = 2.5; // mét; client hiện gợi ý F ở 2 m, server dư 0.5 m để bù độ trễ vị trí
const AMMO_PER_BOX = 30;
const AMMO_BOX_COUNT = 104;
const MEDKIT_COUNT = 56;
const HEAL_AMOUNT = 20;
const HEAL_DURATION_MS = 5000;
const MAX_HP = 100;
// Sức chứa balo (đạn dự trữ và bịch máu). Không tính đạn đang lắp trong súng.
const MAX_RESERVE_AMMO = 210;
const MAX_MEDKITS = 5;
function createLoot(room) {
  const items = [];
  let nextId = 1;
  const place = (type, count, amount) => {
    let made = 0;
    for (let attempt = 0; attempt < count * 80 && made < count; attempt++) {
      const x = (Math.random() - 0.5) * 192;
      const z = (Math.random() - 0.5) * 192;
      if (blockedPosition(room, x, z, null)) continue; // cây, đá, tường nhà...
      // Không đặt trong nước (kể cả sát mép sông/hồ).
      if (
        [
          [0, 0],
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([ox, oz]) => waterAt(room, x + ox, z + oz))
      )
        continue;
      // Rải đều, tránh các vật phẩm chồng lên nhau.
      if (items.some((i) => Math.hypot(i.x - x, i.z - z) < 5)) continue;
      items.push({
        id: nextId++,
        type,
        x: Math.round(x * 100) / 100,
        z: Math.round(z * 100) / 100,
        amount,
      });
      made++;
    }
  };
  place("ammo", AMMO_BOX_COUNT, AMMO_PER_BOX);
  place("medkit", MEDKIT_COUNT, 1);
  // Two sniper rifles spawn at separate, walkable positions each round.
  place("weapon", 2, 1);
  for (const item of items.filter((entry) => entry.type === "weapon")) {
    item.weapon = "sniper";
    item.ammo = 5;
  }
  return items;
}
const magazineSize = (player) => (player.weapon === "sniper" ? 5 : 30);
function groundHeightAt(room, x, z) {
  let height = 0;
  for (const hill of room.hills || room.obstacles) {
    if (hill.type !== "hill") continue;
    const radius = hill.w / 2;
    const distanceSquared =
      ((x - hill.x) / radius) ** 2 + ((z - hill.z) / radius) ** 2;
    if (distanceSquared >= 1) continue;
    height = Math.max(height, hill.h * Math.pow(1 - distanceSquared, 1.4));
  }
  return height;
}
// Walkable upper surfaces: the pitched roof and the safe crown of large rocks.
function raisedSurfaceAt(room, x, z) {
  let best = null;
  for (const o of room.obstacles) {
    const base = groundHeightAt(room, o.x, o.z);
    if (o.type === "house" || o.type === "hut") {
      const dx = x - o.x,
        dz = z - o.z;
      const c = Math.cos(o.yaw || 0),
        s = Math.sin(o.yaw || 0);
      const lx = c * dx - s * dz,
        lz = s * dx + c * dz;
      // Vùng "trên mái" phải rộng bằng hoặc hơn vùng va chạm của tường nhà
      // (blockedByBuilding dùng half + obstacleRadius) để tránh dải kẹt ở mép mái.
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
  for (const water of room.obstacles) {
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
const PLAYER_RADIUS = 0.38;
// Keep server movement blockers aligned with the visible prop footprints.
function obstacleFootprintRadius(o) {
  if (o.type === "tree") return o.w * 0.25;
  if (o.type === "deadTree") return o.w * 0.28;
  if (o.type === "cactus") return o.w * 0.48;
  if (o.type === "rock") return o.w * 0.46;
  return null;
}
function blockedPosition(room, x, z, ignoreId) {
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
  for (const o of room.obstacles) {
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
    const footprint = obstacleFootprintRadius(o);
    if (footprint !== null) {
      const rockTop =
        o.type === "rock" &&
        support?.type === "rock" &&
        support.obstacle === o &&
        mover.groundY > support.base + o.h * 0.62;
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
    const otherRadius = other.prone ? 1.15 : PLAYER_RADIUS;
    if (
      other.id !== ignoreId &&
      other.alive &&
      isGrounded(other) &&
      Math.hypot(x - other.x, z - other.z) < moverRadius + otherRadius + 0.02
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
function tickRoom(room) {
  const now = Date.now();
  const players = [...room.players.values()];
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
  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.type === "create" || m.type === "join") {
      if (room) return;
      const code = m.type === "create" ? roomCode() : String(m.code || "");
      room = rooms.get(code);
      if (m.type === "join" && !room)
        return send(ws, { type: "error", message: "Không tìm thấy phòng." });
      if (!room) {
        const mapId = m.mapId === "desert" ? "desert" : "forest";
        const mapSeed = Math.floor(Math.random() * 0xffffffff);
        const obstacles = createObstacles(mapSeed, mapId);
        room = {
          code,
          phase: "waiting",
          players: new Map(),
          mapSeed,
          mapId,
          obstacles,
          hills: obstacles.filter((obstacle) => obstacle.type === "hill"),
          crates: [],
          nextCrateId: 1,
          nextLootId: 1,
        };
        rooms.set(code, room);
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
        hp: 100,
        kills: 0,
        placement: 0,
        alive: true,
        crouching: false,
        prone: false,
        slowWalking: false,
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
      const weatherStartAt =
        room.stagingStartedAt + randomBetween(WEATHER_START_DELAY_MS);
      room.weather = {
        startAt: weatherStartAt,
        endAt: weatherStartAt + randomBetween(WEATHER_DURATION_MS),
        active: false,
      };
      for (const q of room.players.values()) {
        q.state = "lobby";
        q.ready = false;
        q.placement = 0;
      }
      room.timer = setInterval(() => tickRoom(room), 100);
      broadcast(room);
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
      p.jumpY = 0;
      p.swimming = false;
      p.swimY = null;
      p.lastMoveAt = Date.now();
      send(ws, { type: "landed", x: p.x, z: p.z, groundY: p.groundY });
      broadcast(room);
      return;
    }
    if (m.type === "move" && canWalk(room, p)) {
      p.crouching = Boolean(m.crouching);
      p.prone = Boolean(m.prone);
      if (p.prone) p.crouching = false;
      p.slowWalking = Boolean(m.slowWalking);
      p.jumpY = Math.max(0, Math.min(1.7, Number(m.jumpY) || 0));
      p.jumping = p.jumpY > 0.02;
      p.yaw = Number(m.yaw) || 0;
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
          (!stayInWaterWhileSubmerged || waterAt(room, nextX, p.z))
        )
          p.x = nextX;
        const nextZ = p.z + stepZ;
        if (
          !blockedPosition(room, p.x, nextZ, p.id) &&
          (!stayInWaterWhileSubmerged || waterAt(room, p.x, nextZ))
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
      broadcast(room);
      return;
    }
    if (m.type === "pickup" && canFight(room, p)) {
      // The client sends the item targeted by the crosshair; validate that exact item here.
      if (p.healingUntil > Date.now() || p.swimming) return;
      const best = (room.loot || []).find((item) => item.id === m.itemId);
      if (!best || Math.hypot(best.x - p.x, best.z - p.z) > PICKUP_RADIUS)
        return;
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
          text: `ĐÃ ĐỔI SANG ${p.weapon === "sniper" ? "SNIPER" : "RANGER-9"}`,
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
    if (m.type === "heal" && canFight(room, p)) {
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
    if (m.type === "reload" && canFight(room, p)) {
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
      p.reloadingUntil = now + 1800;
      const reloadFinishesAt = p.reloadingUntil;
      broadcast(room);
      setTimeout(() => {
        if (!room.players.has(p.id) || p.reloadingUntil !== reloadFinishesAt)
          return;
        const amount = Math.min(magazineSize(p) - p.ammo, p.reserveAmmo);
        p.ammo += amount;
        p.reserveAmmo -= amount;
        p.reloadingUntil = 0;
        broadcast(room);
      }, 1800);
      return;
    }
    if (m.type === "shoot" && canFight(room, p)) {
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
        shotTime - p.lastShotAt < (p.weapon === "sniper" ? 1500 : 120)
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
        const baseY = groundHeightAt(room, o.x, o.z);
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
      // A solid map box blocks shots to anything behind it.
      for (const o of room.obstacles) {
        if (o.type === "hill") {
          for (let distance = 0.5; distance < nearest; distance += 0.5) {
            const x = origin.x + dir.x * distance;
            const y = origin.y + dir.y * distance;
            const z = origin.z + dir.z * distance;
            if (y <= groundHeightAt(room, x, z) + 0.08) {
              nearest = distance;
              break;
            }
          }
          continue;
        }
        if (o.solid === false) continue;
        const baseY = groundHeightAt(room, o.x, o.z);
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
      for (const q of room.players.values())
        if (q !== p && q.alive && q.state === "ground") {
          const targetBaseY = q.swimming ? q.swimY || 0 : q.groundY || 0;
          // Bounds mirror game.js: torso .65×1×.38, legs .48×.65×.34, head radius .24.
          if (q.prone) {
            const front = (length) => ({
              x: q.x - Math.sin(q.yaw) * length,
              y: targetBaseY + 0.35,
              z: q.z - Math.cos(q.yaw) * length,
            });
            const bodyDistances = [
              rayBox(front(1.05), q.yaw, { x: 0.325, y: 0.19, z: 0.5 }),
              rayBox(front(0.4), q.yaw, { x: 0.24, y: 0.17, z: 0.325 }),
            ].filter((t) => t !== null);
            const bodyDistance = bodyDistances.length
              ? Math.min(...bodyDistances)
              : null;
            const headDistance = raySphere(front(1.72), 0.24);
            const distance =
              headDistance === null
                ? bodyDistance
                : bodyDistance === null
                  ? headDistance
                  : Math.min(headDistance, bodyDistance);
            if (distance !== null) {
              if (distance < nearest) {
                nearest = distance;
                target = q;
                targetPart =
                  headDistance !== null && headDistance <= distance
                    ? "head"
                    : "body";
              }
            }
            continue;
          }
          const crouchScale = q.crouching ? 0.68 : 1;
          const jumpY = q.jumpY || 0;

          const bodyDistances = [
            rayBox(
              { x: q.x, y: targetBaseY + 1.05 * crouchScale + jumpY, z: q.z },
              q.yaw,
              {
                x: 0.325,
                y: 0.5 * crouchScale,
                z: 0.19,
              },
            ),
            rayBox(
              { x: q.x, y: targetBaseY + 0.4 * crouchScale + jumpY, z: q.z },
              q.yaw,
              {
                x: 0.24,
                y: 0.325 * crouchScale,
                z: 0.17,
              },
            ),
          ].filter((t) => t !== null);
          const bodyDistance = bodyDistances.length
            ? Math.min(...bodyDistances)
            : null;
          const headDistance = raySphere(
            { x: q.x, y: targetBaseY + 1.72 * crouchScale + jumpY, z: q.z },
            0.24,
            crouchScale,
          );
          const distance =
            headDistance === null
              ? bodyDistance
              : bodyDistance === null
                ? headDistance
                : Math.min(headDistance, bodyDistance);
          if (distance !== null) {
            if (distance < nearest) {
              nearest = distance;
              target = q;
              targetPart =
                headDistance !== null && headDistance <= distance
                  ? "head"
                  : "body";
            }
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
          text: `CHIẾN THẮNG! TRANH THỦ NHẶT HÒM ĐỒ — VỀ SẢNH SAU ${Math.round(MATCH_END_DELAY_MS / 1000)}S`,
        });
      }
      broadcast(room);
      return;
    }
  });
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
server.listen(PORT, () =>
  console.log(`Last Drop Arena listening on http://localhost:${PORT}`),
);
