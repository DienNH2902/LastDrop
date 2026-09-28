// Nhân vật người chơi (góc nhìn người khác): khung xương có khớp hông / gối /
// vai / khuỷu, hai tay bám đúng tay cầm súng bằng IK 2 khớp, hoạt ảnh mượt cho
// đứng, đi chậm, chạy, ngồi (khom), nằm, peek, bơi, rơi tự do, dù và ngồi xe.
// Vẫn giữ đầu mèo + nón + giáp.
//
// HITBOX: các hộp dưới đây là NGUỒN SỰ THẬT, server (server.js) dùng đúng các
// số này. Hộp đã bao trọn nón và áo giáp đang hiển thị → bắn trúng nón = trúng
// đầu, trúng giáp = trúng thân. Toạ độ cục bộ: chân ở y = 0, mặt nhìn về -Z.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export const HITBOX = {
  stand: {
    head: { c: [0, 1.8, 0], h: [0.28, 0.3, 0.27] },
    torso: { c: [0, 1.14, 0], h: [0.31, 0.36, 0.21] },
    legs: { c: [0, 0.45, 0], h: [0.2, 0.45, 0.15] },
    peek: { head: 0.32, torso: 0.2 },
  },
  crouch: {
    head: { c: [0, 1.34, -0.25], h: [0.28, 0.3, 0.27] },
    torso: { c: [0, 0.8, -0.08], h: [0.31, 0.3, 0.24] },
    legs: { c: [0, 0.3, -0.15], h: [0.2, 0.3, 0.3] },
    peek: { head: 0.24, torso: 0.14 },
  },
};

const STAND_HIP = 0.9;
const THIGH = 0.42;
const SHIN = 0.4;
const UPPER_ARM = 0.31;
const FOREARM = 0.32;

// ---------------------------------------------------------------------------
// GỘP MESH: mọi khối nhỏ nằm trên cùng một xương được "nướng" thành MỘT geometry
// màu theo đỉnh (vertex color), tạo đúng 1 lần cho cả trận và dùng chung cho mọi
// nhân vật. Mỗi người chơi chỉ còn ~14 mesh (hông, 6 đoạn chân, thân, đầu + phần
// nón/tai, 4 đoạn tay) thay vì ~100 mesh, và không phải tạo lại geometry.
// Xương (Group) vẫn tách riêng nên IK / hoạt ảnh chạy y như cũ.
// ---------------------------------------------------------------------------
const bakedMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const _tmp = new THREE.Object3D();
// spec: { g: geometry, c: màu, p: [x,y,z], r: [rx,ry,rz], s: [sx,sy,sz] }
function bake(specs) {
  const geos = specs.map(
    ({ g, c, p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1] }) => {
      _tmp.position.set(...p);
      _tmp.rotation.set(...r);
      _tmp.scale.set(...s);
      _tmp.updateMatrix();
      const geo = g.clone();
      geo.applyMatrix4(_tmp.matrix);
      g.dispose();
      const color = new THREE.Color(c);
      const n = geo.attributes.position.count;
      const colors = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geo.deleteAttribute("uv"); // mọi khối gộp đều dùng màu đỉnh, không cần UV
      return geo;
    },
  );
  return mergeGeometries(geos, false);
}
const capsule = (r, len) => new THREE.CapsuleGeometry(r, len, 4, 10);
const box = (x, y, z) => new THREE.BoxGeometry(x, y, z);

const C = {
  pants: "#3b4232",
  shirt: "#5a5f48",
  vest: "#3a4838",
  pouch: "#4d5a45",
  glove: "#26261f",
  boot: "#2a2420",
  strap: "#2c3226",
  helmet: "#5f6c46",
  brim: "#4a5537",
};

// Đầu mèo: 6 mặt hộp đọc từ MỘT texture atlas 3×2 (xem game.js): ô = chỉ số mặt
// BoxGeometry (+x, -x, +y, -y, +z, -z), hàng 0 nằm trên cùng của ảnh.
function atlasHeadGeometry() {
  const g = new THREE.BoxGeometry(0.46, 0.44, 0.42);
  const uv = g.attributes.uv;
  const pad = 0.004; // chừa mép nhỏ để mipmap không lẫn sang ô bên cạnh
  for (let f = 0; f < 6; f++) {
    const col = f % 3,
      row = Math.floor(f / 3);
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      const u = uv.getX(k),
        v = uv.getY(k);
      uv.setXY(
        k,
        (col + pad + u * (1 - 2 * pad)) / 3,
        (1 - row + pad + v * (1 - 2 * pad)) / 2,
      );
    }
  }
  uv.needsUpdate = true;
  return g;
}

