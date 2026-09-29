// Sinh map tự nhiên cho 2 bản đồ (rừng / sa mạc) từ một seed.
// Kết quả là danh sách obstacles CÙNG định dạng cũ (road, river, lake, hill,
// house, hut, rock, tree, cactus, deadTree...) cộng vài loại mới chỉ để dựng
// địa hình (terrain, plateau, pad, swamp) và hàng rào cầu (fence). Mọi logic
// gameplay (va chạm, loot, xe, nước, cầu) vẫn đọc đúng các trường như trước.
//
// Nguyên tắc:
// - Núi = chuỗi khối elip xoay nối nhau thành DÃY dài, cao 30–70 m, phủ ~40%
//   (rừng) / ~60% (sa mạc) diện tích; viền map là núi uốn lượn để không lộ mép vuông.
// - Nhà gom thành làng; đường cong nối các làng, cắt nhau trên đất liền, qua
//   sông bằng cầu có rào; có đường lên núi.
// - Không vật thể nào chồng lên nhau (kiểm tra bằng lưới chiếm chỗ).
const Terrain = require("../public/terrain.js");

const MAP_HALF = Terrain.MAP_HALF;
const ROAD_W = 9;

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const round = (v, p = 100) => Math.round(v * p) / p;
function segDistance(x, z, ax, az, bx, bz) {
  const vx = bx - ax,
    vz = bz - az;
  const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz || 1)));
  return Math.hypot(x - (ax + vx * t), z - (az + vz * t));
}
function segIntersect(a, b, c, d) {
  const r = { x: b.x - a.x, z: b.z - a.z },
    s = { x: d.x - c.x, z: d.z - c.z };
  const den = r.x * s.z - r.z * s.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * s.z - (c.z - a.z) * s.x) / den;
  const u = ((c.x - a.x) * r.z - (c.z - a.z) * r.x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x + r.x * t, z: a.z + r.z * t };
}
function polyDistance(points, x, z) {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++)
    best = Math.min(best, segDistance(x, z, points[i].x, points[i].z, points[i + 1].x, points[i + 1].z));
  return best;
}
// Đường cong Bezier bậc 3 lấy mẫu đều ~step mét.
function bezierPath(a, c1, c2, b, step) {
  const raw = [];
  for (let i = 0; i <= 64; i++) {
    const t = i / 64,
      u = 1 - t;
    raw.push({
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      z: u * u * u * a.z + 3 * u * u * t * c1.z + 3 * u * t * t * c2.z + t * t * t * b.z,
    });
  }
  const out = [raw[0]];
  let acc = 0;
  for (let i = 1; i < raw.length; i++) {
    acc += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].z - raw[i - 1].z);
    if (acc >= step || i === raw.length - 1) {
      out.push(raw[i]);
      acc = 0;
    }
  }
  return out;
}

// Lưới chiếm chỗ: mọi vật thể đặt lên map đăng ký một hình tròn; vật mới không
// được giao với vật cũ (không chồng lấp).
function makeOccupancy() {
  const cell = 16;
  const cells = new Map();
  const key = (i, j) => (i + 64) * 256 + (j + 64);
  return {
    add(x, z, r) {
      const item = { x, z, r };
      for (let i = Math.floor((x - r) / cell); i <= Math.floor((x + r) / cell); i++)
        for (let j = Math.floor((z - r) / cell); j <= Math.floor((z + r) / cell); j++) {
          const k = key(i, j);
          if (!cells.has(k)) cells.set(k, []);
          cells.get(k).push(item);
        }
    },
    free(x, z, r) {
      for (let i = Math.floor((x - r) / cell); i <= Math.floor((x + r) / cell); i++)
        for (let j = Math.floor((z - r) / cell); j <= Math.floor((z + r) / cell); j++)
          for (const o of cells.get(key(i, j)) || [])
            if (Math.hypot(o.x - x, o.z - z) < o.r + r) return false;
      return true;
    },
  };
}

