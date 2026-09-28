// Mô hình súng dùng chung cho: súng cầm tay (góc nhìn thứ nhất), súng trên tay
// người chơi khác và súng rơi dưới đất (loot). Toạ độ "chuẩn" của mỗi mô hình:
// gốc (0,0,0) nằm trên trục nòng ngay tại tay cầm, nòng hướng về -Z, đơn vị mét
// (kích thước thật). Mỗi mô hình trả về Group kèm userData:
//   muzzle   — Vector3 đầu nòng (để đặt tia lửa / vệt đạn)
//   magazine — mesh băng đạn (hoạt ảnh nạp đạn)
//   sightY   — độ cao tâm ống ngắm so với trục nòng (để ngắm trúng tâm)
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
  part(g, box(0.012, 0.018, 0.05), steel, 0.035, 0.005, -0.06); // tay kéo khóa nòng
  // Thước ngắm cơ khí (thước sau + đầu ruồi) vẫn giữ, nằm thấp dưới kính ngắm.
  const ironY = 0.075;
  part(g, box(0.03, ironY - 0.045, 0.03), black, 0, (ironY + 0.045) / 2 - 0.01, -0.12);
  part(g, box(0.034, 0.012, 0.02), black, 0, ironY - 0.004, -0.12);
  for (const side of [-1, 1]) part(g, box(0.008, 0.028, 0.012), black, side * 0.016, ironY + 0.004, -0.57);
  part(g, box(0.004, 0.022, 0.006), black, 0, ironY - 0.004, -0.57); // đầu ruồi
  part(g, box(0.03, 0.05, 0.03), black, 0, 0.03, -0.57); // đế đầu ruồi
  // Kính ngắm toàn ảnh (holographic) trên ray nắp che bụi — khác hẳn ống tròn
  // của AUG: thân hộp vuông, cửa sổ chữ nhật có mái che, lưới ngắm vòng tròn đỏ
  // + chấm giữa. Đường ngắm (tâm cửa sổ) ở độ cao sightY.
  const sightY = 0.132;
  const sightZ = -0.01;
  part(g, box(0.026, 0.01, 0.2), black, 0, 0.063, -0.01); // ray Picatinny
  for (let i = 0; i < 7; i++) part(g, box(0.03, 0.004, 0.008), steel, 0, 0.069, -0.1 + i * 0.03);
  const winW = 0.058,
    winH = 0.044,
    depth = 0.07,
    frame = 0.006;
  const bodyTop = sightY - winH / 2;
  part(g, box(winW + 2 * frame, bodyTop - 0.068, depth + 0.02), polymer, 0, (bodyTop + 0.068) / 2, sightZ); // thân pin/đèn
  part(g, box(0.014, 0.012, 0.03), steel, (winW + 2 * frame) / 2 + 0.005, bodyTop - 0.012, sightZ); // núm độ sáng
  for (const side of [-1, 1])
    part(g, box(frame, winH, depth), black, side * (winW + frame) / 2, sightY, sightZ); // hai vách
  part(g, box(winW + 2 * frame, frame, depth + 0.012), black, 0, sightY + (winH + frame) / 2, sightZ - 0.004); // mái che
  // Viền cửa sổ trước (mỏng) để thấy rõ khung chữ nhật khi ngắm.
  part(g, box(winW + 2 * frame, 0.004, 0.006), black, 0, bodyTop + 0.002, sightZ - depth / 2);
  const glass = part(
    g,
    new THREE.PlaneGeometry(winW, winH),
    new THREE.MeshBasicMaterial({
      color: 0x2a4a55,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    0,
    sightY,
    sightZ - depth / 2 + 0.004,
  );
  glass.renderOrder = 2;
  glass.userData.redDot = true;
  // Lưới ngắm: vòng tròn 65 MOA + chấm giữa, vẽ bằng canvas, hoà màu cộng.
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d");
  ctx.shadowColor = "rgba(255,40,30,0.9)";
  ctx.shadowBlur = 6;
  ctx.strokeStyle = "rgba(255,70,50,0.95)";
  ctx.lineWidth = 3.2;
  ctx.beginPath();
  ctx.arc(64, 64, 44, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,90,70,1)";
  ctx.beginPath();
  ctx.arc(64, 64, 4.2, 0, Math.PI * 2);
  ctx.fill();
  const reticleTex = new THREE.CanvasTexture(c);
  reticleTex.colorSpace = THREE.SRGBColorSpace;
  const reticle = part(
    g,
    new THREE.PlaneGeometry(0.024, 0.024),
    new THREE.MeshBasicMaterial({
      map: reticleTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
    0,
    sightY,
    sightZ - depth / 2 + 0.002,
  );
  reticle.renderOrder = 3;
  reticle.userData.redDot = true;
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
  g.userData = { muzzle: new THREE.Vector3(0, 0, -0.69), magazine, sightY, kind: "beryl" };
  return g;
}

// ---------------------------------------------------------------------------
// AUG A3 (bullpup) + red dot
// ---------------------------------------------------------------------------
export function buildAug() {
  const g = new THREE.Group();
  const polymer = mat("#56613f"); // thân nhựa xanh olive đặc trưng của AUG
  const polymerDark = mat("#444d33");
  const metal = mat("#1c1e1b");
  const steel = mat("#3a3d38");
  // Thân chính dạng bullpup: khối bo tròn chạy từ báng ra tới trước cò.
  const shell = part(
    g,
    new THREE.CapsuleGeometry(0.055, 0.34, 6, 12).rotateX(Math.PI / 2),
    polymer,
    0,
    -0.035,
    0.12,
  );
  shell.scale.set(0.82, 1.2, 1);
  part(g, box(0.085, 0.1, 0.2), polymer, 0, -0.07, 0.2); // bụng báng
  part(g, box(0.09, 0.13, 0.03), polymerDark, 0, -0.055, 0.345); // đệm báng
  part(g, box(0.08, 0.05, 0.26), polymerDark, 0, 0.03, 0.1); // lưng thân
  // Ống bao nòng + nòng + loa che lửa.
  part(g, tubeZ(0.034, 0.038, 0.16), steel, 0, 0, -0.16);
  part(g, tubeZ(0.016, 0.016, 0.26), metal, 0, 0, -0.35);
  part(g, tubeZ(0.022, 0.02, 0.07, 8), metal, 0, 0, -0.5);
  for (let i = 0; i < 4; i++)
    part(
      g,
      box(0.006, 0.03, 0.04),
      metal,
      Math.cos(i * 1.57) * 0.02,
      Math.sin(i * 1.57) * 0.02,
      -0.52,
    );
  // Báng cầm liền khung che cò lớn (đặc trưng AUG) + tay cầm trước gập.
  part(g, box(0.04, 0.12, 0.05), polymerDark, 0, -0.11, -0.02, 0.28);
  part(g, box(0.035, 0.02, 0.17), polymer, 0, -0.17, -0.04);
  part(g, box(0.035, 0.1, 0.02), polymer, 0, -0.12, -0.12);
  part(g, box(0.03, 0.12, 0.035), polymerDark, 0, -0.1, -0.2, -0.12);
  // Băng đạn nhựa trong khói phía sau tay cầm.
  const magazine = part(
    g,
    box(0.034, 0.17, 0.075),
    mat("#5b5f5c", { transparent: true, opacity: 0.85 }),
    0,
    -0.14,
    0.1,
    0.18,
  );
  part(magazine, box(0.036, 0.02, 0.078), metal, 0, -0.08, 0); // đế băng
  // Ray trên + red dot dạng ống.
  part(g, box(0.03, 0.018, 0.2), metal, 0, 0.066, -0.02);
  const sightY = 0.13;
  part(
    g,
    box(0.034, sightY - 0.075 - 0.02, 0.05),
    metal,
    0,
    (0.075 + sightY - 0.03) / 2,
    -0.02,
  ); // chân đế ống
  // Ống red dot rỗng: chỉ có thành ống và hai vành hình khuyên (KHÔNG có nắp
  // đặc che tầm nhìn). Kính trong, ngả tối nhẹ; chấm đỏ phát sáng ở giữa.
  const R = 0.03;
  const tube = new THREE.Mesh(
    new THREE.CylinderGeometry(R, R, 0.07, 24, 1, true).rotateX(Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: "#121412", side: THREE.DoubleSide }),
  );
  tube.position.set(0, sightY, -0.02);
  g.add(tube);
  for (const z of [-0.055, 0.015])
    part(g, new THREE.TorusGeometry(R, 0.0045, 6, 24), metal, 0, sightY, z);
  part(g, box(0.012, 0.012, 0.018), metal, R + 0.004, sightY, -0.02); // núm chỉnh
  const lens = part(
    g,
    new THREE.CircleGeometry(R - 0.002, 24),
    new THREE.MeshBasicMaterial({
      color: 0x14231d,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    0,
    sightY,
    -0.05,
  );
  lens.renderOrder = 2;
  lens.userData.redDot = true; // lớp kính chỉ dùng ở góc nhìn thứ nhất, không gộp
  const dot = part(
    g,
    new THREE.SphereGeometry(0.0012, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff2a1f, toneMapped: false }),
    0,
    sightY,
    -0.052,
  );
  // Quầng sáng nhẹ quanh chấm đỏ (cộng màu, không che tầm nhìn).
  const glowCanvas = document.createElement("canvas");
  glowCanvas.width = glowCanvas.height = 32;
  const gc = glowCanvas.getContext("2d");
  const grd = gc.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, "rgba(255,70,50,1)");
  grd.addColorStop(0.35, "rgba(255,40,30,0.5)");
  grd.addColorStop(1, "rgba(255,0,0,0)");
  gc.fillStyle = grd;
  gc.fillRect(0, 0, 32, 32);
  const glow = part(
    g,
    new THREE.PlaneGeometry(0.009, 0.009),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(glowCanvas),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
    0,
    sightY,
    -0.0515,
  );
  glow.renderOrder = 3;
  glow.userData.redDot = true;
  dot.userData.redDot = true;
  g.userData = {
    muzzle: new THREE.Vector3(0, 0, -0.54),
    magazine,
    sightY,
    kind: "aug",
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
  // Ống ngắm 8x trên ngàm.
  const sightY = 0.085;
  for (const z of [-0.08, 0.1])
    part(g, box(0.026, sightY - 0.02, 0.022), metal, 0, sightY / 2, z);
  part(g, tubeZ(0.02, 0.02, 0.28, 16), blued, 0, sightY, 0.0);
  part(g, tubeZ(0.034, 0.02, 0.1, 16), blued, 0, sightY, -0.18); // loa vật kính
  part(g, tubeZ(0.024, 0.03, 0.08, 16), blued, 0, sightY, 0.17); // loa thị kính
  part(
    g,
    new THREE.CylinderGeometry(0.012, 0.012, 0.03, 10),
    metal,
    0,
    sightY + 0.03,
    0.0,
  ); // núm chỉnh
  part(
    g,
    new THREE.CylinderGeometry(0.012, 0.012, 0.03, 10).rotateZ(Math.PI / 2),
    metal,
    0.03,
    sightY,
    0.0,
  );
  part(
    g,
    new THREE.CircleGeometry(0.03, 16),
    new THREE.MeshBasicMaterial({ color: 0x5e8ea0 }),
    0,
    sightY,
    -0.231,
    0,
    Math.PI,
    0,
  );
  magazine.userData.fromTop = true;
  g.userData = {
    muzzle: new THREE.Vector3(0, 0, -0.96),
    magazine,
    bolt,
    sightY,
    kind: "kar98",
  };
  return g;
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
const bakedWeaponMat = new THREE.MeshLambertMaterial({ vertexColors: true });
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
