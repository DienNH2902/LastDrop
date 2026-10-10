// Mô hình súng dùng chung cho: súng cầm tay (góc nhìn thứ nhất), súng trên tay
// người chơi khác và súng rơi dưới đất (loot). Toạ độ "chuẩn" của mỗi mô hình:
// gốc (0,0,0) nằm trên trục nòng ngay tại tay cầm, nòng hướng về -Z, đơn vị mét
// (kích thước thật). Mỗi mô hình trả về Group kèm userData:
//   muzzle   — Vector3 đầu nòng (để đặt tia lửa / vệt đạn)
//   magazine — mesh băng đạn (hoạt ảnh nạp đạn)
//   sightY   — độ cao đường ngắm so với trục nòng (thước ngắm cơ khí: ironY;
//              gắn ống ngắm thì game.js đổi theo sightY của ống ngắm)
//   bolt     — (Kar98k) khóa nòng để kéo sau mỗi phát
import * as THREE from "three";

const matCache = new Map();
function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key))
    matCache.set(key, new THREE.MeshLambertMaterial({ color, ...opts }));
  return matCache.get(key);
}
function part(group, geometry, material, x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  group.add(m);
  return m;
}
// Trụ nằm dọc trục Z (nòng, ống ngắm...).
const tubeZ = (r1, r2, len, seg = 12) =>
  new THREE.CylinderGeometry(r1, r2, len, seg).rotateX(Math.PI / 2);
const box = (x, y, z) => new THREE.BoxGeometry(x, y, z);

// ---------------------------------------------------------------------------
// Beryl M762 (kiểu AK): thân thép đen, ốp tay có ray, băng đạn cong, loa hãm
// nòng, báng gập dạng khung; ngắm bằng thước ngắm sau + đầu ruồi (không ống kính).
// ---------------------------------------------------------------------------
export function buildBeryl() {
  const g = new THREE.Group();
  const black = mat("#1b1c1a");
  const polymer = mat("#272825");
  const steel = mat("#343632");
  const tan = mat("#5c5143"); // ốp tay nhựa màu cát đặc trưng bản PUBG
  // Hộp khóa nòng + nắp che bụi bo tròn phía trên.
  part(g, box(0.058, 0.1, 0.36), black, 0, -0.02, 0.02);
  part(g, tubeZ(0.029, 0.029, 0.32, 12), steel, 0, 0.03, 0.03);
  // Tay kéo khóa nòng (bên phải) — tách riêng để kéo lùi lên đạn sau khi nạp.
  const charge = new THREE.Group();
  charge.position.set(0.035, 0.005, -0.06);
  part(charge, box(0.012, 0.018, 0.05), steel, 0, 0, 0);
  part(charge, box(0.022, 0.014, 0.014), steel, 0.014, 0, 0.018); // núm kéo
  g.add(charge);
  // Thước ngắm cơ khí (thước sau + đầu ruồi) vẫn giữ, nằm thấp dưới kính ngắm.
  const ironY = 0.075;
  part(g, box(0.03, ironY - 0.045, 0.03), black, 0, (ironY + 0.045) / 2 - 0.01, -0.12);
  part(g, box(0.034, 0.012, 0.02), black, 0, ironY - 0.004, -0.12);
  for (const side of [-1, 1]) part(g, box(0.008, 0.028, 0.012), black, side * 0.016, ironY + 0.004, -0.57);
  part(g, box(0.004, 0.022, 0.006), black, 0, ironY - 0.004, -0.57); // đầu ruồi
  part(g, box(0.03, 0.05, 0.03), black, 0, 0.03, -0.57); // đế đầu ruồi
  // Ray Picatinny trên nắp che bụi (gắn ống ngắm). Mặc định ngắm bằng thước
  // ngắm cơ khí (thước sau + đầu ruồi) ở độ cao ironY.
  part(g, box(0.026, 0.01, 0.2), black, 0, 0.063, -0.01);
  for (let i = 0; i < 7; i++) part(g, box(0.03, 0.004, 0.008), steel, 0, 0.069, -0.1 + i * 0.03);
  // Ốp tay có ray + ống trích khí.
  part(g, box(0.064, 0.074, 0.27), tan, 0, -0.012, -0.3);
  part(g, box(0.03, 0.014, 0.27), black, 0, 0.032, -0.3);
  for (const side of [-1, 1]) part(g, box(0.012, 0.024, 0.2), black, side * 0.036, -0.012, -0.3);
  part(g, tubeZ(0.014, 0.014, 0.2, 10), steel, 0, 0.036, -0.35);
  // Nòng + loa hãm nòng có khe xả.
  part(g, tubeZ(0.013, 0.013, 0.2, 10), black, 0, 0, -0.52);
  part(g, box(0.036, 0.036, 0.075), black, 0, 0, -0.645);
  for (let i = 0; i < 3; i++) part(g, box(0.038, 0.006, 0.01), steel, 0, 0.015, -0.625 - i * 0.018);
  // Băng đạn cong 30 viên (3 đoạn nối nhau cong về trước).
  const magazine = new THREE.Group();
  magazine.position.set(0, -0.07, -0.05);
  part(magazine, box(0.034, 0.1, 0.075), polymer, 0, -0.05, 0.0, 0.2);
  part(magazine, box(0.034, 0.1, 0.075), polymer, 0, -0.14, -0.035, 0.42);
  part(magazine, box(0.034, 0.07, 0.072), polymer, 0, -0.215, -0.08, 0.62);
  for (let i = 0; i < 3; i++) part(magazine, box(0.036, 0.008, 0.078), black, 0, -0.03 - i * 0.075, -i * 0.03, 0.2 + i * 0.2);
  g.add(magazine);
  // Tay cầm súng + vòng cò.
  part(g, box(0.034, 0.11, 0.045), polymer, 0, -0.11, 0.1, 0.35);
  part(g, box(0.008, 0.03, 0.07), black, 0, -0.085, 0.04);
  // Báng gập dạng khung ống + tấm tì vai.
  part(g, tubeZ(0.01, 0.01, 0.27, 8), black, 0, 0.0, 0.33);
  part(g, new THREE.CylinderGeometry(0.009, 0.009, 0.28, 8), black, 0, -0.055, 0.33, 1.35);
  part(g, box(0.04, 0.13, 0.025), polymer, 0, -0.045, 0.47);
  g.userData = { muzzle: new THREE.Vector3(0, 0, -0.69), magazine, sightY: ironY, ironY, kind: "beryl", charge, chargeGrip: new THREE.Vector3(0.03, -0.01, 0.02) };
  return g;
}

