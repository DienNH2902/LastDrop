// Nhân vật người chơi (góc nhìn người khác): khung xương có khớp hông / gối /
// vai / khuỷu, hai tay bám đúng tay cầm súng bằng IK 2 khớp, hoạt ảnh mượt cho
// đứng, đi chậm, chạy, ngồi (khom), nằm, peek, bơi, rơi tự do, dù và ngồi xe.
// Vẫn giữ đầu mèo + nón + giáp.
//
// HITBOX: các hộp dưới đây là NGUỒN SỰ THẬT, server (server.js) dùng đúng các
// số này. Hộp đã bao trọn nón và áo giáp đang hiển thị → bắn trúng nón = trúng
// đầu, trúng giáp = trúng thân. Toạ độ cục bộ: chân ở y = 0, mặt nhìn về -Z.
import * as THREE from "three";

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

const matCache = new Map();
function mat(color) {
  if (!matCache.has(color))
    matCache.set(color, new THREE.MeshLambertMaterial({ color }));
  return matCache.get(color);
}
const capsule = (r, len) => new THREE.CapsuleGeometry(r, len, 4, 10);
function add(parent, geometry, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
function limb(parent, x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

// headMaterials: 6 mặt đầu mèo; earMat: vật liệu tai.
export function buildAvatar(headMaterials, earMat) {
  const root = new THREE.Group();
  const pants = mat("#3b4232"),
    shirt = mat("#5a5f48"),
    vestMat = mat("#3a4838"),
    pouch = mat("#4d5a45"),
    glove = mat("#26261f"),
    boot = mat("#2a2420"),
    strap = mat("#2c3226");
  const hips = limb(root, 0, STAND_HIP, 0);
  add(hips, new THREE.BoxGeometry(0.34, 0.18, 0.22), pants, 0, -0.02, 0);
  add(hips, new THREE.BoxGeometry(0.36, 0.05, 0.24), strap, 0, 0.06, 0); // thắt lưng
  const legs = [];
  for (const side of [-1, 1]) {
    const thigh = limb(hips, side * 0.1, -0.04, 0);
    add(thigh, capsule(0.078, THIGH - 0.12), pants, 0, -THIGH / 2, 0);
    add(thigh, new THREE.BoxGeometry(0.09, 0.12, 0.05), pouch, side * 0.07, -0.18, 0); // túi đùi
    const knee = limb(thigh, 0, -THIGH, 0);
    add(knee, capsule(0.064, SHIN - 0.1), pants, 0, -SHIN / 2, 0);
    add(knee, new THREE.SphereGeometry(0.07, 8, 6), pouch, 0, 0, -0.04); // đệm gối
    const ankle = limb(knee, 0, -SHIN, 0);
    add(ankle, new THREE.BoxGeometry(0.12, 0.11, 0.26), boot, 0, -0.03, -0.045);
    legs.push({ thigh, knee, ankle });
  }
  const torso = limb(hips, 0, 0.04, 0);
  const chest = add(torso, capsule(0.15, 0.26), shirt, 0, 0.27, 0);
  chest.scale.set(1.25, 1, 0.8);
  // Áo giáp: thân + túi đạn phía trước + đệm vai; nằm gọn trong hitbox thân.
  const vest = add(torso, new THREE.CapsuleGeometry(0.18, 0.18, 4, 12), vestMat, 0, 0.29, 0);
  vest.scale.set(1.55, 1, 1); // áo giáp bo tròn (rộng 0.56 × cao 0.54 × dày 0.36)
  for (const x of [-0.16, 0, 0.16])
    add(torso, new THREE.BoxGeometry(0.13, 0.15, 0.06), pouch, x, 0.16, -0.2);
  add(torso, new THREE.BoxGeometry(0.4, 0.16, 0.05), pouch, 0, 0.42, -0.19); // tấm ngực
  for (const side of [-1, 1]) {
    const pad = add(torso, new THREE.SphereGeometry(0.12, 10, 8), vestMat, side * 0.25, 0.52, 0);
    pad.scale.set(1, 0.6, 1.1);
  }
  add(torso, new THREE.CylinderGeometry(0.07, 0.08, 0.12, 10), shirt, 0, 0.6, 0); // cổ
  // Đầu mèo + tai + nón.
  const head = limb(torso, 0, 0.8, 0);
  add(head, new THREE.BoxGeometry(0.46, 0.44, 0.42), headMaterials);
  const earGeo = new THREE.ConeGeometry(0.075, 0.15, 4);
  for (const side of [-1, 1]) {
    const ear = add(head, earGeo, earMat, side * 0.25, 0.16, 0.04);
    ear.rotation.set(0, Math.PI / 4, -side * 0.95); // tai thò ra hai bên dưới vành nón
  }
  const helmet = limb(head, 0, 0.12, 0);
  const dome = add(helmet, new THREE.SphereGeometry(0.27, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat("#5f6c46"));
  dome.scale.set(1, 0.72, 1.02);
  add(helmet, new THREE.CylinderGeometry(0.3, 0.31, 0.04, 18), mat("#4a5537"), 0, 0, 0); // vành
  // Tay: vai → khuỷu → bàn tay; hướng được giải bằng IK mỗi khung hình.
  const arms = [];
  for (const side of [-1, 1]) {
    const shoulder = limb(torso, side * 0.26, 0.5, 0);
    add(shoulder, capsule(0.055, UPPER_ARM - 0.1), shirt, 0, -UPPER_ARM / 2, 0);
    const elbow = limb(shoulder, 0, -UPPER_ARM, 0);
    add(elbow, capsule(0.05, FOREARM - 0.1), shirt, 0, -FOREARM / 2, 0);
    add(elbow, new THREE.SphereGeometry(0.052, 8, 6), glove, 0, -FOREARM, 0);
    arms.push({ shoulder, elbow, side });
  }
  // Giá súng gắn trên thân (theo thân khi nghiêng / khom).
  const weaponMount = limb(torso, 0.07, 0.33, -0.25);
  // Hitbox vô hình, trùng khớp server — dùng cho ngắm bắn phía client.
  const hitboxes = {};
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  for (const [stance, set] of Object.entries(HITBOX)) {
    const group = new THREE.Group();
    for (const part of ["head", "torso", "legs"]) {
      const { c, h } = set[part];
      const m = add(group, new THREE.BoxGeometry(h[0] * 2, h[1] * 2, h[2] * 2), hitMat, ...c);
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
function solveArm(arm, target) {
  const s = arm.shoulder.position;
  _d.subVectors(target, s);
  const L = Math.min(Math.max(_d.length(), 0.08), UPPER_ARM + FOREARM - 0.002);
  _d.normalize();
  const cosA = (UPPER_ARM * UPPER_ARM + L * L - FOREARM * FOREARM) / (2 * UPPER_ARM * L);
  const a = Math.acos(Math.min(1, Math.max(-1, cosA)));
  // Khuỷu tay chĩa xuống dưới và ra ngoài.
  _hint.set(arm.side * 0.6, -1, 0.2).normalize();
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
  const stride = stance === "crouch" ? 0.9 : stance === "prone" ? 0.7 : state.slow ? 1.0 : 1.5;
  pose.phase = (pose.phase || 0) + (moving ? (speed / stride) * Math.PI * dt : 0);
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
    leg.ankle.rotation.x = -(pose.thigh + pose.knee) * (stance === "seat" ? 0.4 : 0.5) * (stance === "crouch" ? 0.9 : 0.3);
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
    if (grip && (stance === "stand" || stance === "crouch" || stance === "prone")) {
      // Điểm cầm (toạ độ của giá súng) → toạ độ thân.
      _t.copy(i === 1 ? grip.right : grip.left)
        .applyEuler(rig.weaponMount.rotation)
        .add(rig.weaponMount.position);
      solveArm(arm, _t);
    } else if (stance === "seat") {
      _t.set(arm.side * (state.driver ? 0.2 : 0.18), state.driver ? 0.34 : 0.02, state.driver ? -0.42 : -0.3);
      solveArm(arm, _t);
    } else if (stance === "chute") {
      _t.set(arm.side * 0.3, 0.98, -0.05);
      solveArm(arm, _t);
    } else if (stance === "air") {
      _t.set(arm.side * 0.62, 0.62 + Math.sin(pose.phase + i) * 0.03, -0.1);
      solveArm(arm, _t);
    } else if (stance === "swim") {
      const s = Math.sin(pose.phase + i * Math.PI);
      _t.set(arm.side * (0.3 + s * 0.15), 0.35, -0.35 - Math.cos(pose.phase + i * Math.PI) * 0.15);
      solveArm(arm, _t);
    } else {
      _t.set(arm.side * 0.3, 0.05 + (i ? sinP : -sinP) * 0.05, -0.05 - (i ? sinP : -sinP) * 0.12);
      solveArm(arm, _t);
    }
  });
}