let assets = null;
function getAssets(earColor) {
  if (assets) return assets;
  const thighGeo = (side) =>
    bake([
      { g: capsule(0.078, THIGH - 0.12), c: C.pants, p: [0, -THIGH / 2, 0] },
      { g: box(0.09, 0.12, 0.05), c: C.pouch, p: [side * 0.07, -0.18, 0] }, // túi đùi
    ]);
  const ears = [-1, 1].map((side) => ({
    g: new THREE.ConeGeometry(0.075, 0.15, 4),
    c: earColor,
    p: [side * 0.25, 0.16, 0.04],
    r: [0, Math.PI / 4, -side * 0.95], // tai thò ra hai bên dưới vành nón
  }));
  // Hitbox vô hình (dùng chung), trùng khớp server.
  const hitGeo = {};
  for (const [stance, set] of Object.entries(HITBOX))
    hitGeo[stance] = ["head", "torso", "legs"].map((part) => {
      const { c, h } = set[part];
      return {
        part,
        c,
        geo: new THREE.BoxGeometry(h[0] * 2, h[1] * 2, h[2] * 2),
      };
    });
  assets = {
    hips: bake([
      { g: box(0.34, 0.18, 0.22), c: C.pants, p: [0, -0.02, 0] },
      { g: box(0.36, 0.05, 0.24), c: C.strap, p: [0, 0.06, 0] }, // thắt lưng
    ]),
    thigh: { "-1": thighGeo(-1), 1: thighGeo(1) },
    knee: bake([
      { g: capsule(0.064, SHIN - 0.1), c: C.pants, p: [0, -SHIN / 2, 0] },
      { g: new THREE.SphereGeometry(0.07, 8, 6), c: C.pouch, p: [0, 0, -0.04] }, // đệm gối
    ]),
    ankle: bake([
      { g: box(0.12, 0.11, 0.26), c: C.boot, p: [0, -0.03, -0.045] },
    ]),
    // Thân: áo + áo giáp + túi đạn + tấm ngực + đệm vai + cổ; nằm trong hitbox thân.
    torso: bake([
      {
        g: capsule(0.15, 0.26),
        c: C.shirt,
        p: [0, 0.27, 0],
        s: [1.25, 1, 0.8],
      },
      {
        g: new THREE.CapsuleGeometry(0.18, 0.18, 4, 12),
        c: C.vest,
        p: [0, 0.29, 0],
        s: [1.55, 1, 1],
      },
      ...[-0.16, 0, 0.16].map((x) => ({
        g: box(0.13, 0.15, 0.06),
        c: C.pouch,
        p: [x, 0.16, -0.2],
      })),
      { g: box(0.4, 0.16, 0.05), c: C.pouch, p: [0, 0.42, -0.19] }, // tấm ngực
      ...[-1, 1].map((side) => ({
        g: new THREE.SphereGeometry(0.12, 10, 8),
        c: C.vest,
        p: [side * 0.25, 0.52, 0],
        s: [1, 0.6, 1.1],
      })),
      {
        g: new THREE.CylinderGeometry(0.07, 0.08, 0.12, 10),
        c: C.shirt,
        p: [0, 0.6, 0],
      }, // cổ
    ]),
    head: atlasHeadGeometry(),
    // Nón + vành + tai: một mesh riêng (màu đỉnh), gắn cùng xương đầu.
    headgear: bake([
      {
        g: new THREE.SphereGeometry(
          0.27,
          16,
          10,
          0,
          Math.PI * 2,
          0,
          Math.PI / 2,
        ),
        c: C.helmet,
        p: [0, 0.12, 0],
        s: [1, 0.72, 1.02],
      },
      {
        g: new THREE.CylinderGeometry(0.3, 0.31, 0.04, 18),
        c: C.brim,
        p: [0, 0.12, 0],
      }, // vành
      ...ears,
    ]),
    shoulder: bake([
      {
        g: capsule(0.055, UPPER_ARM - 0.1),
        c: C.shirt,
        p: [0, -UPPER_ARM / 2, 0],
      },
    ]),
    elbow: bake([
      { g: capsule(0.05, FOREARM - 0.1), c: C.shirt, p: [0, -FOREARM / 2, 0] },
      {
        g: new THREE.SphereGeometry(0.052, 8, 6),
        c: C.glove,
        p: [0, -FOREARM, 0],
      },
    ]),
    hitGeo,
    hitMat: new THREE.MeshBasicMaterial({ visible: false }),
  };
  return assets;
}