// ---------------------------------------------------------------------------
// AUG A3 (bullpup) + red dot
// ---------------------------------------------------------------------------
// Mặt cắt ngang (profile cạnh súng) → khối đùn dày `thick` theo trục X, có vát mép.
// Điểm [z, y] theo toạ độ súng (nòng hướng -Z). holes: các lỗ (vòng che cò).
function profileSolid(points, thick, bevel = 0.006, holes = []) {
  const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(-z, y)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([z, y]) => new THREE.Vector2(-z, y))));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thick - bevel * 2, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 6 });
  geo.translate(0, 0, -(thick - bevel * 2) / 2);
  geo.rotateY(Math.PI / 2); // trục đùn → trục X (bề ngang súng); profile nằm trong mặt Y–Z
  return geo;
}
// ---------------------------------------------------------------------------
// Steyr AUG (bullpup): báng nhựa olive liền khối bo tròn, vòng che cò LỚN ôm cả
// bàn tay, ray Picatinny có khía trên nóc, ống bao nòng + nòng + loa che lửa xẻ
// rãnh, tay cầm trước gập dưới nòng, băng đạn nhựa xám đen có gân ở SAU tay cầm,
// tay gạt lên đạn bên TRÁI. Dùng chung cho súng cầm tay / người khác / dưới đất.
// ---------------------------------------------------------------------------
export function buildAug() {
  const g = new THREE.Group();
  const polymer = mat("#5d6a43"); // nhựa olive AUG
  const polymerDark = mat("#4a5535");
  const rubber = mat("#2b2e27");
  const metal = mat("#1d1f1c");
  const steel = mat("#3c403a");
  const magMat = mat("#34372f");
  // Thân báng: lưng phẳng, đuôi báng vát, bụng chứa giếng băng đạn, mũi thuôn vào ống bao nòng.
  part(
    g,
    profileSolid(
      [
        [0.02, 0.045], [0.3, 0.045], [0.355, 0.03], [0.372, 0.0], [0.372, -0.07], [0.35, -0.095],
        [0.17, -0.095], [0.15, -0.062], [0.05, -0.062], [0.03, -0.05], [-0.05, -0.045], [-0.1, -0.03], [-0.12, 0.0], [-0.1, 0.03],
      ],
      0.074,
      0.012,
    ),
    polymer,
    0, 0, 0,
  );
  part(g, box(0.078, 0.11, 0.016), rubber, 0, -0.026, 0.368); // đệm báng cao su
  for (const side of [-1, 1]) {
    part(g, box(0.004, 0.032, 0.075), metal, side * 0.038, 0.012, 0.16); // cửa thoát vỏ đạn 2 bên
    part(g, box(0.004, 0.012, 0.11), polymerDark, side * 0.038, -0.03, 0.24); // gờ chống trượt
  }
  // Vòng che cò lớn liền tay cầm (đùn có lỗ — nhìn xuyên qua được như súng thật).
  part(
    g,
    profileSolid(
      [[0.04, -0.052], [0.035, -0.2], [0.0, -0.215], [-0.17, -0.215], [-0.19, -0.2], [-0.19, -0.05], [-0.15, -0.045]],
      0.034,
      0.006,
      [[[0.0, -0.075], [-0.005, -0.19], [-0.155, -0.19], [-0.16, -0.07], [-0.13, -0.065]]],
    ),
    polymer,
    0, 0, 0,
  );
  // Báng cầm nghiêng (bàn tay phải) + cò.
  part(g, box(0.042, 0.13, 0.05), polymerDark, 0, -0.115, 0.005, 0.26);
  part(g, box(0.008, 0.03, 0.012), metal, 0, -0.085, -0.045, 0.3);
  // Khối hộp khoá nòng (kim loại) + ray Picatinny có khía.
  part(g, box(0.05, 0.03, 0.27), steel, 0, 0.058, -0.01);
  part(g, box(0.028, 0.012, 0.26), metal, 0, 0.078, -0.01);
  for (let i = 0; i < 16; i++) part(g, box(0.032, 0.008, 0.008), metal, 0, 0.087, -0.135 + i * 0.0165);
  // Ống bao nòng + nòng + loa che lửa xẻ rãnh.
  part(g, tubeZ(0.03, 0.033, 0.17, 14), steel, 0, 0.004, -0.2);
  part(g, tubeZ(0.034, 0.034, 0.02, 14), metal, 0, 0.004, -0.13); // khoá nòng / vòng hãm
  part(g, tubeZ(0.015, 0.015, 0.25, 10), metal, 0, 0, -0.36);
  part(g, tubeZ(0.021, 0.019, 0.075, 10), metal, 0, 0, -0.51);
  for (let i = 0; i < 6; i++) part(g, box(0.004, 0.024, 0.05), steel, Math.cos(i * 1.047) * 0.02, Math.sin(i * 1.047) * 0.02, -0.51, 0, 0, i * 1.047);
  part(g, tubeZ(0.009, 0.009, 0.16, 8), steel, 0, 0.03, -0.25); // ống trích khí trên nòng
  // Tay cầm trước GẬP xuống (tay trái cầm ở đây) + khớp gập.
  part(g, box(0.03, 0.03, 0.045), metal, 0, -0.03, -0.2);
  part(g, box(0.032, 0.12, 0.038), polymerDark, 0, -0.1, -0.205, -0.08);
  for (let i = 0; i < 4; i++) part(g, box(0.034, 0.006, 0.04), rubber, 0, -0.07 - i * 0.025, -0.207, -0.08); // gân bám
  // Băng đạn nhựa xám đen, hơi cong, có gân — SAU tay cầm (bullpup).
  const magazine = part(g, box(0.034, 0.17, 0.075), magMat, 0, -0.145, 0.1, 0.18);
  for (let i = 0; i < 4; i++) part(magazine, box(0.036, 0.008, 0.078), metal, 0, 0.04 - i * 0.032, 0); // gân băng
  part(magazine, box(0.037, 0.02, 0.08), metal, 0, -0.08, 0); // đế băng
  part(magazine, box(0.006, 0.12, 0.03), mat("#4d5148"), 0.018, -0.005, 0.015); // khe cửa sổ đếm đạn
  // Tay gạt lên đạn bên TRÁI thân súng như AUG thật — khi ngắm vẫn ló ra góc dưới bên trái.
  const charge = new THREE.Group(); // tách riêng để kéo lùi lên đạn sau khi nạp
  charge.position.set(-0.05, 0.045, -0.07);
  part(charge, box(0.024, 0.022, 0.1), steel, 0, 0, 0); // thanh trượt
  part(charge, box(0.075, 0.02, 0.026), steel, -0.04, 0, -0.03); // cần gạt chìa ra trái
  part(charge, new THREE.CylinderGeometry(0.016, 0.016, 0.03, 12), polymer, -0.085, 0, -0.03, 0, 0, Math.PI / 2); // núm cầm
  g.add(charge);
  // Thước ngắm cơ khí gập trên ray: thước sau khe chữ U, đầu ruồi có tai bảo vệ.
  const ironY = 0.112;
  for (const side of [-1, 1]) part(g, box(0.008, 0.03, 0.012), metal, side * 0.011, ironY - 0.008, 0.07);
  part(g, box(0.03, 0.012, 0.014), metal, 0, ironY - 0.024, 0.07);
  part(g, box(0.004, 0.026, 0.006), metal, 0, ironY - 0.012, -0.12);
  for (const side of [-1, 1]) part(g, box(0.005, 0.03, 0.012), metal, side * 0.014, ironY - 0.01, -0.12);
  part(g, box(0.034, 0.012, 0.016), metal, 0, ironY - 0.028, -0.12);
  g.userData = {
    muzzle: new THREE.Vector3(0, 0, -0.55),
    magazine,
    sightY: ironY,
    ironY,
    kind: "aug",
    charge,
    chargeGrip: new THREE.Vector3(-0.09, 0, -0.03),
  };
  return g;
}

