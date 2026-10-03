// Phụ kiện súng dùng chung SERVER (require) và CLIENT (<script> → window.LDAttach):
// một nguồn duy nhất cho tên, ô gắn, súng tương thích và hiệu ứng của từng món.
//
// Ô gắn (slot): scope (ống ngắm) · muzzle (đầu nòng) · grip (tay cầm) · mag (băng đạn).
// Súng: ranger (AUG) · beryl (Beryl M762) · sniper (Kar98k).
(function (root) {
  const AUTO = ["ranger", "beryl"];
  const ALL = ["ranger", "beryl", "sniper"];
  const ATTACH = {
    reddot: { slot: "scope", guns: ALL, name: "RED DOT", short: "RED DOT", zoom: 1.25 },
    x4: { slot: "scope", guns: ALL, name: "ỐNG NGẮM 4X", short: "4X", zoom: 4 },
    x8: { slot: "scope", guns: ["sniper"], name: "ỐNG NGẮM 8X", short: "8X", zoom: 8, minZoom: 6 },
    comp: { slot: "muzzle", guns: ALL, name: "NÒNG GIẢM GIẬT", short: "GIẢM GIẬT", recoil: [0.78, 0.7] },
    supp: { slot: "muzzle", guns: ALL, name: "NÒNG GIẢM THANH", short: "GIẢM THANH", suppressed: true },
    vgrip: { slot: "grip", guns: AUTO, name: "TAY CẦM DỌC", short: "TAY CẦM", recoil: [0.66, 0.8] },
    extAR: { slot: "mag", guns: AUTO, name: "BĂNG ĐẠN MỞ RỘNG (SÚNG TRƯỜNG)", short: "BĂNG +10", magBonus: 10 },
    extSR: { slot: "mag", guns: ["sniper"], name: "BĂNG ĐẠN MỞ RỘNG (BẮN TỈA)", short: "BĂNG +5", magBonus: 5 },
  };
  const SLOTS = ["scope", "muzzle", "grip", "mag"];
  const SLOT_NAMES = { scope: "ỐNG NGẮM", muzzle: "ĐẦU NÒNG", grip: "TAY CẦM", mag: "BĂNG ĐẠN" };
  const PACK_MAX = 8; // số phụ kiện tối đa để trong balo
  // Số món rải trên map mỗi trận.
  const SPAWNS = { reddot: 30, x4: 20, x8: 11, comp: 20, supp: 16, vgrip: 20, extAR: 20, extSR: 11 };

  const fits = (id, weapon) => Boolean(ATTACH[id] && ATTACH[id].guns.includes(weapon));
  // att (object slot → id) <-> chuỗi gọn "scope|muzzle|grip|mag" để gửi qua mạng.
  const encode = (att) => SLOTS.map((s) => (att && att[s]) || "").join("|");
  const decode = (str) => {
    const out = {};
    String(str || "")
      .split("|")
      .forEach((id, i) => {
        if (id && ATTACH[id]) out[SLOTS[i]] = id;
      });
    return out;
  };
  const magBonus = (att) => (att && att.mag && ATTACH[att.mag] ? ATTACH[att.mag].magBonus || 0 : 0);
  // Hệ số giật [dọc, ngang] — nhân dồn các phụ kiện đang gắn.
  function recoilScale(att) {
    let v = 1,
      h = 1;
    for (const s of SLOTS) {
      const r = att && att[s] && ATTACH[att[s]] && ATTACH[att[s]].recoil;
      if (r) {
        v *= r[0];
        h *= r[1];
      }
    }
    return [v, h];
  }
  const suppressed = (att) => Boolean(att && att.muzzle === "supp");

  const api = { ATTACH, SLOTS, SLOT_NAMES, PACK_MAX, SPAWNS, fits, encode, decode, magBonus, recoilScale, suppressed };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LDAttach = api;
})(typeof self !== "undefined" ? self : this);