function limb(parent, x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}
function mesh(parent, geometry, material) {
  const m = new THREE.Mesh(geometry, material);
  parent.add(m);
  return m;
}

// headMaterial: MỘT material dùng atlas đầu mèo (game.js: catHeadMaterials);
// earMat: vật liệu tai (chỉ lấy màu để nướng vào mesh nón).
export function buildAvatar(headMaterial, earMat) {
  const A = getAssets(earMat.color);
  const root = new THREE.Group();
  const hips = limb(root, 0, STAND_HIP, 0);
  mesh(hips, A.hips, bakedMat);
  const legs = [];
  for (const side of [-1, 1]) {
    const thigh = limb(hips, side * 0.1, -0.04, 0);
    mesh(thigh, A.thigh[side], bakedMat);
    const knee = limb(thigh, 0, -THIGH, 0);
    mesh(knee, A.knee, bakedMat);
    const ankle = limb(knee, 0, -SHIN, 0);
    mesh(ankle, A.ankle, bakedMat);
    legs.push({ thigh, knee, ankle });
  }
  const torso = limb(hips, 0, 0.04, 0);
  mesh(torso, A.torso, bakedMat);
  const head = limb(torso, 0, 0.8, 0);
  mesh(head, A.head, headMaterial);
  mesh(head, A.headgear, bakedMat);
  // Tay: vai → khuỷu → bàn tay; hướng được giải bằng IK mỗi khung hình.
  const arms = [];
  for (const side of [-1, 1]) {
    const shoulder = limb(torso, side * 0.26, 0.5, 0);
    mesh(shoulder, A.shoulder, bakedMat);
    const elbow = limb(shoulder, 0, -UPPER_ARM, 0);
    mesh(elbow, A.elbow, bakedMat);
    arms.push({ shoulder, elbow, side });
  }
  // Giá súng gắn trên thân (theo thân khi nghiêng / khom).
  const weaponMount = limb(torso, 0.07, 0.33, -0.25);
  // Hitbox vô hình, trùng khớp server — dùng cho ngắm bắn phía client.
  const hitboxes = {};
  for (const stance of Object.keys(HITBOX)) {
    const group = new THREE.Group();
    for (const { part, c, geo } of A.hitGeo[stance]) {
      const m = mesh(group, geo, A.hitMat);
      m.position.set(...c);
      m.userData.hitPart = part === "head" ? "head" : "body";
    }
    group.visible = false;
    root.add(group);
    hitboxes[stance] = group;
  }
  return {
    root,
    rig: { hips, torso, head, legs, arms, weaponMount, hitboxes },
  };
}

// --- IK hai khớp cho cánh tay (vai → khuỷu → tay) trong không gian thân ---
const _d = new THREE.Vector3(),
  _n = new THREE.Vector3(),
  _u = new THREE.Vector3(),
  _e = new THREE.Vector3(),
  _f = new THREE.Vector3(),
  _hint = new THREE.Vector3(),
  _q = new THREE.Quaternion(),
  _qi = new THREE.Quaternion();
