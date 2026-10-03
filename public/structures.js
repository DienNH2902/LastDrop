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

  // ======================= TƯỜNG THÀNH / THÁP / CẦU THANG THÁP (Thành Cổ) =======================
  // Đỉnh tường là lối đi (chân đứng được, đi dọc được), đỉnh tháp là sàn quan sát,
  // mỗi tháp có cầu thang đá (nêm đặc có bậc) từ sân lên thẳng sàn tháp.
  // rel = độ cao chân so với nền vật thể (null = xe → luôn chặn).
  const WALL_TOP = (o) => o.h - 0.4; // mặt lối đi trên tường (so với nền)
  const TOWER_TOP = (o) => o.h - 0.25; // mặt sàn đỉnh tháp
  // Độ cao cầu thang tại lz (dọc thang, +lz đi lên), topRel = đỉnh so với nền thang.
  // o.overlap: phần đầu thang lấn vào thân tháp — thang lên đủ cao NGAY tại mặt tháp.
  const rampRise = (o, lz, topRel) => topRel * Math.max(0, Math.min(1, (lz + o.length / 2) / (o.length - (o.overlap || 0))));
  // Đỉnh cầu thang (so với nền thang) = sàn tháp nó dẫn lên.
  const rampTopRel = (o, groundAt) => groundAt(o.tx, o.tz) + o.towerH - groundAt(o.x, o.z);
  function fortSurfaces(o, ground, lx, lz, out, groundAt) {
    if (o.type === "stonewall") {
      if (Math.abs(lx) <= o.w / 2 && Math.abs(lz) <= o.length / 2)
        out.push({ height: ground + WALL_TOP(o), base: ground + WALL_TOP(o) - 1, type: "wallTop", obstacle: o });
    } else if (o.type === "tower") {
      if (Math.abs(lx) <= o.w / 2 + 0.3 && Math.abs(lz) <= o.w / 2 + 0.3)
        out.push({ height: ground + TOWER_TOP(o), base: ground + TOWER_TOP(o) - 1, type: "towerTop", obstacle: o });
    } else if (o.type === "fortramp") {
      if (Math.abs(lx) <= o.w / 2 && Math.abs(lz) <= o.length / 2 + 0.05) {
        const h = ground + rampRise(o, lz, rampTopRel(o, groundAt));
        out.push({ height: h, base: h - 1, type: "ramp", obstacle: o });
      }
    }
  }
  // true = chặn · false = không chặn · (chỉ gọi cho 3 loại trên)
  function fortBlocked(o, lx, lz, r, rel, groundAt) {
    if (o.type === "stonewall") {
      if (Math.abs(lx) >= o.w / 2 + r || Math.abs(lz) >= o.length / 2 + r) return false;
      return rel === null || rel < WALL_TOP(o) - 0.45; // đã đứng trên đỉnh tường thì đi lại tự do
    }
    if (o.type === "tower") {
      if (Math.abs(lx) >= o.w / 2 + r || Math.abs(lz) >= o.w / 2 + r) return false;
      return rel === null || rel < TOWER_TOP(o) - 0.45;
    }
    if (o.type === "fortramp") {
      if (Math.abs(lx) >= o.w / 2 + r || Math.abs(lz) >= o.length / 2 + r) return false;
      if (rel === null) return true;
      const surf = rampRise(o, Math.max(-o.length / 2, Math.min(o.length / 2, lz)), rampTopRel(o, groundAt));
      return rel < surf - 0.45; // khối thang đặc: chỉ lên từ chân thang
    }
    return false;
  }
  // Điểm có nằm trong khối cầu thang đặc không (đạn / lựu đạn).
  function fortRampSolid(o, lx, ry, lz, groundAt) {
    if (Math.abs(lx) > o.w / 2 || Math.abs(lz) > o.length / 2) return false;
    return ry >= -0.2 && ry < rampRise(o, lz, rampTopRel(o, groundAt)) - 0.02;
  }

  // ======================= NHÀ TO NHIỀU PHÒNG (manor) =======================
  // o.w (bề ngang, trục x) × o.d (bề sâu, trục z), tường cao o.h, mái bằng đứng được.
  // Cửa chính ở mặt -Z. Bên trong: SẢNH trước + 2 PHÒNG sau (vách ngăn có cửa).
  // Tường = các đoạn thẳng theo trục, mỗi đoạn có lỗ (cửa / cửa sổ) theo độ cao.
  const MANOR = { wall: 0.24, doorHalf: 0.85, doorH: 2.35, sill: 1.0, winTop: 2.25, winHalf: 0.65, roof: 0.22, parapet: 0.45, floor: 0.3 };
  const manorCache = new WeakMap();
  function manorLayout(o) {
    let L = manorCache.get(o);
    if (L) return L;
    const W = o.w / 2,
      D = o.d / 2,
      H = o.h,
      T = MANOR.wall;
    const split = D * 0.12; // vách ngang ngăn sảnh / phòng sau (z cục bộ)
    const door = (u) => ({ u0: u - MANOR.doorHalf, u1: u + MANOR.doorHalf, y0: 0, y1: MANOR.doorH });
    const win = (u) => ({ u0: u - MANOR.winHalf, u1: u + MANOR.winHalf, y0: MANOR.sill, y1: MANOR.winTop });
    // Đoạn tường: trục ("x": chạy dọc x tại z = at; "z": chạy dọc z tại x = at), từ u0 → u1.
    const walls = [
      { axis: "x", at: -D, u0: -W, u1: W, holes: [door(0), win(-W * 0.6), win(W * 0.6)] }, // mặt trước + cửa chính
      { axis: "x", at: D, u0: -W, u1: W, holes: [win(-W * 0.5), win(W * 0.5)] }, // mặt sau
      { axis: "z", at: -W, u0: -D, u1: D, holes: [win(-D * 0.5), win(D * 0.55)] }, // hông trái
      { axis: "z", at: W, u0: -D, u1: D, holes: [win(-D * 0.5), win(D * 0.55)] }, // hông phải
      { axis: "x", at: split, u0: -W, u1: W, holes: [door(-W * 0.5), door(W * 0.5)], inner: true }, // vách sảnh ↔ 2 phòng
      { axis: "z", at: 0, u0: split, u1: D, holes: [], inner: true }, // vách giữa 2 phòng sau
    ];
    // Đổi đoạn tường + lỗ thành các hộp đặc (cục bộ, y từ sàn).
    const boxes = [];
    for (const w of walls) {
      const cuts = [...w.holes].sort((a, b) => a.u0 - b.u0);
      const pushBox = (u0, u1, y0, y1, kind) => {
        if (u1 - u0 < 0.02 || y1 - y0 < 0.02) return;
        const cu = (u0 + u1) / 2,
          hu = (u1 - u0) / 2;
        if (w.axis === "x") boxes.push({ x: cu, z: w.at, hx: hu, hz: T / 2, y: (y0 + y1) / 2, hy: (y1 - y0) / 2, kind });
        else boxes.push({ x: w.at, z: cu, hx: T / 2, hz: hu, y: (y0 + y1) / 2, hy: (y1 - y0) / 2, kind });
      };
      let u = w.u0;
      for (const h of cuts) {
        pushBox(u, h.u0, 0, H, "wall");
        pushBox(h.u0, h.u1, 0, h.y0, h.y0 > 0 ? "sill" : "wall"); // bệ cửa sổ
        pushBox(h.u0, h.u1, h.y1, H, "lintel"); // lanh tô trên cửa / cửa sổ
        u = h.u1;
      }
      pushBox(u, w.u1, 0, H, "wall");
    }
    // Sàn nhà (tối màu) + mái bằng + lan can mái.
    // Sàn nâng MANOR.floor m trên nền (nền dốc nhẹ vẫn không trồi lên sàn), đế chìm xuống đất.
    const floor = { x: 0, z: 0, hx: W, hz: D, y: (MANOR.floor - 0.5) / 2, hy: (MANOR.floor + 0.5) / 2, kind: "floor" };
    const roof = { x: 0, z: 0, hx: W + 0.15, hz: D + 0.15, y: H + MANOR.roof / 2, hy: MANOR.roof / 2, kind: "roof" };
    const P = MANOR.parapet,
      top = H + MANOR.roof;
    // Lan can mái có LỐI HỞ 1.8 m giữa mỗi cạnh: đáp dù xuống mái vẫn đi ra mép
    // nhảy xuống đất được (trước đây lan can kín 4 phía → kẹt trên mái).
    const GAP = 1.8;
    const parapets = [];
    const seg = (x, z, hx, hz) => parapets.push({ x, z, hx, hz, y: top + P / 2, hy: P / 2, kind: "parapet" });
    for (const sz of [-1, 1]) {
      const half = (W + 0.15 - GAP / 2) / 2;
      seg(-(GAP / 2 + half), sz * (D + 0.05), half, 0.1);
      seg(GAP / 2 + half, sz * (D + 0.05), half, 0.1);
    }
    for (const sx of [-1, 1]) {
      const half = (D + 0.15 - GAP / 2) / 2;
      seg(sx * (W + 0.05), -(GAP / 2 + half), 0.1, half);
      seg(sx * (W + 0.05), GAP / 2 + half, 0.1, half);
    }
    // Ô đặt đồ / bàn trong từng phòng (tránh lối cửa, sát tường).
    const rooms = [
      { x0: -W + 0.6, x1: W - 0.6, z0: -D + 0.6, z1: split - 0.6 }, // sảnh
      { x0: -W + 0.6, x1: -0.6, z0: split + 0.6, z1: D - 0.6 }, // phòng trái
      { x0: 0.6, x1: W - 0.6, z0: split + 0.6, z1: D - 0.6 }, // phòng phải
    ];
    L = { W, D, H, top, split, boxes, floor, roof, parapets, rooms };
    manorCache.set(o, L);
    return L;
  }
  // Hộp chặn đạn / lựu đạn (cục bộ). Cửa sổ, cửa ra vào là lỗ trống → bắn xuyên được.
  const manorParts = (o) => {
    const L = manorLayout(o);
    return [...L.boxes, L.roof, ...L.parapets];
  };
  function manorSurfaces(o, ground, lx, lz, out) {
    const L = manorLayout(o);
    if (Math.abs(lx) > L.W + 0.15 || Math.abs(lz) > L.D + 0.15) return;
    out.push({ height: ground + MANOR.floor, base: ground - 0.9, type: "manorFloor", obstacle: o });
    out.push({ height: ground + L.top, base: ground + L.top - 1, type: "manorRoof", obstacle: o });
  }
  // Va chạm di chuyển (rel = độ cao chân so với nền; null = xe).
  function manorBlocked(o, lx, lz, r, rel) {
    const L = manorLayout(o);
    if (Math.abs(lx) >= L.W + 0.15 + r || Math.abs(lz) >= L.D + 0.15 + r) return false;
    if (rel === null) return true; // xe không vào nhà
    if (rel >= L.top - 0.45) {
      // Trên mái: lan can quanh mép chặn rơi.
      for (const b of L.parapets) if (Math.abs(lx - b.x) < b.hx + r && Math.abs(lz - b.z) < b.hz + r) return true;
      return false;
    }
    // Trong / ngoài nhà ở mặt đất: chặn bởi đoạn tường đứng (cửa ra vào là lỗ đi qua được).
    for (const b of L.boxes) {
      if (b.y - b.hy > 0.3) continue; // lanh tô trên đầu: không vướng
      if (b.y + b.hy < rel + 0.3) continue;
      if (Math.abs(lx - b.x) < b.hx + r && Math.abs(lz - b.z) < b.hz + r) return true;
    }
    return false;
  }
  function manorLootSlots(o) {
    const L = manorLayout(o);
    const out = [];
    for (const room of L.rooms)
      for (let x = room.x0; x <= room.x1 + 1e-6; x += 1.5)
        for (let z = room.z0; z <= room.z1 + 1e-6; z += 1.5) {
          if (z < -L.D + 2 && Math.abs(x) < 1.4) continue; // lối cửa chính
          if (Math.abs(z - L.split) < 1.4 && (Math.abs(x + L.W * 0.5) < 1.2 || Math.abs(x - L.W * 0.5) < 1.2)) continue; // lối cửa phòng
          out.push({ lx: x, lz: z });
        }
    return out;
  }

  // ======================= BÀN / GHẾ =======================
  // table {w (dài, trục x), d (rộng, trục z), h, lift?} · chair {w, h, lift?}. lift = cao độ sàn
  // đặt đồ (sàn nhà sàn, tầng thành chính) so với mặt đất tại tâm vật.
  const TABLE_TOP = 0.78;
  function tableBlocked(o, lx, lz, r, rel) {
    if (Math.abs(lx) >= o.w / 2 + r || Math.abs(lz) >= o.d / 2 + r) return false;
    if (rel === null) return false; // bàn nằm trong nhà, xe không tới
    const floor = o.lift || 0;
    return rel > floor - 0.6 && rel < floor + TABLE_TOP - 0.25; // đứng cùng sàn: vướng bàn
  }

  const api = {
    MANOR,
    manorLayout,
    manorParts,
    manorSurfaces,
    manorBlocked,
    manorLootSlots,
    TABLE_TOP,
    tableBlocked,
    fortSurfaces,
    fortBlocked,
    fortRampSolid,
    rampRise,
    rampTopRel,
    WALL_TOP,
    TOWER_TOP,
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