function createObstacles(seed, mapId) {
  const random = makeRandom(seed);
  const rand = (a, b) => a + random() * (b - a);
  // "jungle" = THÀNH CỔ (nhiệt đới kiểu Sanhok): dùng chung sông/đầm/làng của
  // map rừng nhưng núi 70%, sông lớn nhiều cầu, đường đất đỏ, nhà sàn, pháo đài,
  // cây lá rộng / chuối / dừa (không có cây thông).
  const jungle = mapId === "jungle";
  const forest = mapId === "forest" || jungle; // các phần chung với map rừng
  const obstacles = [{ type: "terrain", seed: seed & 0x7fffffff, solid: false }];
  const occ = makeOccupancy();
  const hills = [];
  const waters = [];
  const riverLines = [];
  // Khu chờ đầu trận ở tâm map luôn phẳng, trống.
  const SPAWN_CLEAR = 22;
  occ.add(0, 0, SPAWN_CLEAR);
  obstacles.push({ type: "plateau", x: 0, z: 0, r: 16, level: 0.4, solid: false });

  // ---------------- Nước (rừng): sông uốn lượn, hồ, đầm lầy ----------------
  if (forest) {
    // Sông chảy xuyên map, tránh khu chờ ở tâm.
    // Sông chảy chéo qua map theo hướng ngẫu nhiên, đủ gần giữa để hai bờ
    // đều có đất dựng làng, nhưng luôn cách khu chờ ở tâm ≥ 36 m.
    const side = random() < 0.5 ? -1 : 1;
    let pts = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      const baseZ = side * rand(40, 70);
      const phase = rand(0, Math.PI * 2);
      const angle = rand(-0.5, 0.5);
      const ca = Math.cos(angle),
        sa = Math.sin(angle);
      pts = [];
      for (let u = -MAP_HALF - 60; u <= MAP_HALF + 60; u += 14) {
        const v = baseZ + Math.sin(u / 55 + phase) * 30 + Math.sin(u / 23 + phase * 2) * 8;
        pts.push({ x: u * ca - v * sa, z: u * sa + v * ca });
      }
      if (polyDistance(pts, 0, 0) >= 36) break;
    }
    riverLines.push(pts);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i],
        b = pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const river = {
        type: "river",
        riverId: 1,
        seq: i,
        x: (a.x + b.x) / 2,
        z: (a.z + b.z) / 2,
        w: jungle ? rand(26, 32) : rand(17, 21), // Thành Cổ: sông lớn
        length: len + 6, // chồng mí để mặt nước liền mạch
        h: 0.08,
        depth: jungle ? 5.5 : 4.5,
        yaw: Math.atan2(b.x - a.x, b.z - a.z),
        solid: false,
      };
      obstacles.push(river);
      waters.push(river);
    }
    // Hồ nằm cạnh sông, phía trong map.
    const li = Math.floor(pts.length * rand(0.3, 0.7));
    const lp = pts[li];
    const lake = {
      type: "lake",
      x: lp.x,
      z: lp.z - side * rand(38, 48),
      w: rand(34, 44),
      length: rand(24, 32),
      h: 0.08,
      depth: 5.5,
      yaw: rand(-0.4, 0.4),
      solid: false,
    };
    obstacles.push(lake);
    waters.push(lake);
    // Đầm lầy: vùng nước nông màu đục, đi bộ được.
    for (let n = 0, tries = 0; n < (jungle ? 4 : 2) && tries < (jungle ? 400 : 60); tries++) {
      const p = pts[Math.floor(rand(4, pts.length - 4))];
      const s = {
        type: "swamp",
        x: p.x + rand(-20, 20),
        z: p.z - side * rand(40, 70),
        w: rand(26, 36),
        length: rand(18, 26),
        yaw: rand(0, Math.PI),
        solid: false,
      };
      if (Math.hypot(s.x, s.z) < 70 || Math.abs(s.x) > MAP_HALF - 50 || Math.abs(s.z) > MAP_HALF - 50) continue;
      if (waters.some((o) => Math.hypot(o.x - s.x, o.z - s.z) < (o.type === "river" ? 14 : 0) + Math.max(o.w, o.length) / 2 + s.w + 6))
        continue;
      obstacles.push(s);
      waters.push(s);
      n++;
    }
  }
  const nearWater = (x, z, margin) =>
    waters.some((o) => Terrain.insideWater(o, x, z, margin));

  // ---------------- Núi ----------------
  // Lưới phủ thô 4 m để đo % diện tích là núi (cao > 5 m).
  const CG = 100,
    CS = (MAP_HALF * 2) / CG;
  const cover = new Float32Array(CG * CG);
  let covered = 0;
  const addHill = (hill) => {
    hills.push(hill);
    obstacles.push(hill);
    const r = Terrain.hillRadius(hill);
    const i0 = Math.max(0, Math.floor((hill.x - r + MAP_HALF) / CS)),
      i1 = Math.min(CG - 1, Math.ceil((hill.x + r + MAP_HALF) / CS));
    const j0 = Math.max(0, Math.floor((hill.z - r + MAP_HALF) / CS)),
      j1 = Math.min(CG - 1, Math.ceil((hill.z + r + MAP_HALF) / CS));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = j * CG + i;
        const h = Terrain.hillHeight(hill, (i + 0.5) * CS - MAP_HALF, (j + 0.5) * CS - MAP_HALF);
        if (h > cover[k]) {
          if (cover[k] <= 5 && h > 5) covered++;
          cover[k] = h;
        }
      }
  };
  const coverage = () => covered / (CG * CG);
  // Khối núi hợp lệ nếu không phủ lên nước / khu chờ.
  const hillFits = (x, z, w, length) => {
    const r = Math.max(w, length) / 2;
    if (Math.hypot(x, z) < r + 45) return false;
    for (const line of riverLines) if (polyDistance(line, x, z) < r * 0.8 + 18) return false;
    return !waters.some((o) => o.type !== "river" && Math.hypot(o.x - x, o.z - z) < r * 0.8 + Math.max(o.w, o.length) + 12);
  };
  const peak = jungle ? [20, 42] : forest ? [26, 50] : [30, 62];
  // Viền map: dải núi uốn lượn quanh mép, cộng hàng núi ngoài biên làm phông nền.
  const perimeter = MAP_HALF * 8;
  const offset = rand(0, perimeter);
  for (let d = 0; d < perimeter; d += 30) {
    const s = (d + offset) % perimeter;
    const sideIndex = Math.floor(s / (MAP_HALF * 2));
    const u = (s % (MAP_HALF * 2)) - MAP_HALF;
    // Mép trong của viền núi lượn vào/ra thất thường (vịnh thung lũng / mũi núi).
    const inset = -28 + Terrain.fbm(d / 60, 3.7, seed, 3) * 125;
    const place = (distIn) => {
      const e = MAP_HALF - distIn;
      return sideIndex === 0 ? { x: u, z: -e } : sideIndex === 1 ? { x: e, z: u } : sideIndex === 2 ? { x: -u, z: e } : { x: -e, z: -u };
    };
    const tangentYaw = sideIndex % 2 === 0 ? Math.PI / 2 : 0;
    const inner = place(inset);
    const w = rand(34, 62),
      length = rand(44, 80);
    if (random() > 0.18 && hillFits(inner.x, inner.z, w * 0.6, length * 0.6))
      addHill({ type: "hill", x: inner.x, z: inner.z, w, length, h: rand(peak[0], peak[1]), yaw: tangentYaw + rand(-0.35, 0.35), solid: false });
    const outer = place(-30);
    if (!riverLines.some((line) => polyDistance(line, outer.x, outer.z) < 45))
      addHill({ type: "hill", x: outer.x, z: outer.z, w: rand(60, 90), length: rand(70, 100), h: rand(peak[0] + 5, peak[1] + 10), yaw: tangentYaw, solid: false });
  }
  // Dãy núi bên trong: đi ngẫu nhiên, mỗi bước một khối elip dọc theo hướng đi,
  // độ cao dao động → sống núi nhấp nhô.
  const target = jungle ? 0.7 : forest ? 0.4 : 0.6;
  for (let range = 0; range < (jungle ? 160 : 60) && coverage() < target; range++) {
    let x, z, dir;
    if (random() < 0.5) {
      // Dãy núi nhánh mọc từ viền đâm vào trong map.
      const edgeSide = Math.floor(random() * 4),
        u = rand(-MAP_HALF + 40, MAP_HALF - 40);
      const e = MAP_HALF - 25;
      [x, z] = edgeSide === 0 ? [u, -e] : edgeSide === 1 ? [e, u] : edgeSide === 2 ? [u, e] : [-e, u];
      dir = Math.atan2(-x, -z) + rand(-0.6, 0.6);
    } else {
      x = rand(-MAP_HALF + 60, MAP_HALF - 60);
      z = rand(-MAP_HALF + 60, MAP_HALF - 60);
      dir = rand(0, Math.PI * 2);
    }
    const steps = Math.floor(rand(5, 11));
    const scale = rand(0.8, 1.15);
    for (let s = 0; s < steps && coverage() < target; s++) {
      // Khối dài theo hướng đi và chồng lên nhau nhiều → sống núi liền mạch.
      const w = rand(44, 64) * scale,
        length = rand(76, 100) * scale;
      if (hillFits(x, z, w, length))
        addHill({ type: "hill", x, z, w, length, h: rand(peak[0], peak[1]) * (0.75 + 0.25 * Math.sin((s / steps) * Math.PI)), yaw: dir, solid: false });
      dir += rand(-0.45, 0.45);
      x += Math.sin(dir) * 22;
      z += Math.cos(dir) * 22;
      if (Math.abs(x) > MAP_HALF - 30 || Math.abs(z) > MAP_HALF - 30) break;
    }
  }
  // Địa hình tạm (chưa có đường/nhà) để tìm chỗ đặt làng và vạch đường.
  let T0 = Terrain.build(obstacles);
  const flatAround = (x, z, r, maxH) => {
    for (let a = 0; a < 8; a++)
      for (const rr of [r * 0.5, r]) {
        const h = T0.heightAt(x + Math.cos(a * 0.785) * rr, z + Math.sin(a * 0.785) * rr);
        if (h > maxH) return false;
      }
    return T0.heightAt(x, z) <= maxH;
  };

  // ---------------- Làng ----------------
  const villages = [];
  // ---------------- Pháo đài cổ (Thành Cổ) ----------------
  // Tường đá dày bao quanh sân vuông, 4 tháp góc, cổng ở một mặt; vài căn nhà
  // đá bên trong chứa đồ. Đường nối vào CỔNG (điểm ngoài cổng), không xuyên tường.
  const fortresses = [];
  if (jungle) {
    const HALF = 22;
    for (let tries = 0; tries < 1500; tries++) {
      const x = rand(-MAP_HALF + 60, MAP_HALF - 60),
        z = rand(-MAP_HALF + 60, MAP_HALF - 60);
      if (Math.hypot(x, z) < SPAWN_CLEAR + HALF + 30) continue;
      if (nearWater(x, z, HALF + 18)) continue;
      const h = T0.heightAt(x, z);
      if (h > 30) continue;
      const yaw = Math.atan2(-x, -z) + rand(-0.3, 0.3); // cổng quay về phía tâm map
      obstacles.push({ type: "plateau", x, z, r: HALF + 6, level: round(h), solid: false });
      const c = Math.cos(yaw),
        sn = Math.sin(yaw);
      const W = (lx, lz) => ({ x: x + c * lx + sn * lz, z: z - sn * lx + c * lz });
      const gate = W(0, -HALF - 7);
      fortresses.push({ x, z, yaw, HALF, level: h, gate });
      occ.add(x, z, HALF * 1.45 + 4); // chiếm chỗ NGAY (làng / nhà / cây không mọc trong thành)
      villages.push({ x: gate.x, z: gate.z, R: 6, size: 0, mountain: h > 8, fortress: true });
      break;
    }
  }
  if (fortresses.length) T0 = Terrain.build(obstacles);
  const villagePlan = jungle
    ? [12, 11, 10, 10, 9, 8, 8, 7, 7, 6, 6]
    : forest
      ? [15, 13, 12, 11, 10, 9, 8, 7]
      : [16, 15, 12, 10, 8, 7, 6, 6, 5];
  // Hai lượt: lượt đầu đòi đất thật phẳng; lượt sau nới điều kiện cho những
  // làng còn thiếu (map nhiều núi) để luôn đủ nhà chứa vật phẩm.
  const pending = villagePlan.map((size) => ({ size, done: false }));
  for (const [flatMax, reach] of [[5, 0.85], [8, 0.55]])
  for (const plan of pending) {
    if (plan.done) continue;
    const size = plan.size;
    const R = 18 + size * 1.6;
    for (let tries = 0; tries < 1200; tries++) {
      const x = rand(-MAP_HALF + 45, MAP_HALF - 45),
        z = rand(-MAP_HALF + 45, MAP_HALF - 45);
      if (Math.hypot(x, z) < SPAWN_CLEAR + R + 10) continue;
      if (villages.some((v) => Math.hypot(v.x - x, v.z - z) < v.R + R + 18)) continue;
      if (fortresses.some((fo) => Math.hypot(fo.x - x, fo.z - z) < fo.HALF * 1.45 + R + 8)) continue;
      if (nearWater(x, z, R * 0.8 + 6)) continue;
      if (!flatAround(x, z, R * reach, flatMax)) continue;
      villages.push({ x, z, R, size, mountain: false });
      plan.done = true;
      break;
    }
  }
  if (jungle)
    for (const plan of pending) {
      if (plan.done) continue;
      const R = 18 + plan.size * 1.6;
      for (let tries = 0; tries < 1500; tries++) {
        const x = rand(-MAP_HALF + 45, MAP_HALF - 45),
          z = rand(-MAP_HALF + 45, MAP_HALF - 45);
        if (Math.hypot(x, z) < SPAWN_CLEAR + R + 10) continue;
        if (villages.some((v) => Math.hypot(v.x - x, v.z - z) < v.R + R + 14)) continue;
        if (fortresses.some((fo) => Math.hypot(fo.x - x, fo.z - z) < fo.HALF * 1.45 + R + 8)) continue;
        if (nearWater(x, z, R * 0.8 + 6)) continue;
        const h = T0.heightAt(x, z);
        if (h > 30) continue;
        obstacles.push({ type: "plateau", x, z, r: R * 0.8, level: round(h), solid: false });
        villages.push({ x, z, R, size: plan.size, mountain: h > 8, level: h });
        plan.done = true;
        break;
      }
    }
  // Làng / điểm ngắm trên núi cao: san thành cao nguyên, có đường lên.
  const mountainSpots = jungle
    ? [{ size: 5, r: 22 }, { size: 4, r: 18 }] // xóm trên cao
    : forest
      ? [{ size: 3, r: 16 }]
      : [{ size: 7, r: 30 }, { size: 5, r: 26 }];
  for (const spot of mountainSpots) {
    for (let tries = 0; tries < 800; tries++) {
      const x = rand(-MAP_HALF + 70, MAP_HALF - 70),
        z = rand(-MAP_HALF + 70, MAP_HALF - 70);
      const h = T0.heightAt(x, z);
      if (h < (forest ? 14 : 24) || h > 48) continue;
      if (villages.some((v) => Math.hypot(v.x - x, v.z - z) < v.R + spot.r + 40)) continue;
      if (nearWater(x, z, spot.r + 20)) continue;
      const level = h * 0.92;
      obstacles.push({ type: "plateau", x, z, r: spot.r, level: round(level), solid: false });
      villages.push({ x, z, R: spot.r, size: spot.size, mountain: true, level });
      break;
    }
  }
  if (jungle || villages.some((v) => v.mountain) || fortresses.length) T0 = Terrain.build(obstacles);

  // ---------------- Đường ----------------
  const roadLines = []; // [{points, id}]
  const crossesWaterBad = (points) => {
    // Không đi qua hồ/đầm; qua sông tối đa 1 lần.
    let riverCrossings = 0,
      inRiver = false;
    for (const p of points) {
      for (const o of waters) if (o.type !== "river" && Terrain.insideWater(o, p.x, p.z, 8)) return true;
      const wet = riverLines.some((line) => polyDistance(line, p.x, p.z) < 16);
      if (wet && !inRiver) riverCrossings++;
      inRiver = wet;
    }
    return riverCrossings > 1;
  };
  const pathCost = (points, climb) => {
    let cost = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (Math.abs(p.x) > MAP_HALF - 12 || Math.abs(p.z) > MAP_HALF - 12) return Infinity;
      const h = T0.heightAt(p.x, p.z);
      if (i > 0) {
        const q = points[i - 1];
        const len = Math.hypot(p.x - q.x, p.z - q.z);
        cost += len;
        const grade = Math.abs(h - T0.heightAt(q.x, q.z)) / (len || 1);
        if (grade > 0.22) cost += (grade - 0.22) * 900;
      }
      if (!climb && h > 5) cost += (h - 5) * 25;
      for (const fo of fortresses) if (Math.hypot(p.x - fo.x, p.z - fo.z) < fo.HALF * 1.45 + 3) return Infinity;
      // Đường không chạy sát nhà làng khác (đi xuyên qua tâm làng thì được).
    }
    if (crossesWaterBad(points)) return Infinity;
    // Không chạy song song sát đường khác (cắt ngang thì được): chỗ hai đường
    // dính nhau ở hai cao độ khác nhau sẽ thành bậc trên mặt đường.
    let run = 0;
    for (let i = 3; i < points.length - 3; i++) {
      const close = roadLines.some((other) => polyDistance(other.points, points[i].x, points[i].z) < 14);
      run = close ? run + 1 : 0;
      if (run > 2) cost += 600;
    }
    // Giao cắt với đường cũ: chỉ trên đất liền.
    for (const other of roadLines)
      for (let i = 0; i < points.length - 1; i++)
        for (let j = 0; j < other.points.length - 1; j++) {
          const hit = segIntersect(points[i], points[i + 1], other.points[j], other.points[j + 1]);
          if (hit && nearWater(hit.x, hit.z, 14)) return Infinity;
        }
    return cost;
  };
  const planRoad = (a, b, climb) => {
    const dx = b.x - a.x,
      dz = b.z - a.z,
      len = Math.hypot(dx, dz);
    const nx = -dz / len,
      nz = dx / len;
    let best = null,
      bestCost = Infinity;
    for (let tries = 0; tries < (climb ? 48 : 26); tries++) {
      // Luôn cong: độ lệch tối thiểu 12% chiều dài, hai điểm điều khiển có thể
      // lệch ngược phía nhau tạo khúc chữ S.
      // Đường lên núi được phép vòng rộng hơn nhiều (đường đèo) để bớt dốc.
      const pick = () => (random() < 0.5 ? -1 : 1) * rand(0.12, climb ? 1.1 : 0.42) * len;
      const o1 = pick(),
        o2 = pick();
      const c1 = { x: a.x + dx / 3 + nx * o1, z: a.z + dz / 3 + nz * o1 };
      const c2 = { x: a.x + (2 * dx) / 3 + nx * o2, z: a.z + (2 * dz) / 3 + nz * o2 };
      const raw = bezierPath(a, c1, c2, b, 10);
      // Khúc quanh nhỏ dọc đường (biên độ 3–8 m), bằng 0 ở hai đầu để khớp tâm làng.
      const amp = rand(3, 8),
        freq = rand(2, 4),
        ph = rand(0, Math.PI * 2);
      const pts = raw.map((p, i) => {
        if (i === 0 || i === raw.length - 1) return p;
        const q = raw[Math.min(raw.length - 1, i + 1)],
          o = raw[Math.max(0, i - 1)];
        const tx = q.x - o.x,
          tz = q.z - o.z,
          tl = Math.hypot(tx, tz) || 1;
        const t = i / (raw.length - 1);
        const off = Math.sin(t * Math.PI * freq + ph) * amp * Math.sin(t * Math.PI);
        return { x: p.x - (tz / tl) * off, z: p.z + (tx / tl) * off };
      });
      let cost = pathCost(pts, climb);
      if (climb && cost < Infinity) {
        // Độ dốc trung bình cần có = chênh cao / chiều dài tuyến; phạt nặng khi > 18%.
        let pathLen = 0;
        for (let k = 1; k < pts.length; k++) pathLen += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
        const need = Math.abs(T0.heightAt(b.x, b.z) - T0.heightAt(a.x, a.z)) / (pathLen || 1);
        cost += Math.max(0, need - 0.18) * 6000;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = pts;
      }
    }
    return best && bestCost < Infinity ? best : null;
  };
  // Nối các làng: cây khung nhỏ nhất + vài đường vòng tạo giao lộ.
  const edges = [];
  for (let i = 0; i < villages.length; i++)
    for (let j = i + 1; j < villages.length; j++)
      edges.push({ i, j, d: Math.hypot(villages[i].x - villages[j].x, villages[i].z - villages[j].z) });
  edges.sort((a, b) => a.d - b.d);
  const parent = villages.map((_, i) => i);
  const findRoot = (i) => (parent[i] === i ? i : (parent[i] = findRoot(parent[i])));
  const chosen = [];
  const extra = [];
  for (const e of edges) {
    const ra = findRoot(e.i),
      rb = findRoot(e.j);
    if (ra !== rb) {
      parent[ra] = rb;
      chosen.push(e);
    } else if (extra.length < (jungle ? 9 : forest ? 3 : 4) && e.d < (jungle ? 260 : 220)) extra.push(e);
  }
  let roadId = 0;
  const addRoadLine = (points) => {
    roadId++;
    roadLines.push({ points, id: roadId });
  };
  for (const e of [...chosen, ...extra]) {
    const a = villages[e.i],
      b = villages[e.j];
    const pts = planRoad(a, b, jungle || a.mountain || b.mountain);
    if (pts) addRoadLine(pts);
  }
  // Rừng: bắt buộc có ít nhất một tuyến qua sông (bằng cầu). Nếu các làng đều
  // nằm một bờ thì dựng thêm một xóm nhỏ ở bờ bên kia rồi nối sang.
  if (forest && riverLines.length) {
    const river = riverLines[0];
    const sideOf = (p) => {
      let best = Infinity,
        sign = 1;
      for (let i = 0; i < river.length - 1; i++) {
        const a = river[i],
          b = river[i + 1];
        const d = segDistance(p.x, p.z, a.x, a.z, b.x, b.z);
        if (d < best) {
          best = d;
          sign = Math.sign((b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x)) || 1;
        }
      }
      return sign;
    };
    const crosses = (pts) => pts.some((p) => polyDistance(river, p.x, p.z) < 8);
    if (!roadLines.some((l) => crosses(l.points))) {
      const low = villages.filter((v) => !v.mountain);
      const sides = new Set(low.map(sideOf));
      if (sides.size < 2 && low.length) {
        const want = -sideOf(low[0]);
        for (let tries = 0; tries < 1500; tries++) {
          const x = rand(-MAP_HALF + 45, MAP_HALF - 45),
            z = rand(-MAP_HALF + 45, MAP_HALF - 45);
          if (sideOf({ x, z }) !== want || Math.hypot(x, z) < SPAWN_CLEAR + 30) continue;
          if (villages.some((v) => Math.hypot(v.x - x, v.z - z) < v.R + 45)) continue;
          if (nearWater(x, z, 18) || !flatAround(x, z, 12, 7)) continue;
          villages.push({ x, z, R: 20, size: 5, mountain: false });
          break;
        }
      }
      const pairs = [];
      for (const a of villages)
        for (const b of villages)
          if (!a.mountain && !b.mountain && sideOf(a) > 0 && sideOf(b) < 0)
            pairs.push([a, b, Math.hypot(a.x - b.x, a.z - b.z)]);
      pairs.sort((p, q) => p[2] - q[2]);
      for (const [a, b] of pairs) {
        const pts = planRoad(a, b, false);
        if (pts && crosses(pts)) {
          addRoadLine(pts);
          break;
        }
      }
    }
    // Thành Cổ: sông lớn cần NHIỀU cầu — thêm tuyến qua sông tới khi đủ 3.
    if (jungle) {
      const pairs = [];
      for (const a of villages)
        for (const b of villages)
          if (a !== b && !a.fortress && !b.fortress && sideOf(a) > 0 && sideOf(b) < 0) // làng trên đồi cũng được (đường đèo)
            pairs.push([a, b, Math.hypot(a.x - b.x, a.z - b.z)]);
      pairs.sort((p, q) => p[2] - q[2]);
      for (const [a, b] of pairs) {
        if (roadLines.filter((l) => crosses(l.points)).length >= 3) break;
        const pts = planRoad(a, b, true);
        // Cầu mới cách cầu cũ ≥ 45 m để các cầu rải dọc sông.
        const hit = pts && pts.find((p) => polyDistance(river, p.x, p.z) < 8);
        const far = hit && roadLines.every((l) => l.points.every((q) => polyDistance(river, q.x, q.z) >= 8 || Math.hypot(q.x - hit.x, q.z - hit.z) > 45));
        if (pts && crosses(pts) && far) addRoadLine(pts);
      }
    }
  }
  // Tách tuyến thành đoạn thẳng ~10 m (định dạng road cũ); đoạn qua sông là cầu.
  // Mặt cắt dọc của đường: bám địa hình nhưng độ dốc không vượt quá g (xẻ núi /
  // đắp nền như đường thật). Hai đầu (tâm làng) và đoạn qua sông (mặt cầu 0.3 m)
  // được giữ cố định. g tự tăng khi hai đầu chênh cao quá (đường lên núi).
  const profiled = []; // [{points, levels}] các tuyến đã tính cao độ
  const levelOnProfiled = (x, z) => {
    let best = null,
      bestD = 3; // chỗ hai đường gặp / cắt nhau phải cùng cao độ
    for (const line of profiled)
      for (let i = 0; i < line.points.length - 1; i++) {
        const a = line.points[i],
          b = line.points[i + 1];
        const vx = b.x - a.x,
          vz = b.z - a.z;
        const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / (vx * vx + vz * vz || 1)));
        const d = Math.hypot(x - (a.x + vx * t), z - (a.z + vz * t));
        if (d < bestD) {
          bestD = d;
          best = line.levels[i] + (line.levels[i + 1] - line.levels[i]) * t;
        }
      }
    return best;
  };
  const roadProfile = (points) => {
    const n = points.length;
    const dist = [0];
    for (let i = 1; i < n; i++)
      dist.push(dist[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
    const h = points.map((p) => T0.heightAt(p.x, p.z));
    const pinned = new Map([[0, h[0]], [n - 1, h[n - 1]]]);
    points.forEach((p, i) => {
      if (waters.some((o) => o.type === "river" && Terrain.insideWater(o, p.x, p.z, 1))) pinned.set(i, 0.3);
      const shared = levelOnProfiled(p.x, p.z);
      if (shared !== null) pinned.set(i, shared);
    });
    // Giao lộ thật (điểm cắt nằm giữa hai mẫu): ghim cả hai đầu đoạn về cao độ
    // của đường có trước tại điểm cắt → hai đường gặp nhau cùng mặt phẳng.
    for (let i = 0; i < n - 1; i++)
      for (const line of profiled)
        for (let j = 0; j < line.points.length - 1; j++) {
          const hit = segIntersect(points[i], points[i + 1], line.points[j], line.points[j + 1]);
          if (!hit) continue;
          const a = line.points[j],
            b = line.points[j + 1];
          const t = Math.hypot(hit.x - a.x, hit.z - a.z) / (Math.hypot(b.x - a.x, b.z - a.z) || 1);
          const level = line.levels[j] + (line.levels[j + 1] - line.levels[j]) * t;
          pinned.set(i, level);
          pinned.set(i + 1, level);
        }
    const pins = [...pinned.entries()].sort((a, b) => a[0] - b[0]);
    let g = 0.1;
    for (let k = 1; k < pins.length; k++) {
      const [ia, ha] = pins[k - 1],
        [ib, hb] = pins[k];
      g = Math.max(g, (Math.abs(hb - ha) / Math.max(1, dist[ib] - dist[ia])) * 1.15);
    }
    const lv = h.slice();
    for (const [i, v] of pins) lv[i] = v;
    for (let iter = 0; iter < 6; iter++) {
      for (let i = 1; i < n; i++) {
        const d = g * (dist[i] - dist[i - 1]);
        lv[i] = Math.min(lv[i - 1] + d, Math.max(lv[i - 1] - d, lv[i]));
        if (pinned.has(i)) lv[i] = pinned.get(i);
      }
      for (let i = n - 2; i >= 0; i--) {
        const d = g * (dist[i + 1] - dist[i]);
        lv[i] = Math.min(lv[i + 1] + d, Math.max(lv[i + 1] - d, lv[i]));
        if (pinned.has(i)) lv[i] = pinned.get(i);
      }
    }
    profiled.push({ points, levels: lv });
    return lv;
  };
  const roads = [];
  for (const line of roadLines) {
    const levels = roadProfile(line.points);
    for (let i = 0; i < line.points.length - 1; i++) {
      const a = line.points[i],
        b = line.points[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 0.5) continue;
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      let bridge = false;
      for (let t = 0; t <= 1 && !bridge; t += 0.1)
        bridge = waters.some((o) => o.type === "river" && Terrain.insideWater(o, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t));
      const road = {
        type: "road",
        roadId: line.id,
        seq: i,
        x: mid.x,
        z: mid.z,
        w: jungle ? 8 : ROAD_W,
        length: len + 0.6,
        h: 0.12,
        dirt: jungle || undefined, // Thành Cổ: đường đất đỏ (không có đường nhựa)
        yaw: Math.atan2(b.x - a.x, b.z - a.z),
        solid: false,
        bridge,
        // Cao độ mặt đường ở hai đầu đoạn (terrain.js san đất theo đúng giá trị này).
        ya: levels[i],
        yb: levels[i + 1],
      };
      roads.push(road);
      obstacles.push(road);
    }
  }
  const nearRoad = (x, z, clearance) =>
    roads.some((r) => {
      const dx = (Math.sin(r.yaw) * r.length) / 2,
        dz = (Math.cos(r.yaw) * r.length) / 2;
      return segDistance(x, z, r.x - dx, r.z - dz, r.x + dx, r.z + dz) < r.w / 2 + clearance;
    });
  // Chiếm chỗ dọc đường để không có gì mọc trên mặt đường.
  for (const r of roads) occ.add(r.x, r.z, Math.max(r.length / 2, r.w / 2) + 0.5);

  // ---------------- Rào chắn cầu ----------------
  // Lan can hai bên cầu kéo dài qua hai đầu cầu, và rào dọc bờ sông quanh cầu:
  // xe không thể lao khỏi cầu hay trượt từ đầu cầu xuống sông.
  const addFence = (ax, az, bx, bz) => {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.8) return;
    obstacles.push({
      type: "fence",
      x: (ax + bx) / 2,
      z: (az + bz) / 2,
      yaw: Math.atan2(bx - ax, bz - az),
      length: len,
      w: 0.3,
      h: 1.15,
      solid: true,
    });
  };
  for (const line of roadLines) {
    const segs = roads.filter((r) => r.roadId === line.id).sort((a, b) => a.seq - b.seq);
    let i = 0;
    while (i < segs.length) {
      if (!segs[i].bridge) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < segs.length && segs[j + 1].bridge) j++;
      // Kéo lan can thêm một đoạn ở mỗi đầu cầu.
      const run = segs.slice(Math.max(0, i - 1), Math.min(segs.length, j + 2));
      for (const s of run) {
        const c = Math.cos(s.yaw),
          sn = Math.sin(s.yaw);
        const hx = (sn * s.length) / 2,
          hz = (c * s.length) / 2;
        for (const side of [-1, 1]) {
          const ox = c * side * (s.w / 2 - 0.2),
            oz = -sn * side * (s.w / 2 - 0.2);
          addFence(s.x - hx + ox, s.z - hz + oz, s.x + hx + ox, s.z + hz + oz);
        }
      }
      // Rào dọc bờ sông hai bên đường, trong phạm vi ~16 m quanh cầu.
      const mid = segs[Math.floor((i + j) / 2)];
      for (const riverLine of riverLines) {
        for (const bankSide of [-1, 1]) {
          const bank = [];
          for (let k = 0; k < riverLine.length - 1; k++) {
            const p = riverLine[k],
              q = riverLine[k + 1];
            const yaw = Math.atan2(q.x - p.x, q.z - p.z);
            const off = 12;
            const bp = { x: p.x + Math.cos(yaw) * bankSide * off, z: p.z - Math.sin(yaw) * bankSide * off };
            bank.push(bp);
          }
          for (let k = 0; k < bank.length - 1; k++) {
            const p = bank[k],
              q = bank[k + 1];
            const d = Math.hypot((p.x + q.x) / 2 - mid.x, (p.z + q.z) / 2 - mid.z);
            if (d > 30) continue;
            // Chia nhỏ để chừa đúng lòng đường cho xe đi.
            const parts = 6;
            for (let n = 0; n < parts; n++) {
              const ax = p.x + ((q.x - p.x) * n) / parts,
                az = p.z + ((q.z - p.z) * n) / parts;
              const bx = p.x + ((q.x - p.x) * (n + 1)) / parts,
                bz = p.z + ((q.z - p.z) * (n + 1)) / parts;
              if (nearRoad((ax + bx) / 2, (az + bz) / 2, 1.8)) continue;
              if (Math.hypot((ax + bx) / 2 - mid.x, (az + bz) / 2 - mid.z) > 24) continue;
              addFence(ax, az, bx, bz);
              occ.add((ax + bx) / 2, (az + bz) / 2, 1.4);
            }
          }
        }
      }
      i = j + 1;
    }
  }

  // ---------------- Nhà trong làng ----------------
  const houses = [];
  // Thành Cổ: nhà sàn — sàn cao STILT_LIFT m trên cột, cầu thang dốc trước cửa.
  const STILT_LIFT = 1.8, // đủ cao để NGỒI / NẰM chui qua gầm (đứng thẳng thì vướng sàn)
    STILT_RAMP = 3.4;
  const tryHouse = (x, z, yaw, hut, village) => {
    const stilt = jungle && !village.fortress;
    const w = hut ? rand(4.8, 6) : rand(6.6, 8.4);
    const r = w * 0.72 + 1.2 + (stilt ? STILT_RAMP * 0.6 : 0);
    if (Math.abs(x) > MAP_HALF - 12 || Math.abs(z) > MAP_HALF - 12) return false;
    if (!occ.free(x, z, r)) return false;
    if (nearRoad(x, z, w * 0.72 + 1.5)) return false;
    if (stilt) {
      // Chân cầu thang (trước cửa, mặt -Z) phải trống, không đè lên đường.
      const fx = x - Math.sin(yaw) * (w / 2 + STILT_RAMP),
        fz = z - Math.cos(yaw) * (w / 2 + STILT_RAMP);
      if (nearRoad(fx, fz, 0.8) || nearWater(fx, fz, 2)) return false;
      // Chân cầu thang phải gần cùng cao độ nền nhà — trên sườn dốc, cầu thang
      // từng treo lơ lửng như cây cầu hoặc cắm xuống đất như cửa sập.
      if (Math.abs(T0.heightAt(fx, fz) - T0.heightAt(x, z)) > 1.5) return false;
    }
    if (nearWater(x, z, w + 4)) return false;
    // Nền nhà phải khá bằng (không dựng nhà treo lưng chừng vách núi).
    const h0 = T0.heightAt(x, z);
    if (!village.mountain && !flatAround(x, z, w * 0.7, h0 + 2.5)) return false;
    if (village.mountain && Math.hypot(x - village.x, z - village.z) > village.R - w * 0.6) return false;
    const house = {
      type: hut ? "hut" : "house",
      x,
      z,
      w,
      h: hut ? rand(3, 3.8) : rand(4.2, 5.4),
      yaw,
      solid: true,
      lift: stilt ? STILT_LIFT : undefined,
    };
    obstacles.push(house);
    // Nhà sàn: nền san phẳng phủ cả cầu thang trước cửa (chân thang chạm đất).
    obstacles.push({ type: "pad", x, z, r: stilt ? w / 2 + STILT_RAMP + 0.8 : w * 0.75 + 0.6, solid: false });
    houses.push(house);
    occ.add(x, z, r);
    return true;
  };
  const faceYaw = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z)); // cửa (mặt -Z) nhìn về điểm đích
  for (const v of villages) {
    let made = 0;
    // Dãy nhà hai bên các đoạn đường chạy qua làng, cửa quay ra đường.
    const local = roads.filter((r) => Math.hypot(r.x - v.x, r.z - v.z) < v.R);
    for (const r of local) {
      if (made >= v.size) break;
      const c = Math.cos(r.yaw),
        s = Math.sin(r.yaw);
      for (const side of [-1, 1]) {
        if (made >= v.size) break;
        const hut = random() < 0.35;
        // Nửa đường chéo nhà (≤ 0.72·w) + khoảng lề 2.3 m tới mép đường.
        const back = r.w / 2 + (hut ? 6 : 8.4) * 0.72 + 2.3 + rand(0, 1.2) + (jungle ? STILT_RAMP : 0);
        const x = r.x + c * side * back,
          z = r.z - s * side * back;
        if (tryHouse(x, z, faceYaw(x, z, r.x, r.z) + rand(-0.08, 0.08), hut, v)) made++;
      }
    }
    // Hàng nhà phía sau / quanh quảng trường, quay về tâm làng.
    for (let tries = 0; tries < 160 && made < v.size; tries++) {
      const a = rand(0, Math.PI * 2),
        d = rand(10, v.R);
      const x = v.x + Math.cos(a) * d,
        z = v.z + Math.sin(a) * d;
      if (tryHouse(x, z, faceYaw(x, z, v.x, v.z) + rand(-0.25, 0.25), random() < 0.4, v)) made++;
    }
  }
  for (const fo of fortresses) {
    const { x, z, yaw, HALF } = fo;
    const c = Math.cos(yaw),
      sn = Math.sin(yaw);
    const W = (lx, lz) => ({ x: x + c * lx + sn * lz, z: z - sn * lx + c * lz });
    const wall = (ax, az, bx, bz) => {
      const a = W(ax, az),
        b = W(bx, bz);
      obstacles.push({
        type: "stonewall",
        x: (a.x + b.x) / 2,
        z: (a.z + b.z) / 2,
        yaw: Math.atan2(b.x - a.x, b.z - a.z),
        length: Math.hypot(b.x - a.x, b.z - a.z),
        w: 1.6,
        h: 5.2,
        solid: true,
      });
    };
    const GATE = 3.6;
    wall(-HALF, HALF, HALF, HALF); // tường sau
    wall(-HALF, -HALF, -HALF, HALF); // hai tường bên
    wall(HALF, -HALF, HALF, HALF);
    wall(-HALF, -HALF, -GATE, -HALF); // tường trước, chừa cổng
    wall(GATE, -HALF, HALF, -HALF);
    for (const [lx, lz] of [[-HALF, -HALF], [HALF, -HALF], [-HALF, HALF], [HALF, HALF]]) {
      const p = W(lx, lz);
      obstacles.push({ type: "tower", x: p.x, z: p.z, w: 6, h: 9.5, yaw: 0, solid: true });
    }
    // THÀNH CHÍNH (keep): pháo đài đá 2 tầng + sân thượng giữa sân, lùi về
    // phía sau để trước cửa có sân rộng; cửa chính quay ra cổng thành.
    // Hình học chi tiết: public/structures.js (dùng chung server + client).
    const kp = W(0, 4);
    obstacles.push({ type: "keep", x: kp.x, z: kp.z, w: 16, h: 9.8, yaw, solid: true });
    occ.add(x, z, HALF * 1.45 + 4);
  }
  if (process.env.MAPGEN_DEBUG) console.log("villages", villages.map((v) => `${v.mountain ? "M" : ""}${v.size}:${houses.filter((h) => Math.hypot(h.x - v.x, h.z - v.z) < v.R + 10).length}`).join(" "), "roads", roadLines.length);
  // Vài căn chòi lẻ ven đường ngoài làng.
  for (let tries = 0, made = 0; tries < 300 && made < (forest ? 6 : 8) && roads.length; tries++) {
    const r = roads[Math.floor(random() * roads.length)];
    if (r.bridge) continue;
    const side = random() < 0.5 ? -1 : 1;
    const back = r.w / 2 + 6 * 0.72 + 2.3 + (jungle ? STILT_RAMP : 0);
    const x = r.x + Math.cos(r.yaw) * side * back,
      z = r.z - Math.sin(r.yaw) * side * back;
    if (tryHouse(x, z, faceYaw(x, z, r.x, r.z), true, { mountain: false })) made++;
  }

  // ---------------- Cây, đá, xương rồng ----------------
  const T1 = Terrain.build(obstacles);
  const scatterOk = (x, z, r, maxH, maxSlope) => {
    if (Math.abs(x) > MAP_HALF - 3 || Math.abs(z) > MAP_HALF - 3) return false;
    if (!occ.free(x, z, r)) return false;
    if (nearWater(x, z, r + 2)) return false;
    if (nearRoad(x, z, r + 1.5)) return false;
    const h = T1.heightAt(x, z);
    if (h > maxH) return false;
    return T1.slopeAt(x, z) <= maxSlope;
  };
  const place = (type, x, z, w, h, footprint) => {
    obstacles.push({ type, x, z, w, h, yaw: rand(0, Math.PI * 2), solid: true, variant: Math.floor(random() * 4) });
    occ.add(x, z, footprint);
  };
  const farFromVillages = (x, z, pad) => villages.every((v) => Math.hypot(v.x - x, v.z - z) > v.R + pad);
  if (jungle) {
    // RỪNG RẬM NHIỆT ĐỚI: chỉ cây lá rộng (variant 2–3, không có cây thông),
    // mọc dày thành từng mảng lớn phủ cả sườn núi.
    const broadleaf = (x, z, w, h) => {
      obstacles.push({ type: "tree", x, z, w, h, yaw: rand(0, Math.PI * 2), solid: true, variant: 2 + Math.floor(random() * 2) });
      occ.add(x, z, w * 1.1);
    };
    for (let g = 0; g < 24; g++) {
      let cx = 0,
        cz = 0,
        ok = false;
      for (let tries = 0; tries < 200 && !ok; tries++) {
        cx = rand(-MAP_HALF + 15, MAP_HALF - 15);
        cz = rand(-MAP_HALF + 15, MAP_HALF - 15);
        ok = Math.hypot(cx, cz) > 45 && T1.heightAt(cx, cz) < 38 && !nearWater(cx, cz, 5) && farFromVillages(cx, cz, 10);
      }
      if (!ok) continue;
      const R = rand(24, 44);
      for (let n = 0; n < R * 2.2; n++) {
        const a = rand(0, Math.PI * 2),
          d = Math.sqrt(random()) * R;
        const x = cx + Math.cos(a) * d,
          z = cz + Math.sin(a) * d;
        const tall = random();
        const w = 0.8 + tall * 0.7;
        const h = 5 + tall * tall * 11 + rand(0, 1.5);
        if (scatterOk(x, z, w * 1.05, 42, 0.85)) broadleaf(x, z, w, h);
      }
    }
    for (let n = 0, tries = 0; n < 320 && tries < 4000; tries++) {
      const x = rand(-MAP_HALF, MAP_HALF),
        z = rand(-MAP_HALF, MAP_HALF);
      const w = rand(0.8, 1.3),
        h = rand(5, 12);
      if (scatterOk(x, z, w * 1.2, 40, 0.8) && Math.hypot(x, z) > SPAWN_CLEAR + 4) {
        broadleaf(x, z, w, h);
        n++;
      }
    }
    // KHU CÂY CHUỐI: từng vườn chuối dày ven làng / đất thấp.
    for (let g = 0, tries = 0; g < 12 && tries < 400; tries++) {
      const v = villages[Math.floor(random() * villages.length)];
      const a0 = rand(0, Math.PI * 2);
      const cx = v ? v.x + Math.cos(a0) * (v.R + rand(8, 22)) : rand(-150, 150),
        cz = v ? v.z + Math.sin(a0) * (v.R + rand(8, 22)) : rand(-150, 150);
      if (T1.heightAt(cx, cz) > 16 || nearWater(cx, cz, 4)) continue;
      g++;
      const R = rand(8, 14);
      for (let n = 0; n < R * 2.6; n++) {
        const a = rand(0, Math.PI * 2),
          d = Math.sqrt(random()) * R;
        const x = cx + Math.cos(a) * d,
          z = cz + Math.sin(a) * d;
        if (scatterOk(x, z, 0.9, 18, 0.5)) place("banana", x, z, rand(0.9, 1.3), rand(3, 4.6), 0.9);
      }
    }
    // Dừa ven sông / đầm.
    for (let n = 0, tries = 0; n < 90 && tries < 3000; tries++) {
      const line = riverLines[0];
      if (!line) break;
      const p = line[Math.floor(random() * line.length)];
      const a = rand(0, Math.PI * 2),
        d = rand(14, 26);
      const x = p.x + Math.cos(a) * d,
        z = p.z + Math.sin(a) * d;
      if (scatterOk(x, z, 1, 12, 0.5)) {
        place("palm", x, z, rand(0.8, 1.1), rand(7, 11), 1);
        n++;
      }
    }
    for (const sw of waters.filter((o) => o.type === "swamp"))
      for (let n = 0; n < 12; n++) {
        const a = rand(0, Math.PI * 2);
        const x = sw.x + Math.cos(a) * sw.w * rand(0.25, 0.85),
          z = sw.z + Math.sin(a) * sw.length * rand(0.25, 0.85);
        if (occ.free(x, z, 1.2)) place("deadTree", x, z, rand(0.6, 0.9), rand(3, 5.5), 1.2);
      }
    for (let n = 0, tries = 0; n < 70 && tries < 2500; tries++) {
      const x = rand(-MAP_HALF, MAP_HALF),
        z = rand(-MAP_HALF, MAP_HALF);
      const big = random() < 0.3;
      const w = big ? rand(3.5, 7) : rand(1.2, 3);
      if (scatterOk(x, z, w * 0.6, 44, 0.9) && Math.hypot(x, z) > SPAWN_CLEAR + 4) {
        place("rock", x, z, w, big ? rand(2.5, 5) : rand(0.9, 2.6), w * 0.6);
        n++;
      }
    }
  } else if (forest) {
    // Rừng gom cụm: nhiều cây cao thấp khác nhau đứng dày.
    const groves = 14;
    for (let g = 0; g < groves; g++) {
      let cx = 0,
        cz = 0,
        ok = false;
      for (let tries = 0; tries < 200 && !ok; tries++) {
        cx = rand(-MAP_HALF + 20, MAP_HALF - 20);
        cz = rand(-MAP_HALF + 20, MAP_HALF - 20);
        ok = Math.hypot(cx, cz) > 50 && T1.heightAt(cx, cz) < 26 && !nearWater(cx, cz, 6) && villages.every((v) => Math.hypot(v.x - cx, v.z - cz) > v.R + 12);
      }
      if (!ok) continue;
      const R = rand(22, 42);
      for (let n = 0; n < R * 2.4; n++) {
        const a = rand(0, Math.PI * 2),
          d = Math.sqrt(random()) * R;
        const x = cx + Math.cos(a) * d,
          z = cz + Math.sin(a) * d;
        const tall = random();
        const w = 0.7 + tall * 0.6;
        const h = 4 + tall * tall * 10 + rand(0, 1.5);
        if (scatterOk(x, z, w * 1.1, 34, 0.75)) place("tree", x, z, w, h, w * 1.1);
      }
    }
    // Cây lẻ rải khắp map và trên sườn núi thấp.
    for (let n = 0, tries = 0; n < 260 && tries < 3000; tries++) {
      const x = rand(-MAP_HALF, MAP_HALF),
        z = rand(-MAP_HALF, MAP_HALF);
      const w = rand(0.7, 1.2),
        h = rand(4, 11);
      if (scatterOk(x, z, w * 1.3, 30, 0.7) && Math.hypot(x, z) > SPAWN_CLEAR + 4) {
        place("tree", x, z, w, h, w * 1.3);
        n++;
      }
    }
    // Cây chết + đá lớn quanh đầm lầy và chân núi.
    for (const s of waters.filter((o) => o.type === "swamp"))
      for (let n = 0; n < 10; n++) {
        const a = rand(0, Math.PI * 2);
        const x = s.x + Math.cos(a) * s.w * rand(0.2, 0.8),
          z = s.z + Math.sin(a) * s.length * rand(0.2, 0.8);
        if (occ.free(x, z, 1.2)) place("deadTree", x, z, rand(0.6, 0.9), rand(3, 5.5), 1.2);
      }
    for (let n = 0, tries = 0; n < 130 && tries < 3000; tries++) {
      const x = rand(-MAP_HALF, MAP_HALF),
        z = rand(-MAP_HALF, MAP_HALF);
      const big = random() < 0.25;
      const w = big ? rand(3.5, 7) : rand(1.2, 3);
      const h = big ? rand(2.5, 5) : rand(0.9, 2.6);
      if (scatterOk(x, z, w * 0.6, 40, 0.9) && Math.hypot(x, z) > SPAWN_CLEAR + 4) {
        place("rock", x, z, w, h, w * 0.6);
        n++;
      }
    }
  } else {
    // Mỏm đá lớn rải khắp sa mạc, kèm đá vụn quanh chân.
    for (let n = 0, tries = 0; n < 70 && tries < 4000; tries++) {
      const x = rand(-MAP_HALF, MAP_HALF),
        z = rand(-MAP_HALF, MAP_HALF);
      const w = rand(5, 12),
        h = rand(3.5, 9);
      if (scatterOk(x, z, w * 0.6, 45, 0.8) && Math.hypot(x, z) > SPAWN_CLEAR + 8) {
        place("rock", x, z, w, h, w * 0.6);
        n++;
        for (let k = 0; k < 3; k++) {
          const a = rand(0, Math.PI * 2),
            d = w * 0.6 + rand(1.5, 4);
          const rx = x + Math.cos(a) * d,
            rz = z + Math.sin(a) * d;
          const rw = rand(1.2, 2.6);
          if (scatterOk(rx, rz, rw * 0.6, 45, 0.9)) place("rock", rx, rz, rw, rand(0.8, 1.8), rw * 0.6);
        }
      }
    }
    for (let n = 0, tries = 0; n < 190 && tries < 4000; tries++) {
      const x = rand(-MAP_HALF, MAP_HALF),
        z = rand(-MAP_HALF, MAP_HALF);
      const w = rand(0.6, 1.1);
      if (scatterOk(x, z, w * 0.9, 20, 0.45) && Math.hypot(x, z) > SPAWN_CLEAR + 3) {
        place("cactus", x, z, w, rand(2.2, 4.6), w * 0.9);
        n++;
      }
    }
    for (let n = 0, tries = 0; n < 45 && tries < 2000; tries++) {
      const x = rand(-MAP_HALF, MAP_HALF),
        z = rand(-MAP_HALF, MAP_HALF);
      if (scatterOk(x, z, 1, 20, 0.45) && Math.hypot(x, z) > SPAWN_CLEAR + 3) {
        place("deadTree", x, z, rand(0.6, 1), rand(3, 5.5), 1);
        n++;
      }
    }
  }
  // Làm tròn để gói gửi client gọn; cả hai phía dùng CÙNG giá trị đã làm tròn.
  for (const o of obstacles)
    for (const key of ["x", "z", "w", "h", "length", "r", "level", "depth", "ya", "yb"])
      if (typeof o[key] === "number") o[key] = round(o[key]);
  for (const o of obstacles) if (typeof o.yaw === "number") o.yaw = round(o.yaw, 1000);
  return obstacles;
}

module.exports = { createObstacles };