const DOWN = new THREE.Vector3(0, -1, 0);
// hintMode: "gun"  — cầm súng: khuỷu chĩa xuống và hơi ra ngoài;
//           "free" — tay tự do: khuỷu chĩa ra SAU, cẳng tay gập về trước như người thật.
function solveArm(arm, target, hintMode = "gun") {
  const s = arm.shoulder.position;
  _d.subVectors(target, s);
  const L = Math.min(Math.max(_d.length(), 0.08), UPPER_ARM + FOREARM - 0.002);
  _d.normalize();
  const cosA =
    (UPPER_ARM * UPPER_ARM + L * L - FOREARM * FOREARM) / (2 * UPPER_ARM * L);
  const a = Math.acos(Math.min(1, Math.max(-1, cosA)));
  if (hintMode === "gun") _hint.set(arm.side * 0.6, -1, 0.2).normalize();
  else _hint.set(arm.side * 0.35, -0.2, 1).normalize();
  _n.crossVectors(_d, _hint).normalize();
  _u.copy(_d).applyAxisAngle(_n, -a);
  if (_u.dot(_hint) < 0) _u.copy(_d).applyAxisAngle(_n, a);
  _e.copy(s).addScaledVector(_u, UPPER_ARM);
  _f.subVectors(target, _e).normalize();
  _q.setFromUnitVectors(DOWN, _u);
  arm.shoulder.quaternion.copy(_q);
  _qi.copy(_q).invert();
  arm.elbow.quaternion.setFromUnitVectors(DOWN, _f).premultiply(_qi);
}
const damp = (current, target, rate, dt) =>
  current + (target - current) * Math.min(1, rate * dt);

