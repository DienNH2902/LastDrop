// Minimal room and authoritative match server for a 4–5 player student prototype.
// The server owns health, hits, kills and match state; clients only send inputs.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { WebSocketServer } = require("ws");

const ROOT = path.join(__dirname, "..", "public");
const PORT = Number(process.env.PORT || 3000);
const rooms = new Map();
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
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
  mapSeed: room.mapSeed,
  lastHit: room.lastHit || null,
  players: [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    x: p.x,
    z: p.z,
    yaw: p.yaw,
    hp: p.hp,
    kills: p.kills,
    alive: p.alive,
    crouching: p.crouching,
    prone: p.prone,
    slowWalking: p.slowWalking,
    jumpY: p.jumpY,
    ammo: p.ammo,
    reserveAmmo: p.reserveAmmo,
    reloadingUntil: p.reloadingUntil,
    reloading: p.reloadingUntil > Date.now(),
    shotId: p.shotId || 0,
    shooting: Date.now() - (p.lastShotAt || 0) < 150,
  })),
  alive: [...room.players.values()].filter((p) => p.alive).length,
  total: room.players.size,
});
function broadcast(room) {
  const data = JSON.stringify(snapshot(room));
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
function blockedPosition(room, x, z, ignoreId) {
  if (x < -49 || x > 49 || z < -49 || z > 49) return true;
  const mover = room.players.get(ignoreId);
  const moverRadius = mover?.prone ? 1.15 : PLAYER_RADIUS;
  for (const o of room.obstacles) {
    const nearestX = Math.max(o.x - o.w / 2, Math.min(x, o.x + o.w / 2));
    const nearestZ = Math.max(o.z - o.w / 2, Math.min(z, o.z + o.w / 2));
    if (Math.hypot(x - nearestX, z - nearestZ) < moverRadius) return true;
  }
  for (const other of room.players.values()) {
    const otherRadius = other.prone ? 1.15 : PLAYER_RADIUS;
    if (other.id !== ignoreId && other.alive && Math.hypot(x - other.x, z - other.z) < moverRadius + otherRadius + 0.02) return true;
  }
  return false;
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
        const mapSeed = Math.floor(Math.random() * 0xffffffff);
        room = { code, phase: "waiting", players: new Map(), mapSeed, obstacles: createObstacles(mapSeed) };
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
        yaw: 0,
        hp: 100,
        kills: 0,
        alive: true,
        crouching: false,
        prone: false,
        slowWalking: false,
        jumpY: 0,
        lastMoveAt: Date.now(),
        ammo: 30,
        reserveAmmo: 90,
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
      room.phase = "playing";
      room.lastHit = null;
      broadcast(room);
      return;
    }
    if (m.type === "move" && room.phase === "playing" && p.alive) {
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
      const moveSpeed = p.prone ? 1.3 : p.crouching && p.slowWalking ? 2 : p.crouching ? 3.8 : p.slowWalking ? 3.2 : 7;
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
      const stepX = dx / steps, stepZ = dz / steps;
      for (let i = 0; i < steps; i++) {
        const nextX = p.x + stepX;
        if (!blockedPosition(room, nextX, p.z, p.id)) p.x = nextX;
        const nextZ = p.z + stepZ;
        if (!blockedPosition(room, p.x, nextZ, p.id)) p.z = nextZ;
      }
      broadcast(room);
      return;
    }
    if (m.type === "reload" && room.phase === "playing" && p.alive) {
      const now = Date.now();
      if (p.reloadingUntil > now || p.ammo >= 30 || p.reserveAmmo <= 0) {
        broadcast(room);
        return;
      }
      p.reloadingUntil = now + 1800;
      const reloadFinishesAt = p.reloadingUntil;
      broadcast(room);
      setTimeout(() => {
        if (!room.players.has(p.id) || p.reloadingUntil !== reloadFinishesAt) return;
        const amount = Math.min(30 - p.ammo, p.reserveAmmo);
        p.ammo += amount;
        p.reserveAmmo -= amount;
        p.reloadingUntil = 0;
        broadcast(room);
      }, 1800);
      return;
    }
    if (m.type === "shoot" && room.phase === "playing" && p.alive) {
      // Use the exact normalized camera ray sent by the client, then intersect
      // the same oriented boxes/sphere used to draw the visible avatar meshes.
      const aim = m.aim;
      if (!aim || ![aim.x, aim.y, aim.z].every(Number.isFinite)) return;
      const length = Math.hypot(aim.x, aim.y, aim.z);
      if (length < 0.99 || length > 1.01) return;
      const shotTime = Date.now();
      if (p.reloadingUntil > shotTime || p.ammo <= 0 || shotTime - p.lastShotAt < 120) {
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
          Number.isFinite(eyeY) && eyeY >= 0.35 && eyeY <= 3.35
            ? eyeY
            : p.prone
              ? 0.48
              : p.crouching
              ? 1.05
              : 1.65,
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
      // A solid map box blocks shots to anything behind it.
      for (const o of room.obstacles) {
        const wallDistance = rayBox(
          { x: o.x, y: o.h / 2, z: o.z },
          0,
          { x: o.w / 2, y: o.h / 2, z: o.w / 2 },
        );
        if (wallDistance !== null && wallDistance < nearest) nearest = wallDistance;
      }
      for (const q of room.players.values())
        if (q !== p && q.alive) {
          // Bounds mirror game.js: torso .65×1×.38, legs .48×.65×.34, head radius .24.
          if (q.prone) {
            const front = (length) => ({
              x: q.x - Math.sin(q.yaw) * length,
              y: 0.35,
              z: q.z - Math.cos(q.yaw) * length,
            });
            const bodyDistances = [
              rayBox(front(1.05), q.yaw, { x: 0.325, y: 0.19, z: 0.5 }),
              rayBox(front(0.4), q.yaw, { x: 0.24, y: 0.17, z: 0.325 }),
            ].filter((t) => t !== null);
            const bodyDistance = bodyDistances.length ? Math.min(...bodyDistances) : null;
            const headDistance = raySphere(front(1.72), 0.24);
            const distance = headDistance === null ? bodyDistance : bodyDistance === null ? headDistance : Math.min(headDistance, bodyDistance);
            if (distance !== null) {
              if (distance < nearest) {
                nearest = distance;
                target = q;
                targetPart = headDistance !== null && headDistance <= distance ? "head" : "body";
              }
            }
            continue;
          }
          const crouchScale = q.crouching ? 0.68 : 1;
          const jumpY = q.jumpY || 0;

          const bodyDistances = [
            rayBox({ x: q.x, y: 1.05 * crouchScale + jumpY, z: q.z }, q.yaw, {
              x: 0.325,
              y: 0.5 * crouchScale,
              z: 0.19,
            }),
            rayBox({ x: q.x, y: 0.4 * crouchScale + jumpY, z: q.z }, q.yaw, {
              x: 0.24,
              y: 0.325 * crouchScale,
              z: 0.17,
            }),
          ].filter((t) => t !== null);
          const bodyDistance = bodyDistances.length ? Math.min(...bodyDistances) : null;
          const headDistance = raySphere(
            { x: q.x, y: 1.72 * crouchScale + jumpY, z: q.z },
            0.24,
            crouchScale,
          );
          const distance = headDistance === null ? bodyDistance : bodyDistance === null ? headDistance : Math.min(headDistance, bodyDistance);
          if (distance !== null) {
            if (distance < nearest) {
              nearest = distance;
              target = q;
              targetPart = headDistance !== null && headDistance <= distance ? "head" : "body";
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
        target.hp = Math.max(0, target.hp - (targetPart === "head" ? 70 : 10));
        if (!target.hp) {
          target.alive = false;
          p.kills++;
        }
      }
      // End the round as soon as only one survivor remains, so the winner
      // receives the same finished state as the eliminated players.
      if (target && !target.alive && [...room.players.values()].filter((player) => player.alive).length <= 1) {
        room.phase = "finished";
      }
      broadcast(room);
      return;
    }
  });
  ws.on("close", () => {
    if (room && ws.player) {
      room.players.delete(ws.player.id);
      if (!room.players.size) rooms.delete(room.code);
      else broadcast(room);
    }
  });
});
server.listen(PORT, () =>
  console.log(`Last Drop Arena listening on http://localhost:${PORT}`),
);
