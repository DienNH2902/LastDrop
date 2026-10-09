// Chất liệu tường + mảng trang trí (decal) cho nhà — VẼ 1 LẦN bằng canvas khi
// dựng map (cache dùng lại cho các trận sau), không tải ảnh ngoài, không vẽ lại
// khi chơi. Mỗi chất liệu là 1 texture lát lặp (2 m × 2 m); toàn bộ decal nằm
// chung 1 atlas → mỗi loại chỉ tốn 1 draw call sau khi gộp mesh.
import * as THREE from "three";

export const WALL_TILE = 2; // 1 ô texture = 2 m tường
const S = 512; // px mỗi ô chất liệu
const CELL = 256; // px mỗi ô decal trong atlas 4 × 4

// ---- tiện ích vẽ ----
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const canvas = (w, h = w) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")];
};
const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;
// Hạt nhiễu mịn (bụi, sần) phủ toàn ô.
function speckle(g, r, w, h, n, color, size = 2) {
  g.fillStyle = color;
  for (let i = 0; i < n; i++) g.fillRect(r() * w, r() * h, size * (0.5 + r()), size * (0.5 + r()));
}
// Vẽ lặp quanh mép (texture lát liền không đường nối).
function wrapped(w, h, x, y, draw) {
  for (const dx of [-w, 0, w]) for (const dy of [-h, 0, h]) draw(x + dx, y + dy);
}
// Đường nứt gấp khúc (có nhánh).
function crackLine(g, r, x, y, len, angle, width, color, depth = 0) {
  g.strokeStyle = color;
  g.lineWidth = width;
  g.lineCap = "round";
  g.beginPath();
  g.moveTo(x, y);
  let a = angle;
  for (let i = 0; i < len; i++) {
    a += (r() - 0.5) * 0.9;
    x += Math.cos(a) * 6;
    y += Math.sin(a) * 6;
    g.lineTo(x, y);
    if (depth < 2 && r() < 0.08) {
      g.stroke();
      crackLine(g, r, x, y, len * 0.45, a + (r() < 0.5 ? 0.8 : -0.8), width * 0.6, color, depth + 1);
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      g.moveTo(x, y);
    }
  }
  g.stroke();
}
// Vân gỗ: các đường lượn sóng dọc theo tấm ván.
function grain(g, r, x0, y0, w, h, horizontal, color, lines = 9) {
  g.strokeStyle = color;
  for (let i = 0; i < lines; i++) {
    g.lineWidth = 0.6 + r() * 1.4;
    g.beginPath();
    const off = r() * (horizontal ? h : w);
    const amp = 1 + r() * 3,
      freq = 0.01 + r() * 0.03,
      ph = r() * 6;
    for (let t = 0; t <= (horizontal ? w : h); t += 6) {
      const d = off + Math.sin(t * freq + ph) * amp + Math.sin(t * freq * 3.1) * amp * 0.3;
      if (horizontal) g.lineTo(x0 + t, y0 + d);
      else g.lineTo(x0 + d, y0 + t);
    }
    g.stroke();
  }
}
function knot(g, r, x, y, s, color) {
  g.strokeStyle = color;
  for (let k = 0; k < 4; k++) {
    g.lineWidth = 1;
    g.beginPath();
    g.ellipse(x, y, s * (1 + k * 0.6), s * 0.5 * (1 + k * 0.6), r() * 0.3, 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = color;
  g.beginPath();
  g.ellipse(x, y, s * 0.7, s * 0.35, 0, 0, Math.PI * 2);
  g.fill();
}
// Ván gỗ (ngang / dọc): weathered = bạc màu, nứt, đinh rỉ, mép tối.
function planks(g, r, { horizontal, rows, base, hueJ, light, weathered, battens }) {
  const step = S / rows;
  for (let i = 0; i < rows; i++) {
    const p0 = i * step;
    const L = light + (r() - 0.5) * 9;
    const color = hsl(base + (r() - 0.5) * hueJ, weathered ? 18 + r() * 10 : 38 + r() * 12, L);
    g.fillStyle = color;
    if (horizontal) g.fillRect(0, p0, S, step);
    else g.fillRect(p0, 0, step, S);
    grain(g, r, horizontal ? 0 : p0, horizontal ? p0 : 0, horizontal ? S : step, horizontal ? step : S, horizontal, hsl(base, 30, L - 12, 0.55), 7);
    if (r() < 0.5) knot(g, r, horizontal ? r() * S : p0 + step / 2, horizontal ? p0 + step / 2 : r() * S, 4 + r() * 4, hsl(base, 35, L - 20, 0.8));
    // khe ván + bóng mép
    g.fillStyle = hsl(base, 30, 12, weathered ? 0.95 : 0.6);
    if (horizontal) g.fillRect(0, p0, S, weathered ? 3 : 2);
    else g.fillRect(p0, 0, weathered ? 3 : 2, S);
    // đầu ván nối (so le)
    const joint = r() * S;
    if (horizontal) g.fillRect(joint, p0, 2, step);
    else g.fillRect(p0, joint, step, 2);
    if (weathered) {
      // vết nứt dọc thớ gỗ, xám bạc, đinh rỉ
      for (let k = 0; k < 2; k++)
        if (r() < 0.7) {
          const cx = horizontal ? r() * S : p0 + r() * step,
            cy = horizontal ? p0 + r() * step : r() * S;
          crackLine(g, r, cx, cy, 6 + r() * 10, horizontal ? (r() < 0.5 ? 0 : Math.PI) : Math.PI / 2, 1.4, "rgba(25,15,8,0.85)", 2);
        }
      g.fillStyle = "rgba(170,170,160,0.12)";
      g.fillRect(horizontal ? r() * S : p0, horizontal ? p0 : r() * S, horizontal ? 80 + r() * 160 : step, horizontal ? step : 80 + r() * 160);
      g.fillStyle = "rgba(90,45,20,0.85)";
      for (const t of [0.15, 0.85]) {
        const nx = horizontal ? joint + (t < 0.5 ? -5 : 5) : p0 + step * t,
          ny = horizontal ? p0 + step * t : joint + (t < 0.5 ? -5 : 5);
        g.fillRect(nx - 1.5, ny - 1.5, 3, 3);
      }
    }
  }
  if (battens) {
    // nẹp gỗ đè khe (kiểu nhà gỗ cổ)
    for (let i = 0; i < rows; i++) {
      const p = i * step - 5;
      g.fillStyle = hsl(base, 25, light - 14);
      if (horizontal) g.fillRect(0, p, S, 10);
      else g.fillRect(p, 0, 10, S);
      grain(g, r, horizontal ? 0 : p, horizontal ? p : 0, horizontal ? S : 10, horizontal ? 10 : S, horizontal, "rgba(0,0,0,0.25)", 2);
    }
  }
  speckle(g, r, S, S, 900, "rgba(0,0,0,0.08)", 2);
}
function finishTexture(c, repeat = true) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

// ---- chất liệu tường ----
function makeExtWood() {
  // Ngoài nhà (Rừng): ván gỗ ngang đã bạc màu mưa nắng, nứt, đinh rỉ, mép dưới ẩm sẫm.
  const [c, g] = canvas(S);
  const r = rng(11);
  planks(g, r, { horizontal: true, rows: 8, base: 28, hueJ: 8, light: 47, weathered: true });
  return finishTexture(c);
}
function makeOldWood() {
  // Thành Cổ: ván dọc cổ có nẹp, vân gỗ rõ, sậm màu theo thời gian.
  const [c, g] = canvas(S);
  const r = rng(23);
  planks(g, r, { horizontal: false, rows: 6, base: 24, hueJ: 10, light: 40, weathered: true, battens: true });
  return finishTexture(c);
}
function makePlaster() {
  // Sa mạc: tường trát vữa, sần, ố vàng, vết nứt chân chim.
  const [c, g] = canvas(S);
  const r = rng(37);
  g.fillStyle = "#c2a57a";
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 70; i++) {
    const x = r() * S,
      y = r() * S,
      rad = 20 + r() * 70;
    wrapped(S, S, x, y, (px, py) => {
      const gr = g.createRadialGradient(px, py, 0, px, py, rad);
      gr.addColorStop(0, `rgba(${r() < 0.5 ? "90,65,35" : "235,215,175"},${0.08 + r() * 0.1})`);
      gr.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gr;
      g.fillRect(px - rad, py - rad, rad * 2, rad * 2);
    });
  }
  speckle(g, r, S, S, 4000, "rgba(70,50,30,0.15)", 2);
  speckle(g, r, S, S, 2500, "rgba(255,240,210,0.15)", 2);
  for (let i = 0; i < 4; i++) crackLine(g, r, r() * S, r() * S, 8 + r() * 10, r() * 6, 1, "rgba(60,40,25,0.55)");
  return finishTexture(c);
}
function makeStone() {
  // Thành Cổ: tường đá hộc xếp lớp, mạch vữa sẫm, đá xám xanh rêu.
  const [c, g] = canvas(S);
  const r = rng(41);
  g.fillStyle = "#4b4a42";
  g.fillRect(0, 0, S, S);
  const rows = 7,
    rh = S / rows;
  for (let i = 0; i < rows; i++) {
    let x = r() * 60;
    while (x < S + 60) {
      const w = 55 + r() * 70,
        y = i * rh;
      const L = 40 + r() * 16,
        hue = 60 + r() * 50;
      wrapped(S, S, x, y, (px, py) => {
        g.fillStyle = hsl(hue, 6 + r() * 6, L);
        g.beginPath();
        g.roundRect(px + 3, py + 3, w - 6, rh - 6, 9);
        g.fill();
        const gr = g.createLinearGradient(px, py, px, py + rh);
        gr.addColorStop(0, "rgba(255,255,255,0.10)");
        gr.addColorStop(1, "rgba(0,0,0,0.28)");
        g.fillStyle = gr;
        g.beginPath();
        g.roundRect(px + 3, py + 3, w - 6, rh - 6, 9);
        g.fill();
      });
      x += w;
    }
  }
  speckle(g, r, S, S, 5000, "rgba(0,0,0,0.12)", 2);
  speckle(g, r, S, S, 2000, "rgba(255,255,255,0.08)", 2);
  return finishTexture(c);
}
function makeBrick() {
  // Thành Cổ: gạch nung xây so le, gạch đậm nhạt khác nhau, vữa xám, vài viên mẻ.
  const [c, g] = canvas(S);
  const r = rng(53);
  g.fillStyle = "#8f8676";
  g.fillRect(0, 0, S, S);
  const rows = 24,
    bh = S / rows,
    bw = S / 6;
  for (let i = 0; i < rows; i++) {
    const off = i % 2 ? bw / 2 : 0;
    for (let k = -1; k < 7; k++) {
      const x = k * bw + off,
        y = i * bh;
      g.fillStyle = hsl(10 + r() * 14, 40 + r() * 20, 30 + r() * 14);
      g.fillRect(x + 2, y + 2, bw - 4, bh - 4);
      if (r() < 0.25) {
        g.fillStyle = "rgba(0,0,0,0.25)";
        g.fillRect(x + 2, y + 2, bw - 4, bh * 0.35);
      }
      if (r() < 0.08) {
        g.fillStyle = "#6f675a";
        g.beginPath();
        g.arc(x + 2 + r() * bw, y + 2 + r() * bh, 4 + r() * 4, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  speckle(g, r, S, S, 3500, "rgba(0,0,0,0.13)", 2);
  return finishTexture(c);
}
function makeIntWood() {
  // TRONG NHÀ: ván ốp gỗ sáng màu, sạch, vân gỗ mịn, không nứt, không rêu.
  const [c, g] = canvas(S);
  const r = rng(67);
  planks(g, r, { horizontal: false, rows: 8, base: 30, hueJ: 6, light: 52, weathered: false });
  // len chân tường tối hơn
  g.fillStyle = "rgba(60,35,18,0.55)";
  g.fillRect(0, S - 10, S, 10);
  return finishTexture(c);
}
function makeShingle() {
  // Mái ngói gỗ cổ (Thành Cổ): lớp ngói lợp so le, mép dưới sẫm.
  const [c, g] = canvas(S);
  const r = rng(79);
  g.fillStyle = "#3a2a1c";
  g.fillRect(0, 0, S, S);
  const rows = 10,
    rh = S / rows;
  for (let i = 0; i < rows; i++) {
    const off = i % 2 ? 26 : 0;
    for (let x = -52 + off; x < S + 52; x += 52) {
      const L = 22 + r() * 12;
      g.fillStyle = hsl(24 + r() * 10, 30, L);
      g.fillRect(x + 2, i * rh, 48, rh - 3);
      grain(g, r, x + 2, i * rh, 48, rh - 3, false, "rgba(0,0,0,0.3)", 3);
      g.fillStyle = "rgba(0,0,0,0.45)";
      g.fillRect(x + 2, i * rh + rh - 6, 48, 4);
    }
  }
  return finishTexture(c);
}

// ---- atlas decal (4 × 4 ô, nền trong suốt) ----
export const DECAL = {
  peel: 0, // tróc sơn
  brick: 1, // bong vữa lộ gạch
  wood: 2, // bong vữa lộ ván gỗ
  graffiti1: 3,
  graffiti2: 4,
  graffiti3: 5,
  moss: 6,
  crack: 7,
  flyer1: 8,
  flyer2: 9,
  poster: 10, // poster quảng cáo LAST DROP
  stain: 11, // vệt ố nước mưa
  torn: 12, // poster cũ bị xé
  moss2: 13, // rêu leo mép tường
};
function blobPath(g, r, cx, cy, rad, jag = 0.35, n = 26) {
  g.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = rad * (1 - jag / 2 + r() * jag);
    const x = cx + Math.cos(a) * k * 1.25,
      y = cy + Math.sin(a) * k * 0.85;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
}
function drawDecalCell(g, idx, r) {
  const C = CELL,
    m = C / 2;
  g.save();
  switch (idx) {
    case DECAL.peel: {
      // Mảng sơn bong: lớp nền sẫm lộ ra, mép sơn quăn sáng.
      // Lớp sơn ngoài (xanh / trắng ngà) đã bong gần hết: còn từng mảng sơn quăn mép,
      // giữa các mảng lộ lớp nền bạc màu bên dưới.
      const paint = r() < 0.5 ? [120, 150, 140] : [214, 204, 178];
      blobPath(g, r, m, m, C * 0.34, 0.6);
      g.fillStyle = "rgba(150,138,118,0.9)"; // lớp nền lộ ra
      g.fill();
      for (let i = 0; i < 16; i++) {
        const fx = m + (r() - 0.5) * C * 0.75,
          fy = m + (r() - 0.5) * C * 0.6;
        blobPath(g, r, fx + 1.5, fy + 2, 8 + r() * 16, 0.8, 9);
        g.fillStyle = "rgba(30,22,15,0.45)"; // bóng mép sơn quăn
        g.fill();
        blobPath(g, r, fx, fy, 8 + r() * 16, 0.8, 9);
        g.fillStyle = `rgba(${paint[0]},${paint[1]},${paint[2]},0.95)`;
        g.fill();
      }
      g.lineWidth = 2;
      g.strokeStyle = "rgba(40,30,20,0.5)";
      blobPath(g, r, m, m, C * 0.34, 0.6);
      g.stroke();
      break;
    }
    case DECAL.brick:
    case DECAL.wood: {
      // Vữa bong lộ gạch / ván bên dưới: cắt theo hình mảng rách.
      blobPath(g, r, m, m, C * 0.36, 0.55);
      g.save();
      g.clip();
      if (idx === DECAL.brick) {
        g.fillStyle = "#8a8070";
        g.fillRect(0, 0, C, C);
        for (let y = 0; y < C; y += 16)
          for (let x = (y / 16) % 2 ? -24 : 0; x < C; x += 48) {
            g.fillStyle = hsl(10 + r() * 14, 45, 30 + r() * 12);
            g.fillRect(x + 2, y + 2, 44, 12);
          }
      } else {
        for (let x = 0; x < C; x += 28) {
          g.fillStyle = hsl(26, 25, 26 + r() * 10);
          g.fillRect(x, 0, 28, C);
          grain(g, r, x, 0, 28, C, false, "rgba(0,0,0,0.35)", 4);
          g.fillStyle = "rgba(0,0,0,0.6)";
          g.fillRect(x, 0, 2, C);
        }
      }
      g.restore();
      g.lineWidth = 4;
      g.strokeStyle = "rgba(240,228,200,0.9)";
      blobPath(g, r, m, m, C * 0.36, 0.55);
      g.stroke();
      break;
    }
    case DECAL.graffiti1:
    case DECAL.graffiti2: {
      // Chữ phun sơn có viền + vệt sơn chảy.
      const words = idx === DECAL.graffiti1 ? ["DROP", "ZONE"] : ["SỐNG", "SÓT"];
      const fill = idx === DECAL.graffiti1 ? "#c8ff1a" : "#ff4fa3",
        edge = idx === DECAL.graffiti1 ? "#1b3a8a" : "#202020";
      g.translate(m, m);
      g.rotate(-0.12 + r() * 0.1);
      g.font = "900 64px Impact, 'Arial Black', sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.lineJoin = "round";
      words.forEach((w, i) => {
        const y = (i - 0.5) * 66;
        g.lineWidth = 12;
        g.strokeStyle = edge;
        g.strokeText(w, 0, y);
        g.fillStyle = fill;
        g.fillText(w, 0, y);
      });
      g.strokeStyle = fill;
      g.lineWidth = 3;
      for (let i = 0; i < 7; i++) {
        const x = (r() - 0.5) * 170,
          y = 30 + r() * 30;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + (r() - 0.5) * 3, y + 20 + r() * 50);
        g.stroke();
      }
      break;
    }
    case DECAL.graffiti3: {
      // Hình vẽ bậy: đầu lâu + mũi tên + chữ ký.
      g.strokeStyle = "#e8e8e8";
      g.fillStyle = "#e8e8e8";
      g.lineWidth = 7;
      g.lineCap = "round";
      g.beginPath();
      g.arc(m - 30, m - 20, 46, Math.PI * 0.85, Math.PI * 2.15);
      g.lineTo(m + 6, m + 40);
      g.lineTo(m - 66, m + 40);
      g.closePath();
      g.stroke();
      g.beginPath();
      g.arc(m - 48, m - 18, 11, 0, Math.PI * 2);
      g.arc(m - 12, m - 18, 11, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "#ff5a2a";
      g.beginPath();
      g.moveTo(m + 30, m + 70);
      g.lineTo(m + 100, m - 20);
      g.moveTo(m + 100, m - 20);
      g.lineTo(m + 70, m - 18);
      g.moveTo(m + 100, m - 20);
      g.lineTo(m + 96, m + 10);
      g.stroke();
      g.font = "italic 900 30px 'Arial Black', sans-serif";
      g.fillStyle = "#4fd7ff";
      g.fillText("K.9", m + 30, m + 100);
      break;
    }
    case DECAL.moss:
    case DECAL.moss2: {
      // Rêu: đám xanh dày ở chân (mép dưới), lốm đốm thưa dần lên trên.
      const n = idx === DECAL.moss ? 900 : 600;
      for (let i = 0; i < n; i++) {
        const t = Math.pow(r(), idx === DECAL.moss ? 1.8 : 1.2);
        const y = C - t * C * 0.95,
          x = r() * C;
        if (idx === DECAL.moss2 && x > C * (0.35 + 0.3 * (1 - t))) continue; // leo theo mép trái
        // Mép trái / phải thưa dần + đỉnh lởm chởm → mảng rêu không thành hình chữ nhật.
        const edge = Math.min(x, C - x) / (C * 0.32);
        if (idx === DECAL.moss && r() > Math.min(1, edge * edge)) continue;
        if (idx === DECAL.moss && t > 0.35 + 0.4 * Math.abs(Math.sin(x * 0.045))) continue;
        g.fillStyle = hsl(80 + r() * 30, 35 + r() * 25, 18 + r() * 16, 0.55 + (1 - t) * 0.4);
        g.beginPath();
        g.arc(x, y, 3 + r() * 6 * (1 - t * 0.6), 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case DECAL.crack: {
      for (let i = 0; i < 3; i++) crackLine(g, r, m + (r() - 0.5) * 40, 20 + r() * 30, 22 + r() * 14, Math.PI / 2 + (r() - 0.5), 2.6, "rgba(20,14,10,0.9)");
      break;
    }
    case DECAL.flyer1:
    case DECAL.flyer2: {
      // Tờ rơi giấy dán băng keo: tiêu đề + dòng chữ + (tờ 2) dải xé số điện thoại.
      const w = 150,
        h = 200,
        x = m - w / 2,
        y = m - h / 2;
      g.translate(m, m);
      g.rotate((r() - 0.5) * 0.15);
      g.translate(-m, -m);
      g.fillStyle = idx === DECAL.flyer1 ? "#f2eedc" : "#f6e27a";
      g.fillRect(x, y, w, h);
      g.fillStyle = "rgba(0,0,0,0.07)";
      g.fillRect(x, y + h * 0.6, w, h * 0.4);
      g.fillStyle = "#222";
      g.textAlign = "center";
      g.font = "900 26px 'Arial Black', Arial, sans-serif";
      g.fillText(idx === DECAL.flyer1 ? "MẤT TÍCH" : "CẦN BÁN", m, y + 34);
      if (idx === DECAL.flyer1) {
        g.fillStyle = "#777";
        g.fillRect(m - 34, y + 48, 68, 62); // ảnh người mất tích
        g.fillStyle = "#555";
        g.beginPath();
        g.arc(m, y + 72, 15, 0, Math.PI * 2);
        g.fill();
        g.fillRect(m - 24, y + 90, 48, 20);
      }
      g.fillStyle = "#333";
      for (let k = 0; k < 5; k++) g.fillRect(x + 14, y + 122 + k * 12, w - 28 - r() * 30, 4);
      if (idx === DECAL.flyer2) {
        for (let k = 0; k < 7; k++) {
          g.fillStyle = k % 2 ? "#efd56a" : "#f6e27a";
          g.fillRect(x + k * (w / 7), y + h - 26, w / 7 - 2, 26);
          g.fillStyle = "#333";
          g.fillRect(x + k * (w / 7) + 8, y + h - 22, 3, 18);
        }
      }
      g.fillStyle = "rgba(230,230,200,0.75)"; // băng keo 2 góc trên
      g.fillRect(x - 10, y - 6, 36, 14);
      g.fillRect(x + w - 26, y - 6, 36, 14);
      break;
    }
    case DECAL.poster: {
      // Poster quảng cáo LAST DROP: nền tối, logo lục giác chanh, chữ lớn, góc rách.
      const w = 200,
        h = 236,
        x = m - w / 2,
        y = m - h / 2;
      g.fillStyle = "#14170f";
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + w, y);
      g.lineTo(x + w, y + h - 34);
      g.lineTo(x + w - 22, y + h - 18);
      g.lineTo(x + w - 40, y + h);
      g.lineTo(x, y + h);
      g.closePath();
      g.fill();
      g.strokeStyle = "#c8ff1a";
      g.lineWidth = 9;
      g.beginPath();
      for (let k = 0; k <= 6; k++) {
        const a = Math.PI / 6 + (k * Math.PI) / 3;
        const px = m + Math.cos(a) * 34,
          py = y + 62 + Math.sin(a) * 34;
        if (k === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.stroke();
      g.fillStyle = "#c8ff1a";
      g.fillRect(m - 10, y + 52, 20, 20);
      g.textAlign = "center";
      g.fillStyle = "#f3f3ed";
      g.font = "900 40px Impact, 'Arial Black', sans-serif";
      g.fillText("LAST DROP", m, y + 146);
      g.fillStyle = "#c8ff1a";
      g.font = "bold 13px Arial, sans-serif";
      g.fillText("ĐẤU TRƯỜNG SINH TỒN", m, y + 170);
      g.fillStyle = "#9aa08e";
      g.font = "bold 11px Arial, sans-serif";
      g.fillText("MÙA 01 · VÀO TRẬN NGAY", m, y + 192);
      g.fillStyle = "rgba(255,255,255,0.06)";
      g.fillRect(x, y + h * 0.5, w, 4);
      break;
    }
    case DECAL.stain: {
      // Vệt ố nước mưa chảy dọc từ mép trên.
      for (let i = 0; i < 9; i++) {
        const x = 20 + r() * (C - 40),
          w = 8 + r() * 22,
          len = C * (0.4 + r() * 0.6);
        const gr = g.createLinearGradient(0, 0, 0, len);
        gr.addColorStop(0, "rgba(40,30,15,0.55)");
        gr.addColorStop(1, "rgba(40,30,15,0)");
        g.fillStyle = gr;
        g.fillRect(x, 0, w, len);
      }
      break;
    }
    case DECAL.torn: {
      // Poster cũ bị xé dở: mảnh giấy bạc màu, mép rách lởm chởm.
      g.fillStyle = "#cbbf9a";
      g.beginPath();
      g.moveTo(40, 30);
      for (let x = 40; x <= 210; x += 10) g.lineTo(x, 30 + r() * 10);
      g.lineTo(215, 120 + r() * 40);
      for (let x = 210; x >= 40; x -= 12) g.lineTo(x, 150 + r() * 70);
      g.closePath();
      g.fill();
      g.fillStyle = "#9b3a2a";
      g.font = "900 34px Impact, sans-serif";
      g.fillText("TUY", 60, 90);
      g.fillStyle = "rgba(0,0,0,0.25)";
      for (let k = 0; k < 4; k++) g.fillRect(60, 110 + k * 12, 110 - r() * 40, 4);
      break;
    }
  }
  g.restore();
}
function makeDecalAtlas() {
  const [c, g] = canvas(CELL * 4);
  const r = rng(97);
  for (let i = 0; i < 16; i++) {
    g.save();
    g.translate((i % 4) * CELL, Math.floor(i / 4) * CELL);
    g.beginPath();
    g.rect(0, 0, CELL, CELL);
    g.clip();
    drawDecalCell(g, i, r);
    g.restore();
  }
  const t = finishTexture(c, false);
  t.anisotropy = 4;
  return t;
}

let cache = null;
// Texture + vật liệu (dùng chung mọi trận). Vật liệu Lambert → nhận bóng nướng sẵn.
export function wallMaterials() {
  if (cache) return cache;
  const lam = (map) => new THREE.MeshLambertMaterial({ map });
  cache = {
    extWood: lam(makeExtWood()),
    oldWood: lam(makeOldWood()),
    plaster: lam(makePlaster()),
    stone: lam(makeStone()),
    brick: lam(makeBrick()),
    intWood: lam(makeIntWood()),
    shingle: lam(makeShingle()),
    decal: new THREE.MeshLambertMaterial({
      map: makeDecalAtlas(),
      transparent: true,
      alphaTest: 0.04,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  };
  return cache;
}
// UV phẳng theo mét (chiếu theo pháp tuyến mặt) → texture lặp liền mạch qua các
// khúc tường cạnh nhau. Gọi khi hình học đã nằm trong toạ độ cục bộ của nhà.
export function planarUV(geo, tile = WALL_TILE) {
  const p = geo.attributes.position,
    n = geo.attributes.normal,
    uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)),
      ay = Math.abs(n.getY(i)),
      az = Math.abs(n.getZ(i));
    let u, v;
    if (ax >= ay && ax >= az) (u = p.getZ(i)), (v = p.getY(i));
    else if (az >= ay) (u = p.getX(i)), (v = p.getY(i));
    else (u = p.getX(i)), (v = p.getZ(i));
    uv.setXY(i, u / tile, v / tile);
  }
  uv.needsUpdate = true;
  return geo;
}
// Mảnh decal: hình chữ nhật w × h, UV trỏ vào ô `cell` của atlas.
export function decalGeometry(cell, w, h, flip = false, spin = 0) {
  const g = new THREE.PlaneGeometry(w, h);
  if (spin) g.rotateZ(spin);
  const col = cell % 4,
    row = Math.floor(cell / 4);
  const u0 = col / 4 + 0.002,
    u1 = (col + 1) / 4 - 0.002;
  const v1 = 1 - row / 4 - 0.002,
    v0 = 1 - (row + 1) / 4 + 0.002;
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i),
      v = uv.getY(i);
    uv.setXY(i, (flip ? u1 - (u1 - u0) * u : u0 + (u1 - u0) * u), v0 + (v1 - v0) * v);
  }
  return g;
}