// Gọi mỗi khung hình. state: { stance, speed, slow, reloading, driver,
// weaponGrip:{right:Vector3,left:Vector3} (toạ độ trong mount), now }
const _t = new THREE.Vector3();
export function poseAvatar(rig, pose, state, dt) {
  const { stance } = state;
  const speed = Math.min(state.speed || 0, 8);
  const moving = speed > 0.3;
  // Nhịp bước: 1 chu kỳ = 2 bước; bước dài hơn khi chạy.
  const stride =
    stance === "crouch"
      ? 0.9
      : stance === "prone"
        ? 0.7
        : state.slow
          ? 1.0
          : 1.5;
  pose.phase =
    (pose.phase || 0) + (moving ? (speed / stride) * Math.PI * dt : 0);
  const sinP = Math.sin(pose.phase),
    cosP = Math.cos(pose.phase);
  const run = !state.slow && speed > 4.5;
  let hipY = STAND_HIP,
    lean = 0.04,
    // Quy ước: rotation.x DƯƠNG đưa đùi ra TRƯỚC; gối gập = góc ÂM (cẳng chân
    // quặp về sau như người thật).
    thighBase = 0,
    kneeBase = -0.06,
    swing = 0,
    kneeSwing = 0,
    bob = 0,
    roll = 0;
  if (stance === "crouch") {
    hipY = 0.5;
    lean = 0.3;
    thighBase = 1.2;
    kneeBase = -2.05;
    swing = moving ? 0.28 : 0;
    kneeSwing = moving ? 0.25 : 0;
  } else if (stance === "seat") {
    hipY = 0.46;
    lean = -0.08;
    thighBase = 1.45;
    kneeBase = -1.5;
  } else if (stance === "air") {
    lean = 0;
    thighBase = -0.25;
    kneeBase = -0.6;
    swing = 0.12;
  } else if (stance === "chute") {
    lean = -0.05;
    thighBase = 0.15;
    kneeBase = -0.25;
    swing = 0.1;
  } else if (stance === "prone") {
    lean = 0;
    thighBase = 0;
    kneeBase = -0.05;
    swing = moving ? 0.22 : 0;
    kneeSwing = moving ? 0.4 : 0;
  } else if (stance === "jump") {
    // Bật nhảy: co gối, đùi đưa ra trước, thân hơi cúi — nhìn tự nhiên từ xa.
    lean = 0.12;
    thighBase = 0.55;
    kneeBase = -1.05;
  } else if (stance === "swim") {
    lean = 0.1;
    swing = 0.35;
    kneeSwing = 0.4;
  } else {
    // Đứng / đi / chạy: biên độ theo tốc độ, chạy thì người đổ về trước.
    swing = moving ? Math.min(run ? 0.62 : 0.42, 0.1 + speed * 0.075) : 0;
    kneeSwing = moving ? (run ? 1.0 : 0.6) : 0;
    lean = 0.04 + (moving ? (run ? 0.16 : 0.07) : 0);
    bob = moving ? Math.abs(cosP) * (run ? 0.06 : 0.03) : 0;
    roll = moving ? sinP * 0.04 : 0;
  }
  if (stance === "air" || stance === "chute" || stance === "swim")
    pose.phase += dt * (stance === "swim" ? 3 : 1.4);
  pose.hipY = damp(pose.hipY ?? hipY, hipY, 10, dt);
  pose.lean = damp(pose.lean ?? lean, lean, 8, dt);
  pose.thigh = damp(pose.thigh ?? thighBase, thighBase, 10, dt);
  pose.knee = damp(pose.knee ?? kneeBase, kneeBase, 10, dt);
  pose.swing = damp(pose.swing ?? 0, swing, 8, dt);
  pose.kneeSwing = damp(pose.kneeSwing ?? 0, kneeSwing, 8, dt);
  rig.hips.position.y = pose.hipY - bob;
  rig.hips.rotation.y = roll * 2;
  rig.torso.rotation.x = -pose.lean;
  rig.torso.rotation.y = -roll * 2.5;
  rig.legs.forEach((leg, i) => {
    const s = i === 0 ? sinP : -sinP;
    leg.thigh.rotation.x = pose.thigh - s * pose.swing;
    // Gối gập (cẳng chân quặp về sau) khi chân đưa ra sau / nhấc lên.
    leg.knee.rotation.x = pose.knee - Math.max(0, s) * pose.kneeSwing;
    leg.ankle.rotation.x =
      -(pose.thigh + pose.knee) *
      (stance === "seat" ? 0.4 : 0.5) *
      (stance === "crouch" ? 0.9 : 0.3);
    leg.thigh.rotation.z = stance === "air" ? (i === 0 ? -0.35 : 0.35) : 0;
  });
  // Nạp đạn: hạ súng xuống, tay trái rời báng về phía băng đạn.
  const reload = state.reloading ? 1 : 0;
  pose.reload = damp(pose.reload ?? 0, reload, 8, dt);
  // Nằm sấp: toàn thân được xoay nằm xuống (trục cao của thân → hướng trước
  // mặt, trục -Z cục bộ → xuống đất). Ngẩng đầu và đưa súng ra trước mặt,
  // nòng chĩa về phía trước chứ không cắm xuống đất.
  const prone = stance === "prone" ? 1 : 0;
  pose.prone = damp(pose.prone ?? prone, prone, 8, dt);
  rig.head.rotation.x = pose.prone * 1.25;
  rig.weaponMount.rotation.x =
    pose.prone * (Math.PI / 2) + pose.reload * 0.35 + (state.kick || 0);
  // Nằm: báng tì vai phải, súng nằm cạnh má (không xuyên qua đầu mèo).
  rig.weaponMount.position.set(
    0.07 + pose.prone * 0.15,
    0.33 + pose.prone * 0.27 - pose.reload * 0.06,
    -0.25 + pose.prone * 0.45,
  );
  // Tay: cầm súng (IK) hoặc tư thế riêng khi bay / lái xe / bơi.
  const grip = state.weaponGrip;
  rig.arms.forEach((arm, i) => {
    if (
      grip &&
      (stance === "stand" ||
        stance === "crouch" ||
        stance === "prone" ||
        stance === "jump")
    ) {
      // Điểm cầm (toạ độ của giá súng) → toạ độ thân.
      _t.copy(i === 1 ? grip.right : grip.left)
        .applyEuler(rig.weaponMount.rotation)
        .add(rig.weaponMount.position);
      solveArm(arm, _t);
    } else if (stance === "seat") {
      _t.set(
        arm.side * (state.driver ? 0.2 : 0.18),
        state.driver ? 0.34 : 0.02,
        state.driver ? -0.42 : -0.3,
      );
      solveArm(arm, _t, "free");
    } else if (stance === "chute") {
      _t.set(arm.side * 0.3, 0.98, -0.05);
      solveArm(arm, _t, "free");
    } else if (stance === "air") {
      _t.set(arm.side * 0.62, 0.62 + Math.sin(pose.phase + i) * 0.03, -0.1);
      solveArm(arm, _t, "free");
    } else if (stance === "swim") {
      const s = Math.sin(pose.phase + i * Math.PI);
      _t.set(
        arm.side * (0.3 + s * 0.15),
        0.35,
        -0.35 - Math.cos(pose.phase + i * Math.PI) * 0.15,
      );
      solveArm(arm, _t, "free");
    } else {
      // Tay không cầm súng: buông tự nhiên dọc thân, đánh nhẹ theo nhịp bước.
      const swingArm = i ? sinP : -sinP;
      _t.set(
        arm.side * 0.31,
        -0.08 + Math.abs(swingArm) * 0.03,
        -0.03 - swingArm * 0.14,
      );
      solveArm(arm, _t, "free");
    }
  });
}
