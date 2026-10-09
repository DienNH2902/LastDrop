// Bầu trời: tán khí quyển + mây kiểu HOẠT HÌNH (cụm mây tròn mềm, viền mờ) được
// VẼ SẴN 1 LẦN vào ảnh nền 6 mặt (cube map) lúc dựng map. Khi chơi, mỗi khung hình
// chỉ còn 1 phép đọc texture + mặt trời tính bằng vài phép toán — không còn chạy
// hàng chục lớp nhiễu cho từng điểm ảnh trời như trước.
// Hướng mặt trời lấy từ đúng ánh nắng đổ bóng của map (SUN_DIR).
import * as THREE from "three";

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // luôn ở đáy depth: chỉ tô điểm ảnh chưa có vật thể
}`;

// ---- Shader NƯỚNG (chạy 6 lần lúc tải map): nền trời + mây hoạt hình ----
const BAKE_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm3(vec2 p) { // ÍT lớp nhiễu → hình khối tròn, mềm (không chi tiết như ảnh chụp)
  float s = 0.0, a = 0.55;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = mat2(0.8, -0.6, 0.6, 0.8) * p * 2.1 + 7.3; a *= 0.45; }
  return s;
}
void main() {
  vec3 dir = normalize(vDir);
  vec3 sun = normalize(uSunDir);
  float el = dir.y, up = clamp(el, 0.0, 1.0);
  float mu = clamp(dot(dir, sun), -1.0, 1.0);
  float grad = pow(1.0 - up, 3.0);
  vec3 sky = mix(uZenith, uHorizon, grad);
  sky *= 0.9 + 0.2 * (0.5 + 0.5 * mu);
  vec3 col = sky;
  if (el > 0.0) {
    float t = 1.0 / (el + 0.06);
    vec2 p = dir.xz * t * 0.75;
    // Cụm mây tròn: ngưỡng RỘNG → viền mờ, mềm như vẽ tay.
    float d = fbm3(p * 0.9) + 0.25 * fbm3(p * 2.2 + 3.0);
    float c = smoothstep(0.50, 0.80, d);
    // Bóng hoạt hình 2 tông: đáy xanh xám nhạt, thân trắng ngà, mép hướng nắng sáng hơn.
    float belly = smoothstep(0.55, 0.95, fbm3(p * 0.9 + vec2(0.0, 0.18)));
    vec3 cloud = mix(vec3(1.0, 0.99, 0.96), vec3(0.78, 0.84, 0.93), belly * 0.7);
    cloud += vec3(1.0, 0.94, 0.8) * pow(max(mu, 0.0), 5.0) * 0.25;
    float fade = smoothstep(0.0, 0.25, el); // xa chân trời: mỏng dần, hoà vào trời
    col = mix(col, cloud, c * fade * 0.92);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

// ---- Shader HIỂN THỊ (mỗi khung hình): đọc ảnh nền + mặt trời + sương chân trời ----
const SHOW_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform samplerCube uSky;
uniform vec3 uSunDir;
uniform vec3 uFog;
uniform float uHaze;
uniform float uSpin;
uniform float uUseTex;
void main() {
  vec3 dir = normalize(vDir);
  // Mây trôi rất chậm: chỉ xoay hướng đọc texture (miễn phí), mặt trời đứng yên.
  float c = cos(uSpin), s = sin(uSpin);
  vec3 sd = vec3(c * dir.x - s * dir.z, dir.y, s * dir.x + c * dir.z);
  vec3 col = uUseTex > 0.5 ? textureCube(uSky, sd).rgb
    : mix(vec3(0.05, 0.25, 0.75), vec3(0.47, 0.72, 0.93), pow(1.0 - clamp(dir.y, 0.0, 1.0), 3.0)); // dự phòng
  vec3 sun = normalize(uSunDir);
  float mu = clamp(dot(dir, sun), -1.0, 1.0);
  float el = dir.y, up = clamp(el, 0.0, 1.0);
  vec3 sunCol = vec3(1.0, 0.93, 0.78);
  col += sunCol * (pow(max(mu, 0.0), 6.0) * 0.20 + pow(max(mu, 0.0), 40.0) * 0.55); // quầng nắng
  float ang = acos(mu);
  float disc = smoothstep(0.0215, 0.0185, ang);
  float vis = smoothstep(-0.02, 0.06, el);
  col += (vec3(1.0, 0.97, 0.88) * (disc * 60.0 + exp(-ang * ang / 1.125e-4) * 40.0) + sunCol * exp(-ang * 11.0) * 1.55 + vec3(1.0, 0.88, 0.62) * exp(-ang * 3.2) * 0.22) * vis;
  col = mix(col, uFog, clamp(pow(1.0 - up, 14.0) * (0.8 + 0.2 * uHaze), 0.0, 1.0));
  col = mix(col, uFog, smoothstep(0.0, -0.06, el));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Ảnh nền GẮN VỚI renderer đã vẽ nó: mỗi trận game tạo renderer (WebGL) MỚI —
// dùng lại texture của renderer cũ là texture rỗng → trời ĐEN (lỗi "lâu lâu trời tối").
let bakedTarget = null,
  bakedFor = null;
function bakeSky(renderer, sunDirection) {
  if (bakedTarget && bakedFor === renderer) return bakedTarget;
  // KHÔNG gọi dispose(): renderer cũ đã bị huỷ (bộ nhớ GPU của nó đã được giải phóng cùng
  // context) — gọi dispose lúc này làm Three.js lỗi → dừng giữa chừng lúc dựng map (màn hình 1 màu).
  bakedTarget = null;
  // 8-bit (UnsignedByte): MỌI card đồ hoạ đều vẽ được vào loại này. Bản trước dùng
  // HalfFloat — máy không hỗ trợ vẽ vào texture float thì ảnh nền ra ĐEN (chỉ còn mặt trời).
  const target = new THREE.WebGLCubeRenderTarget(256, { type: THREE.UnsignedByteType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const bakeScene = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: sunDirection.clone().normalize() },
      uZenith: { value: new THREE.Color("#3f86e0") },
      uHorizon: { value: new THREE.Color("#b5dcf7") },
    },
    vertexShader: `varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: BAKE_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
  });
  const geo = new THREE.SphereGeometry(10, 32, 16);
  bakeScene.add(new THREE.Mesh(geo, mat));
  const cam = new THREE.CubeCamera(0.1, 100, target);
  const prevTone = renderer.toneMapping;
  cam.update(renderer, bakeScene);
  renderer.toneMapping = prevTone;
  geo.dispose();
  mat.dispose();
  // Kiểm tra ảnh nền thật sự có màu (đọc 1 điểm ảnh mặt bên, 1 lần lúc tải map).
  // Nếu vẫn đen (driver lạ) → dùng trời tính trực tiếp (gradient rẻ, không mây).
  try {
    const px = new Uint8Array(4);
    renderer.readRenderTargetPixels(target, 128, 200, 1, 1, px, 0);
    target.ok = px[0] + px[1] + px[2] > 30;
  } catch {
    target.ok = false;
  }
  bakedTarget = target;
  bakedFor = renderer;
  return target;
}

export function createSky(sunDirection, renderer) {
  const target = bakeSky(renderer, sunDirection);
  const uniforms = {
    uSky: { value: target.texture },
    uSunDir: { value: sunDirection.clone().normalize() },
    uFog: { value: new THREE.Color("#879c88") },
    uHaze: { value: 0 },
    uSpin: { value: 0 },
    uUseTex: { value: target.ok === false ? 0 : 1 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: SHOW_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1e6; // vẽ sau cùng nhóm đục → early-z bỏ điểm ảnh đã có vật thể
  mesh.name = "sky-dome";
  return {
    mesh,
    uniforms,
    update(camera, fogColor, time, haze) {
      mesh.position.copy(camera.position);
      uniforms.uSpin.value = time * 0.004;
      uniforms.uHaze.value = haze;
      if (fogColor) uniforms.uFog.value.copy(fogColor);
    },
    setSunDirection(v) {
      uniforms.uSunDir.value.copy(v).normalize();
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