// ---------------------------------------------------------------------------
// Kar98k + ống ngắm 8x
// ---------------------------------------------------------------------------
export function buildKar98() {
  const g = new THREE.Group();
  const wood = mat("#6e4526");
  const woodDark = mat("#5a371e");
  const metal = mat("#232422");
  const blued = mat("#2d3033");
  // Báng gỗ: bụng báng dốc xuống, cổ báng thon, đệm báng kim loại.
  part(g, box(0.05, 0.12, 0.26), wood, 0, -0.085, 0.33, -0.12);
  part(g, box(0.046, 0.05, 0.1), woodDark, 0, -0.035, 0.44, -0.12); // gờ trên báng
  part(g, box(0.052, 0.125, 0.012), metal, 0, -0.1, 0.465, -0.12);
  part(g, box(0.04, 0.065, 0.16), wood, 0, -0.05, 0.13, -0.08); // cổ báng
  // Ốp lót tay dài bọc nòng.
  part(g, box(0.05, 0.055, 0.42), wood, 0, -0.03, -0.22);
  part(g, box(0.034, 0.03, 0.34), woodDark, 0, 0.012, -0.28); // ốp trên
  for (const z of [-0.18, -0.42])
    part(g, box(0.056, 0.064, 0.016), metal, 0, -0.022, z); // đai nòng
  // Khóa nòng, hộp tiếp đạn, cò.
  part(g, tubeZ(0.022, 0.022, 0.2), blued, 0, 0.005, 0.02);
  part(g, box(0.03, 0.05, 0.1), metal, 0, -0.05, 0.02); // hộp đạn
  part(g, box(0.008, 0.035, 0.035), metal, 0, -0.08, 0.06); // vòng cò
  const magazine = part(
    g,
    box(0.012, 0.02, 0.06),
    mat("#b08a3c"),
    0,
    0.03,
    0.03,
  ); // kẹp đạn nạp từ trên
  // Tay khóa nòng (bolt) bên phải — được kéo lùi sau mỗi phát.
  const bolt = new THREE.Group();
  bolt.position.set(0, 0.005, 0.07);
  part(
    bolt,
    new THREE.CylinderGeometry(0.006, 0.006, 0.07, 6).rotateZ(Math.PI / 2),
    blued,
    0.035,
    -0.012,
    0,
    0,
    0,
    -0.5,
  );
  part(bolt, new THREE.SphereGeometry(0.013, 10, 8), blued, 0.068, -0.03, 0);
  g.add(bolt);
  // Nòng dài + đầu ngắm có vành che.
  part(g, tubeZ(0.014, 0.012, 0.66), metal, 0, 0, -0.62);
  part(g, tubeZ(0.02, 0.02, 0.04, 10), metal, 0, 0.004, -0.93);
  // Thước ngắm cơ khí: thước sau chữ V trên ốp nòng + đầu ruồi có vành che ở mũi
  // súng (ironY). Ống ngắm chỉ có khi gắn phụ kiện.
  const ironY = 0.042;
  for (const side of [-1, 1]) part(g, box(0.008, 0.026, 0.01), metal, side * 0.009, ironY - 0.01, -0.1);
  part(g, box(0.03, 0.012, 0.016), metal, 0, ironY - 0.024, -0.1);
  part(g, box(0.004, 0.03, 0.006), metal, 0, ironY - 0.014, -0.92); // đầu ruồi
  part(g, tubeZ(0.016, 0.016, 0.02, 10), metal, 0, ironY - 0.012, -0.92).scale.set(1, 1.2, 1); // vành che
  // Ngàm ống ngắm (để gắn 4X / 8X).
  for (const z of [-0.08, 0.1]) part(g, box(0.026, 0.012, 0.022), metal, 0, 0.03, z);
  magazine.userData.fromTop = true;
  g.userData = {
    muzzle: new THREE.Vector3(0, 0, -0.96),
    magazine,
    bolt,
    sightY: ironY,
    ironY,
    kind: "kar98",
  };
  return g;
}

