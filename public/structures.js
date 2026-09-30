// Hình học công trình dùng chung SERVER (require) và CLIENT (<script> →
// window.LDStructures): nhà sàn và thành chính (keep) của map Thành Cổ.
// Một nguồn duy nhất cho: mặt đứng được (sàn, cầu thang), va chạm, khối chặn
// đạn và hình vẽ → đi / đứng / bắn / nhìn luôn khớp nhau ở hai phía.
//
// Toạ độ CỤC BỘ của công trình: (lx, lz) đã xoay theo o.yaw, cửa chính ở mặt
// -Z; độ cao tính từ mặt đất tại tâm công trình (ground).
(function (root) {
  const toLocal = (o, x, z) => {
    const dx = x - o.x,
      dz = z - o.z;
    const c = Math.cos(o.yaw || 0),
      s = Math.sin(o.yaw || 0);
    return [c * dx - s * dz, s * dx + c * dz];
  };
  const toWorld = (o, lx, lz) => {
    const c = Math.cos(o.yaw || 0),
      s = Math.sin(o.yaw || 0);
    return [o.x + c * lx + s * lz, o.z - s * lx + c * lz];
  };

  // ======================= NHÀ SÀN =======================
  // Sàn cao o.lift, cầu thang dốc dài STILT_RAMP trước cửa. Gầm: 9 cột gỗ —
  // ngồi / nằm chui qua được (chỉ vướng cột), đứng thẳng thì vướng sàn.
  const STILT_RAMP = 3.4;
  const STILT_POST = 0.12; // nửa bề rộng cột
  const STILT_RAMP_HALF = 0.95; // nửa bề rộng cầu thang (tay vịn nằm ở ±0.95)
  const RAIL = 0.05;
  const stiltPosts = (o) => {
    const e = (o.w / 2) * 0.96;
    const out = [];
    for (const px of [-e, 0, e]) for (const pz of [-e, 0, e]) out.push([px, pz]);
    return out;
  };
  function stiltSurfaces(o, ground, lx, lz, out) {
    const half = o.w / 2,
      floor = ground + o.lift;
    if (Math.abs(lx) <= half && Math.abs(lz) <= half)
      out.push({ height: floor + 0.08, base: floor - 1, type: "floor", obstacle: o });
    if (Math.abs(lx) <= 0.95 && lz < -half && lz >= -half - STILT_RAMP) {
      const t = (lz + half + STILT_RAMP) / STILT_RAMP; // 0 = chân thang, 1 = đỉnh
      const h = ground + o.lift * t + 0.05;
      out.push({ height: h, base: h - 1, type: "ramp", obstacle: o });
    }
  }
  // rel = độ cao chân người so với mặt đất công trình (null = xe).
  // Trả về: true (chặn) / false (không chặn) / null (đang ở trên sàn → xét
  // tường như nhà thường).
  function stiltBlocked(o, lx, lz, r, rel, low) {
    const half = o.w / 2;
    // Cầu thang trước cửa: chỉ lên / xuống từ ĐẦU thang. Hai bên có tay vịn,
    // phía dưới tấm ván là khung thang → đi ngang từ bên cạnh không xuyên qua được.
    const foot = -half - STILT_RAMP;
    if (Math.abs(lx) < STILT_RAMP_HALF + RAIL + r && lz > foot - r && lz < -half + 0.05) {
      if (rel === null) return true; // xe
      const t = Math.max(0, Math.min(1, (lz - foot) / STILT_RAMP));
      const surface = o.lift * t;
      if (rel < surface - 0.45) return true; // chui / đi xuyên thân thang
      // Đang ở trên mặt ván: tay vịn hai bên chặn bước ra / vào từ cạnh.
      if (Math.abs(Math.abs(lx) - STILT_RAMP_HALF) < RAIL + r && lz > foot + 0.1) return true;
    }
    if (rel !== null && rel >= o.lift - 0.45) return null;
    if (Math.abs(lx) >= half + r || Math.abs(lz) >= half + r) return false;
    if (rel === null || !low) return true; // xe / người đứng thẳng: vướng sàn
    for (const [px, pz] of stiltPosts(o))
      if (Math.abs(lx - px) < STILT_POST + r && Math.abs(lz - pz) < STILT_POST + r) return true;
    return false;
  }
  // Người ở dưới gầm sàn (để client buộc ngồi, không cho đứng dậy đội sàn).
  function underStiltFloor(o, lx, lz, rel) {
    return Math.abs(lx) < o.w / 2 && Math.abs(lz) < o.w / 2 && rel < o.lift - 0.45;
  }
  // Khối chặn đạn nhà sàn phần gầm: tấm sàn + cột (tường phía trên do game xử lý).
  function stiltBulletBoxes(o) {
    const half = o.w / 2,
      L = o.lift;
    const boxes = [{ x: 0, y: L - 0.02, z: 0, hx: half + 0.15, hy: 0.1, hz: half + 0.15 }];
    for (const [px, pz] of stiltPosts(o)) boxes.push({ x: px, y: L / 2, z: pz, hx: STILT_POST, hy: L / 2, hz: STILT_POST });
    return boxes;
  }

  // ======================= THÀNH CHÍNH (KEEP) =======================
  // 16×16 m, tường đá dày 0.8 m, 2 tầng (sàn 0 và 4.2 m) + sân thượng 8.4 m có
  // lan can răng cưa. Mỗi mặt mỗi tầng 2 cửa sổ bắn; cửa chính mặt -Z tầng trệt.
  // Cầu thang đá (khối nêm đặc) nối các tầng qua lỗ sàn; cột đá làm chỗ nấp.
  const K = {
    half: 8,
    wall: 0.8,
    levels: [0, 4.2],
    roof: 8.4,
    slab: 0.3,
    doorHalf: 1.3,
    doorH: 2.8,
    sill: 1.2,
    winTop: 2.8,
    windows: [-4.2, 4.2],
    winHalf: 0.7,
    parapet: 0.8,
    merlon: 0.6,
  };
  const INNER = K.half - K.wall; // 7.2
  // Mặt trên của sàn từng tầng (so với mặt đất).
  const floorTop = (level) => (level === 0 ? 0.1 : level + K.slab / 2);
  const ROOF_TOP = K.roof + K.slab / 2;
  // Cầu thang: nêm đặc từ sàn dưới lên sàn trên.
  const RAMPS = [
    { x0: -INNER, x1: -INNER + 1.8, z0: -3.8, z1: 4.6, from: floorTop(0), to: floorTop(4.2), dir: 1 },
    { x0: INNER - 1.8, x1: INNER, z0: -4.6, z1: 3.8, from: floorTop(4.2), to: ROOF_TOP, dir: -1 },
  ];
  // Lỗ ở sàn trên đúng chỗ cầu thang đi lên.
  const HOLES = { 4.2: RAMPS[0], [K.roof]: RAMPS[1] };
  // Lan can: dọc mép hở của cầu thang (phía trong phòng) và quanh lỗ sàn phía
  // trên, để không đi sát mép rồi rơi xuống. axis "x": thanh chạy dọc trục z tại
  // lx = at; axis "z": chạy dọc trục x tại lz = at. lo..hi: độ cao chân bị chặn.
  const RAILS = [
    { axis: "x", at: RAMPS[0].x1, from: RAMPS[0].z0, to: RAMPS[0].z1, lo: 0.5, hi: floorTop(4.2) + 1.3, ramp: RAMPS[0] },
    { axis: "z", at: RAMPS[0].z0, from: RAMPS[0].x0, to: RAMPS[0].x1, lo: floorTop(4.2) - 0.3, hi: floorTop(4.2) + 1.3, floor: floorTop(4.2) },
    { axis: "x", at: RAMPS[1].x0, from: RAMPS[1].z0, to: RAMPS[1].z1, lo: floorTop(4.2) + 0.45, hi: ROOF_TOP + 1.3, ramp: RAMPS[1] },
    { axis: "z", at: RAMPS[1].z1, from: RAMPS[1].x0, to: RAMPS[1].x1, lo: ROOF_TOP - 0.3, hi: ROOF_TOP + 1.3, floor: ROOF_TOP },
  ];
  const RAIL_HALF = 0.06;
  // Chân lan can tại vị trí u dọc thanh (độ cao so với mặt đất).
  const railBase = (rail, u) => (rail.ramp ? Math.max(rail.floorBase ?? 0, rampHeight(rail.ramp, u)) : rail.floor);
  const inRect = (lx, lz, r, m = 0) => lx >= r.x0 - m && lx <= r.x1 + m && lz >= r.z0 - m && lz <= r.z1 + m;
  const rampHeight = (r, lz) => {
    const t = r.dir > 0 ? (lz - r.z0) / (r.z1 - r.z0) : (r.z1 - lz) / (r.z1 - r.z0);
    return r.from + (r.to - r.from) * Math.max(0, Math.min(1, t));
  };
  // Cột đá nấp (mỗi tầng dưới 2 cột), toạ độ cục bộ + tầng.
  const PILLARS = [
    { x: -2.6, z: 1.2, level: 0 },
    { x: 2.6, z: 1.2, level: 0 },
    { x: -2.2, z: -2.4, level: 4.2 },
    { x: 1.6, z: -2.4, level: 4.2 },
  ];
  const PILLAR_HALF = 0.55;

  function keepSurfaces(o, ground, lx, lz, out) {
    if (Math.abs(lx) > INNER || Math.abs(lz) > INNER) {
      // Sân thượng phủ ra tới mép ngoài tường (đứng sát lan can).
      if (Math.abs(lx) <= K.half && Math.abs(lz) <= K.half)
        out.push({ height: ground + ROOF_TOP, base: ground + ROOF_TOP - 1, type: "keepRoof", obstacle: o });
      return;
    }
    out.push({ height: ground + floorTop(0), base: ground - 0.9, type: "keepFloor", obstacle: o });
    for (const level of [4.2, K.roof]) {
      if (inRect(lx, lz, HOLES[level])) continue;
      const h = ground + (level === K.roof ? ROOF_TOP : floorTop(level));
      out.push({ height: h, base: h - 1, type: "keepFloor", obstacle: o });
    }
    for (const r of RAMPS)
      if (inRect(lx, lz, r)) {
        const h = ground + rampHeight(r, lz);
        out.push({ height: h, base: h - 1, type: "ramp", obstacle: o });
      }
  }
  // Va chạm di chuyển. rel = độ cao chân so với mặt đất (null = xe).
  function keepBlocked(o, lx, lz, r, rel) {
    const ax = Math.abs(lx),
      az = Math.abs(lz);
    if (ax >= K.half + r || az >= K.half + r) return false;
    const inWallBand = ax > INNER - r || az > INNER - r;
    if (inWallBand) {
      // Cửa chính: chỉ ở tầng trệt, mặt -Z, đủ rộng cho người (xe không lọt).
      const door = rel !== null && rel < 2 && lz < 0 && az > INNER - r && ax < K.doorHalf - r * 0.3;
      if (!door) return true;
    }
    if (rel === null) return false;
    for (const rail of RAILS) {
      const along = rail.axis === "x" ? lz : lx,
        across = rail.axis === "x" ? lx : lz;
      if (along < rail.from - r || along > rail.to + r || Math.abs(across - rail.at) >= RAIL_HALF + r) continue;
      if (rel >= rail.lo && rel <= rail.hi) return true;
    }
    // Cầu thang là khối nêm đặc: chặn khi đứng thấp hơn mặt thang tại đó.
    for (const ramp of RAMPS) {
      if (!inRect(lx, lz, ramp, r)) continue;
      const surface = rampHeight(ramp, Math.max(ramp.z0, Math.min(ramp.z1, lz)));
      if (rel >= ramp.from - 0.3 && rel < surface - 0.45) return true;
    }
    for (const p of PILLARS) {
      const top = p.level === 0 ? floorTop(4.2) : ROOF_TOP;
      if (rel < floorTop(p.level) - 0.3 || rel > top - 0.5) continue;
      if (Math.abs(lx - p.x) < PILLAR_HALF + r && Math.abs(lz - p.z) < PILLAR_HALF + r) return true;
    }
    return false;
  }
  // Danh sách khối hộp (cục bộ, y tính từ mặt đất) — dùng để VẼ và CHẶN ĐẠN.
  // kind: wall | slab | parapet | merlon | pillar
  function keepParts(o) {
    const parts = [];
    const H = K.half,
      T = K.wall;
    // Một đoạn tường dọc cạnh: u0..u1 dọc cạnh, y0..y1 cao.
    const seg = (side, u0, u1, y0, y1, kind = "wall") => {
      if (u1 - u0 < 0.05 || y1 - y0 < 0.05) return;
      const n = H - T / 2;
      const cu = (u0 + u1) / 2,
        hu = (u1 - u0) / 2;
      const cy = (y0 + y1) / 2,
        hy = (y1 - y0) / 2;
      // side: 0 = -Z (mặt trước), 1 = +Z, 2 = -X, 3 = +X
      if (side < 2) parts.push({ x: cu, y: cy, z: side === 0 ? -n : n, hx: hu, hy, hz: T / 2, kind });
      else parts.push({ x: side === 2 ? -n : n, y: cy, z: cu, hx: T / 2, hy, hz: hu, kind });
    };
    const winU = K.windows.flatMap((c) => [c - K.winHalf, c + K.winHalf]); // [-4.9,-3.5,3.5,4.9]
    for (let side = 0; side < 4; side++)
      for (const L of K.levels) {
        const door = side === 0 && L === 0;
        // Bệ cửa sổ (dưới), lanh tô (trên), trụ giữa các cửa sổ.
        if (door) {
          seg(side, -H, -K.doorHalf, L, L + K.sill);
          seg(side, K.doorHalf, H, L, L + K.sill);
        } else seg(side, -H, H, L, L + K.sill);
        seg(side, -H, H, L + K.winTop, L + 4.2);
        const cuts = door ? [-H, winU[0], winU[1], -K.doorHalf, K.doorHalf, winU[2], winU[3], H] : [-H, winU[0], winU[1], winU[2], winU[3], H];
        for (let i = 0; i < cuts.length; i += 2) seg(side, cuts[i], cuts[i + 1], L + K.sill, L + K.winTop);
        if (door) seg(side, -K.doorHalf, K.doorHalf, K.doorH, L + K.winTop); // khung trên cửa
      }
    // Lan can sân thượng + răng cưa.
    for (let side = 0; side < 4; side++) {
      seg(side, -H, H, K.roof, K.roof + K.parapet, "parapet");
      for (let u = -H + 0.5; u < H - 0.4; u += 1.6) seg(side, u, u + 0.8, K.roof + K.parapet, K.roof + K.parapet + K.merlon, "merlon");
    }
    // Sàn tầng trên và mái (trừ lỗ cầu thang).
    for (const level of [4.2, K.roof]) {
      const hole = HOLES[level];
      const y0 = level - K.slab / 2,
        y1 = level + K.slab / 2;
      const E = level === K.roof ? H : INNER;
      const rects = [
        [hole.x1 <= 0 ? hole.x1 : -E, hole.x1 <= 0 ? E : hole.x0, -E, E],
        [hole.x0, hole.x1, -E, hole.z0],
        [hole.x0, hole.x1, hole.z1, E],
      ];
      for (const [x0, x1, z0, z1] of rects)
        if (x1 - x0 > 0.05 && z1 - z0 > 0.05)
          parts.push({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2, hx: (x1 - x0) / 2, hy: (y1 - y0) / 2, hz: (z1 - z0) / 2, kind: "slab" });
    }
    parts.push({ x: 0, y: 0.05, z: 0, hx: INNER, hy: 0.05, hz: INNER, kind: "floor" });
    for (const p of PILLARS) {
      const top = p.level === 0 ? 4.2 - K.slab / 2 : K.roof - K.slab / 2;
      const bottom = p.level === 0 ? 0 : 4.2 + K.slab / 2;
      parts.push({ x: p.x, y: (bottom + top) / 2, z: p.z, hx: PILLAR_HALF, hy: (top - bottom) / 2, hz: PILLAR_HALF, kind: "pillar" });
    }
    return parts;
  }
  // Điểm (cục bộ, ry = độ cao so với mặt đất) nằm trong khối nêm cầu thang?
  function keepRampSolid(lx, ry, lz) {
    for (const r of RAMPS)
      if (inRect(lx, lz, r) && ry >= r.from - 0.1 && ry < rampHeight(r, lz) - 0.02) return true;
    return false;
  }
  // Ô đặt đồ (loot) trên từng tầng: tránh cầu thang, cột, lối cửa.
  function keepLootSlots() {
    const slots = [];
    for (const [level, top] of [[0, floorTop(0)], [4.2, floorTop(4.2)], [K.roof, ROOF_TOP]])
      for (let lx = -INNER + 1; lx <= INNER - 1; lx += 1.6)
        for (let lz = -INNER + 1; lz <= INNER - 1; lz += 1.6) {
          if (RAMPS.some((r) => inRect(lx, lz, r, 0.8))) continue;
          if (level !== K.roof && PILLARS.some((p) => p.level === level && Math.abs(lx - p.x) < 1.3 && Math.abs(lz - p.z) < 1.3)) continue;
          if (level === 0 && lz < -INNER + 2.2 && Math.abs(lx) < 2) continue; // lối vào
          slots.push({ lx, lz, y: top, level });
        }
    return slots;
  }

  const api = {
    toLocal,
    toWorld,
    STILT_RAMP,
    stiltPosts,
    stiltSurfaces,
    stiltBlocked,
    underStiltFloor,
    stiltBulletBoxes,
    KEEP: K,
    KEEP_RAMPS: RAMPS,
    KEEP_RAILS: RAILS,
    keepRailBase: railBase,
    keepSurfaces,
    keepBlocked,
    keepParts,
    keepRampSolid,
    keepLootSlots,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LDStructures = api;
})(typeof self !== "undefined" ? self : this);
