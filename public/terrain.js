// Địa hình dùng chung cho SERVER (require) và CLIENT (<script> → window.LDTerrain).
// Cả hai phía dựng CÙNG một lưới độ cao từ danh sách obstacles của map, nên
// va chạm / tiếp đất / đạn trúng núi trên server khớp đúng mặt đất người chơi thấy.
//
// Tra độ cao là O(1) (nội suy song tuyến trên lưới 2 m) — rẻ hơn cách cũ lặp qua
// từng ngọn đồi, dù map mới có hàng trăm khối núi.
//
// Các obstacle tham gia dựng địa hình (đều solid:false):
//   terrain  {seed}                          — hạt giống nhiễu chi tiết
//   hill     {x,z,w,length,h,yaw}            — khối núi elip xoay; nhiều khối nối
//                                              nhau thành dãy núi dài nhấp nhô
//   river/lake/swamp                         — nền được hạ phẳng về 0
//   plateau  {x,z,r}                         — san phẳng (làng trên núi, điểm ngắm)
//   road     {x,z,yaw,length,w}              — san phẳng mặt cắt ngang của đường
//   pad      {x,z,r}                         — san nền dưới từng căn nhà
(function (root) {
  const MAP_HALF = 300; // map 600 × 600 m (đủ rộng cho 5 người)
  const EXTENT = MAP_HALF + 70; // vẽ thêm núi viền ngoài map để không thấy mép vuông
  const CELL = 2;
  const N = Math.round((EXTENT * 2) / CELL) + 1;

  function hash2(ix, iz, seed) {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ seed;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  // Nhiễu giá trị mượt (value noise) 0..1.
  function valueNoise(x, z, seed) {
    const ix = Math.floor(x),
      iz = Math.floor(z);
    const fx = x - ix,
      fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx),
      sz = fz * fz * (3 - 2 * fz);
    const a = hash2(ix, iz, seed),
      b = hash2(ix + 1, iz, seed);
    const c = hash2(ix, iz + 1, seed),
      d = hash2(ix + 1, iz + 1, seed);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
  }
  function fbm(x, z, seed, octaves) {
    let sum = 0,
      amp = 0.5,
      freq = 1;
    for (let i = 0; i < octaves; i++) {
      sum += amp * valueNoise(x * freq, z * freq, seed + i * 1013);
      amp *= 0.5;
      freq *= 2.03;
    }
    return sum; // ~0..1
  }
  const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  // Dạng mặt cắt một khối núi: chân núi xoè rộng, sườn thẳng, đỉnh hơi nhọn
  // (không phải mái vòm tròn) để nhiều khối nối nhau thành sống núi.
  function hillProfile(d2) {
    if (d2 >= 1) return 0;
    const t = 1 - Math.sqrt(d2);
    return t * (1.35 - 0.35 * t);
  }
  function hillHeight(hill, x, z) {
    const dx = x - hill.x,
      dz = z - hill.z;
    const c = Math.cos(hill.yaw || 0),
      s = Math.sin(hill.yaw || 0);
    const lx = c * dx - s * dz,
      lz = s * dx + c * dz;
    const rx = hill.w / 2,
      rz = (hill.length || hill.w) / 2;
    return hill.h * hillProfile((lx / rx) ** 2 + (lz / rz) ** 2);
  }
  function hillRadius(hill) {
    return Math.max(hill.w, hill.length || hill.w) / 2;
  }
  // Vùng nước dạng hình học (dùng chung logic với waterAt của game).
  function insideWater(o, x, z, margin = 0) {
    const dx = x - o.x,
      dz = z - o.z;
    const c = Math.cos(o.yaw || 0),
      s = Math.sin(o.yaw || 0);
    const lx = c * dx - s * dz,
      lz = s * dx + c * dz;
    if (o.type === "lake" || o.type === "swamp")
      return (
        (lx / (o.w + margin)) ** 2 + (lz / ((o.length || o.w) + margin)) ** 2 <=
        1
      );
    return (
      Math.abs(lx) <= o.w / 2 + margin && Math.abs(lz) <= o.length / 2 + margin
    );
  }

  function build(obstacles) {
    const H = new Float32Array(N * N);
    const toCell = (v) => (v + EXTENT) / CELL;
    const cellPos = (i) => i * CELL - EXTENT;
    const forEachCell = (x, z, r, fn) => {
      const i0 = Math.max(0, Math.floor(toCell(x - r))),
        i1 = Math.min(N - 1, Math.ceil(toCell(x + r)));
      const j0 = Math.max(0, Math.floor(toCell(z - r))),
        j1 = Math.min(N - 1, Math.ceil(toCell(z + r)));
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) fn(j * N + i, cellPos(i), cellPos(j));
    };
    const seed = (obstacles.find((o) => o.type === "terrain")?.seed || 1) | 0;
    // 1) Các khối núi, lấy max để dãy núi liền mạch.
    const hills = obstacles.filter((o) => o.type === "hill");
    for (const hill of hills)
      forEachCell(hill.x, hill.z, hillRadius(hill), (k, x, z) => {
        const h = hillHeight(hill, x, z);
        if (h > H[k]) H[k] = h;
      });
    // 2) Chi tiết: núi lởm chởm theo độ cao, đồng bằng gợn nhẹ; mép ngoài cùng hạ dần.
    for (let j = 0; j < N; j++) {
      const z = cellPos(j);
      for (let i = 0; i < N; i++) {
        const x = cellPos(i);
        const k = j * N + i;
        const base = H[k];
        // Nhiễu "ridged" tạo sống núi răng cưa, khe rãnh; đồng bằng gợn nhẹ.
        const n = fbm(x / 34, z / 34, seed, 4);
        const ridged = 1 - Math.abs(2 * n - 1);
        const detail = fbm(x / 9, z / 9, seed + 31, 2);
        const roll = fbm(x / 60, z / 60, seed + 77, 2);
        let h =
          base * (0.62 + ridged * 0.55 + (detail - 0.5) * 0.18) +
          (roll - 0.5) * 1.6;
        const edge = Math.max(Math.abs(x), Math.abs(z));
        if (edge > EXTENT - 30) h *= smooth((EXTENT - edge) / 30);
        H[k] = Math.max(0, h);
      }
    }
    // 3) Sông / hồ / đầm lầy: nền về 0 và bờ thoải.
    for (const o of obstacles) {
      if (o.type !== "river" && o.type !== "lake" && o.type !== "swamp") continue;
      const r = Math.max(o.w, o.length || o.w) + 12;
      forEachCell(o.x, o.z, r, (k, x, z) => {
        if (insideWater(o, x, z)) H[k] = 0;
        else if (insideWater(o, x, z, 10)) H[k] = Math.min(H[k], 0.6);
      });
    }
    const snapshot = () => H.slice();
    const sampleOf = (field, x, z) => {
      const fx = Math.min(N - 1.001, Math.max(0, toCell(x)));
      const fz = Math.min(N - 1.001, Math.max(0, toCell(z)));
      const i = Math.floor(fx),
        j = Math.floor(fz);
      const tx = fx - i,
        tz = fz - j;
      const k = j * N + i;
      const a = field[k] + (field[k + 1] - field[k]) * tx;
      const b = field[k + N] + (field[k + N + 1] - field[k + N]) * tx;
      return a + (b - a) * tz;
    };
    // protect(k) → true: ô thuộc lòng đường, không được san lại (giữ mặt đường phẳng).
    const flatten = (x, z, r, fall, level, protect) =>
      forEachCell(x, z, r + fall, (k, cx, cz) => {
        if (protect && protect(k)) return;
        const d = Math.hypot(cx - x, cz - z);
        const w = d <= r ? 1 : 1 - smooth((d - r) / fall);
        if (w > 0) H[k] += (level - H[k]) * w;
      });
    // 4) Cao nguyên (làng trên núi / điểm ngắm).
    let before = snapshot();
    for (const o of obstacles)
      if (o.type === "plateau")
        flatten(o.x, o.z, o.r, 14, o.level ?? sampleOf(before, o.x, o.z));
    // 5) Đường: mặt cắt ngang phẳng, dọc đường nối thẳng giữa hai đầu đoạn.
    // Mỗi ô chỉ lấy cao độ của đoạn đường GẦN NHẤT (nếu san lần lượt từng đoạn,
    // các đoạn đè nhau tạo mặt răng cưa che mất mặt đường trên dốc núi).
    before = snapshot();
    const bestD = new Float32Array(N * N).fill(Infinity);
    const bestLevel = new Float32Array(N * N);
    const bestW = new Float32Array(N * N);
    for (const road of obstacles) {
      if (road.type !== "road") continue;
      const dx = (Math.sin(road.yaw) * road.length) / 2,
        dz = (Math.cos(road.yaw) * road.length) / 2;
      const ax = road.x - dx,
        az = road.z - dz,
        bx = road.x + dx,
        bz = road.z + dz;
      // Cao độ đã được server tính (giới hạn độ dốc); map cũ thì lấy theo đất.
      // length có cộng 0.6 m chồng mí nên nội suy theo tỉ lệ đoạn thật.
      const ha = road.ya ?? sampleOf(before, ax, az),
        hb = road.yb ?? sampleOf(before, bx, bz);
      const vx = bx - ax,
        vz = bz - az,
        len2 = vx * vx + vz * vz || 1;
      const outer = road.w / 2 + 6;
      forEachCell(road.x, road.z, road.length / 2 + outer, (k, x, z) => {
        const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / len2));
        const d = Math.hypot(x - (ax + vx * t), z - (az + vz * t));
        if (d >= outer || d >= bestD[k]) return;
        bestD[k] = d;
        bestLevel[k] = ha + (hb - ha) * t;
        bestW[k] = road.w;
      });
    }
    for (let k = 0; k < H.length; k++) {
      if (bestD[k] === Infinity) continue;
      const inner = bestW[k] / 2 + 1.2,
        outer = bestW[k] / 2 + 6;
      const w = bestD[k] <= inner ? 1 : 1 - smooth((bestD[k] - inner) / (outer - inner));
      H[k] += (bestLevel[k] - H[k]) * w;
    }
    // 6) Nền nhà.
    before = snapshot();
    for (const o of obstacles)
      if (o.type === "pad")
        flatten(o.x, o.z, o.r, 4, sampleOf(before, o.x, o.z), (k) => bestD[k] < bestW[k] / 2 + 1.5);
    let maxHeight = 0.3;
    for (let k = 0; k < H.length; k++) {
      if (H[k] < 0) H[k] = 0;
      if (H[k] > maxHeight) maxHeight = H[k];
    }
    return {
      N,
      CELL,
      EXTENT,
      heights: H,
      maxHeight,
      heightAt: (x, z) => sampleOf(H, x, z),
      // Độ dốc (độ lớn gradient) — dùng để tô màu đá / tránh mọc cỏ trên vách.
      slopeAt(x, z) {
        const e = CELL;
        const gx = (sampleOf(H, x + e, z) - sampleOf(H, x - e, z)) / (2 * e);
        const gz = (sampleOf(H, x, z + e) - sampleOf(H, x, z - e)) / (2 * e);
        return Math.hypot(gx, gz);
      },
    };
  }
  const api = {
    MAP_HALF,
    EXTENT,
    CELL,
    N,
    build,
    fbm,
    valueNoise,
    hash2,
    hillHeight,
    hillRadius,
    insideWater,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LDTerrain = api;
})(typeof self !== "undefined" ? self : this);