// ---------------------------------------------------------------------------
// PHỤ KIỆN: mô hình trong toạ độ của súng (gốc tại tay cầm, nòng về -Z).
// MOUNTS: điểm gắn của từng súng — ray trên (ống ngắm), đầu nòng, dưới ốp tay
// (tay cầm dọc) và băng đạn (băng mở rộng gắn vào băng đạn để chạy theo hoạt ảnh nạp).
// ---------------------------------------------------------------------------
export const MOUNTS = {
  ranger: { rail: [0.091, -0.02], muzzle: -0.55, under: [-0.04, -0.3], magBase: [0, -0.145, 0.1, 0.18], magTip: [0, -0.115, 0, 0] }, // khớp ray / nòng AUG mới
  beryl: { rail: [0.068, -0.01], muzzle: -0.69, under: [-0.05, -0.33], magBase: [0, -0.07, -0.05, 0], magTip: [0, -0.27, -0.12, 0.8] },
  sniper: { rail: [0.036, 0.01], muzzle: -0.96, under: [-0.06, -0.3], magBase: null, magTip: null },
};
const glowTexture = (() => {
  let tex = null;
  return () => {
    if (tex) return tex;
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const gc = c.getContext("2d");
    const grd = gc.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, "rgba(255,70,50,1)");
    grd.addColorStop(0.35, "rgba(255,40,30,0.5)");
    grd.addColorStop(1, "rgba(255,0,0,0)");
    gc.fillStyle = grd;
    gc.fillRect(0, 0, 32, 32);
    tex = new THREE.CanvasTexture(c);
    return tex;
  };
})();
// Trả về { obj, parent: "model" | "magazine", sightY?, muzzleExt? }.
export function buildAttachment(id, kind) {
  const M = MOUNTS[kind] || MOUNTS.ranger;
  const g = new THREE.Group();
  const black = mat("#151714");
  const steel = mat("#2e312c");
  const [ry, rz] = M.rail;
  const out = { obj: g, parent: "model" };
  if (id === "reddot") {
    // Red dot ống tròn (như red dot cũ của AUG): ống rỗng, kính trong, chấm đỏ.
    const R = 0.03,
      cy = ry + 0.058;
    part(g, box(0.034, cy - R - ry + 0.004, 0.05), black, 0, (ry + cy - R) / 2, rz);
    const tube = new THREE.Mesh(
      new THREE.CylinderGeometry(R, R, 0.07, 24, 1, true).rotateX(Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: "#121412", side: THREE.DoubleSide }),
    );
    tube.position.set(0, cy, rz);
    g.add(tube);
    for (const z of [rz - 0.035, rz + 0.035]) part(g, new THREE.TorusGeometry(R, 0.0045, 6, 24), black, 0, cy, z);
    part(g, box(0.012, 0.012, 0.018), black, R + 0.004, cy, rz);
    const lens = part(
      g,
      new THREE.CircleGeometry(R - 0.002, 24),
      new THREE.MeshBasicMaterial({ color: 0x14231d, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide }),
      0,
      cy,
      rz - 0.03,
    );
    lens.renderOrder = 2;
    lens.userData.redDot = true;
    const dot = part(g, new THREE.SphereGeometry(0.0012, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2a1f, toneMapped: false }), 0, cy, rz - 0.032);
    dot.userData.redDot = true;
    const glow = part(
      g,
      new THREE.PlaneGeometry(0.009, 0.009),
      new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
      0,
      cy,
      rz - 0.0315,
    );
    glow.renderOrder = 3;
    glow.userData.redDot = true;
    out.sightY = cy;
  } else if (id === "x4" || id === "x8") {
    // 4X: ống ngắn kiểu ACOG có chóp che nắng; 8X: ống dài có loa vật kính lớn.
    const long = id === "x8";
    const r = long ? 0.02 : 0.022,
      len = long ? 0.3 : 0.15,
      cy = ry + (long ? 0.05 : 0.046);
    const body = mat(long ? "#262a2d" : "#2b2f26");
    for (const z of long ? [rz - 0.08, rz + 0.08] : [rz - 0.035, rz + 0.035]) part(g, box(0.026, cy - ry - r + 0.006, 0.022), black, 0, (ry + cy - r) / 2, z);
    part(g, tubeZ(r, r, len, 16), body, 0, cy, rz);
    part(g, tubeZ(long ? 0.034 : 0.03, r, long ? 0.1 : 0.05, 16), body, 0, cy, rz - len / 2 - (long ? 0.03 : 0.015)); // loa vật kính
    part(g, tubeZ(0.024, 0.03, 0.06, 16), body, 0, cy, rz + len / 2 + 0.02); // thị kính
    if (!long) part(g, box(0.05, 0.008, 0.08), body, 0, cy + r + 0.005, rz - 0.01); // chóp che nắng
    part(g, new THREE.CylinderGeometry(0.011, 0.011, 0.026, 10), black, 0, cy + r + 0.012, rz + (long ? 0 : 0.03)); // núm chỉnh
    part(g, new THREE.CylinderGeometry(0.011, 0.011, 0.026, 10).rotateZ(Math.PI / 2), black, r + 0.012, cy, rz + (long ? 0 : 0.03));
    part(g, new THREE.CircleGeometry(long ? 0.03 : 0.026, 16), new THREE.MeshBasicMaterial({ color: long ? 0x5e8ea0 : 0x8a5a2a }), 0, cy, rz - len / 2 - (long ? 0.081 : 0.041), 0, Math.PI, 0);
    out.sightY = cy;
  } else if (id === "comp") {
    // Nòng giảm giật: khối vuông có các khe xả khí hai bên + trên.
    const z0 = M.muzzle;
    part(g, box(0.04, 0.04, 0.08), steel, 0, 0, z0 - 0.035);
    for (let i = 0; i < 3; i++) {
      part(g, box(0.044, 0.008, 0.012), black, 0, 0.012, z0 - 0.015 - i * 0.022);
      for (const side of [-1, 1]) part(g, box(0.006, 0.026, 0.012), black, side * 0.021, 0, z0 - 0.015 - i * 0.022);
    }
    out.muzzleExt = 0.075;
  } else if (id === "supp") {
    // Nòng giảm thanh: ống trụ dài, đầu thuôn.
    const z0 = M.muzzle;
    part(g, tubeZ(0.026, 0.026, 0.2, 16), mat("#1d1f1c"), 0, 0, z0 - 0.1);
    part(g, tubeZ(0.02, 0.026, 0.02, 16), black, 0, 0, z0 - 0.21);
    part(g, tubeZ(0.027, 0.027, 0.012, 16), steel, 0, 0, z0 - 0.02);
    out.muzzleExt = 0.215;
  } else if (id === "vgrip") {
    // Tay cầm dọc dưới ốp tay (súng auto).
    const [uy, uz] = M.under;
    part(g, box(0.034, 0.016, 0.06), black, 0, uy - 0.006, uz);
    part(g, box(0.03, 0.1, 0.034), mat("#24261f"), 0, uy - 0.062, uz + 0.004, 0.12);
    for (let i = 0; i < 4; i++) part(g, box(0.033, 0.004, 0.036), black, 0, uy - 0.03 - i * 0.022, uz + 0.004 + i * 0.003, 0.12);
  } else if (id === "extAR" && M.magTip) {
    // Băng mở rộng: nối dài phía dưới băng đạn (chạy theo hoạt ảnh nạp).
    const [x, y, z, rx] = M.magTip;
    part(g, box(0.035, 0.08, 0.074), mat("#2a2b28"), x, y - 0.03, z, rx);
    part(g, box(0.037, 0.012, 0.078), black, x, y - 0.07, z - Math.sin(rx) * 0.04, rx);
    out.parent = "magazine";
  } else if (id === "extSR") {
    // Kar98k: hộp tiếp đạn rời dưới thân súng (+5 viên).
    part(g, box(0.034, 0.07, 0.11), mat("#232422"), 0, -0.1, 0.02);
    part(g, box(0.036, 0.01, 0.112), black, 0, -0.135, 0.02);
  }
  return out;
}
// Phụ kiện gộp 1 geometry màu (súng người khác + vật phẩm trên đất). center=true:
// dời về tâm (vật phẩm nằm đất); ngược lại giữ toạ độ súng (để gắn lên súng).
const bakedAtt = new Map();
export function bakeAttachment(id, kind, mergeGeometries, center = false) {
  const key = id + "|" + kind + "|" + center;
  let geo = bakedAtt.get(key);
  if (geo) return geo;
  const a = buildAttachment(id, kind);
  const holder = new THREE.Group();
  holder.add(a.obj);
  if (a.parent === "magazine") {
    const b = (MOUNTS[kind] || MOUNTS.ranger).magBase;
    if (b) {
      a.obj.position.set(b[0], b[1], b[2]);
      a.obj.rotation.x = b[3];
    }
  }
  geo = bakeModel(holder, mergeGeometries, true);
  if (center) {
    geo.computeBoundingBox();
    const c = geo.boundingBox.getCenter(new THREE.Vector3());
    geo.translate(-c.x, -c.y, -c.z);
  }
  geo.computeBoundingBox();
  bakedAtt.set(key, geo);
  return geo;
}

// ---------------------------------------------------------------------------
// Tia lửa đầu nòng: 3 mặt phẳng chéo nhau dùng texture hình sao sinh bằng canvas,
// hoà màu cộng (additive). Mesh tạo MỘT lần, mỗi phát chỉ bật/tắt + xoay ngẫu nhiên.
// ---------------------------------------------------------------------------
let flashTexture = null;
function getFlashTexture() {
  if (flashTexture) return flashTexture;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d");
  const grd = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,235,1)");
  grd.addColorStop(0.18, "rgba(255,226,140,0.95)");
  grd.addColorStop(0.45, "rgba(255,150,40,0.45)");
  grd.addColorStop(1, "rgba(255,90,0,0)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 128, 128);
  // Các tia nhọn toả ra như chớp nòng thật.
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + Math.random() * 0.3;
    const len = 40 + Math.random() * 22;
    ctx.fillStyle = "rgba(255,210,120,0.55)";
    ctx.beginPath();
    ctx.moveTo(64 + Math.cos(a + 1.57) * 6, 64 + Math.sin(a + 1.57) * 6);
    ctx.lineTo(64 + Math.cos(a) * len, 64 + Math.sin(a) * len);
    ctx.lineTo(64 + Math.cos(a - 1.57) * 6, 64 + Math.sin(a - 1.57) * 6);
    ctx.fill();
  }
  flashTexture = new THREE.CanvasTexture(c);
  flashTexture.colorSpace = THREE.SRGBColorSpace;
  return flashTexture;
}
export function makeMuzzleFlash(size = 1) {
  const material = new THREE.MeshBasicMaterial({
    map: getFlashTexture(),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const g = new THREE.Group();
  // Mặt nhìn thẳng từ đầu nòng + 2 mặt dọc theo hướng bắn (thấy từ bên cạnh).
  const front = new THREE.Mesh(
    new THREE.PlaneGeometry(0.22 * size, 0.22 * size),
    material,
  );
  g.add(front);
  for (const r of [0, Math.PI / 2]) {
    const side = new THREE.Mesh(
      new THREE.PlaneGeometry(0.12 * size, 0.34 * size),
      material,
    );
    side.rotation.set(Math.PI / 2, 0, r);
    side.position.z = -0.12 * size;
    g.add(side);
  }
  g.visible = false;
  g.renderOrder = 5;
  g.userData.front = front;
  return g;
}
// Bật chớp nòng với góc xoay / kích thước ngẫu nhiên nhẹ để mỗi phát khác nhau.
export function fireMuzzleFlash(flash) {
  flash.visible = true;
  flash.rotation.z = Math.random() * Math.PI * 2;
  const s = 0.8 + Math.random() * 0.45;
  flash.scale.set(s, s, 0.8 + Math.random() * 0.5);
}

// Gộp một mô hình súng thành MỘT geometry màu theo đỉnh (1 draw call).
// doubleSided=false (loot): bỏ các mặt 2 phía như ống red dot rỗng;
// doubleSided=true (súng trên tay người khác): giữ lại để đủ hình ống ngắm.
function bakeModel(group, mergeGeometries, doubleSided) {
  group.updateMatrixWorld(true);
  const parts = [];
  const color = new THREE.Color();
  group.traverse((o) => {
    if (!o.isMesh || o.userData.redDot) return;
    if (!doubleSided && o.material.side === THREE.DoubleSide) return;
    let geo = o.geometry.clone();
    if (geo.index) geo = geo.toNonIndexed();
    geo.applyMatrix4(o.matrixWorld);
    for (const key of Object.keys(geo.attributes))
      if (key !== "position" && key !== "normal") geo.deleteAttribute(key);
    color.set(o.material.color);
    const colors = new Float32Array(geo.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) {
      colors[i] = color.r;
      colors[i + 1] = color.g;
      colors[i + 2] = color.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    parts.push(geo);
  });
  return mergeGeometries(parts, false);
}
export function weaponToColoredGeometry(group, mergeGeometries) {
  return bakeModel(group, mergeGeometries, false);
}

// Súng trên tay người chơi khác: toàn bộ khẩu là MỘT mesh (chỉ tia lửa đầu nòng
// do game.js gắn riêng). Geometry + material tạo đúng 1 lần cho mỗi loại súng và
// dùng chung cho mọi nhân vật; mỗi người chỉ tạo Group + Mesh nhỏ.
const bakedWeapons = new Map();
export const bakedWeaponMat = new THREE.MeshLambertMaterial({ vertexColors: true });
export function buildBakedWeapon(kind, mergeGeometries) {
  const key = kind === "sniper" || kind === "beryl" ? kind : "ranger";
  let entry = bakedWeapons.get(key);
  if (!entry) {
    const model =
      key === "sniper" ? buildKar98() : key === "beryl" ? buildBeryl() : buildAug();
    entry = {
      geometry: bakeModel(model, mergeGeometries, true),
      muzzle: model.userData.muzzle.clone(),
    };
    bakedWeapons.set(key, entry);
  }
  const g = new THREE.Group();
  g.add(new THREE.Mesh(entry.geometry, bakedWeaponMat));
  g.userData = { muzzle: entry.muzzle.clone(), kind: key };
  return g;
}
