// Last Drop — bản Windows (.exe). Mở game trực tiếp từ máy chủ online (cùng máy
// chủ với bản web), nên sửa game trên máy chủ là mọi người có bản mới ngay, không
// cần phát lại file .exe. Lần đầu chạy (hoặc khi không vào được máy chủ) hiện màn
// hình nhập địa chỉ máy chủ; địa chỉ được lưu lại cho lần sau.
const { app, BrowserWindow, ipcMain, globalShortcut, Menu, shell } = require("electron");
const path = require("path");
const fs = require("fs");

// Chạy game mượt khi cửa sổ bị che / thu nhỏ: không để Chromium hãm nhịp
// (bản web hay bị "đứng hình / mất tiếng" khi đổi tab chính vì lý do này).
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
// Âm thanh tự phát, không cần bấm trước.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const configFile = () => path.join(app.getPath("userData"), "config.json");
function readConfig() {
  let base = {};
  try {
    base = JSON.parse(fs.readFileSync(path.join(__dirname, "config.default.json"), "utf8"));
  } catch {}
  try {
    return { ...base, ...JSON.parse(fs.readFileSync(configFile(), "utf8")) };
  } catch {
    return base;
  }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
}
function normalizeUrl(input) {
  let url = String(input || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = (/^(localhost|127\.|192\.168\.|10\.)/.test(url) ? "http://" : "https://") + url;
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

let win = null;
function showLauncher(error = "") {
  const cfg = readConfig();
  win.loadFile(path.join(__dirname, "launcher.html"), { query: { url: cfg.serverUrl || "", error } });
}
function openGame(url) {
  win.loadURL(url).catch(() => {});
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0d100b",
    title: "Last Drop",
    icon: path.join(__dirname, "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null); // không có menu → Ctrl+W, Ctrl+R... không đóng / tải lại cửa sổ giữa trận
  win.maximize();

  // Không vào được máy chủ → quay lại màn hình nhập địa chỉ, kèm lỗi.
  win.webContents.on("did-fail-load", (_e, code, desc, url, isMain) => {
    if (isMain && !url.startsWith("file:")) showLauncher(`Không kết nối được máy chủ (${desc || code}).`);
  });
  // Liên kết ra ngoài (nếu có) mở bằng trình duyệt mặc định.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  // F11: bật / tắt toàn màn hình · Ctrl+Shift+S: đổi máy chủ.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F11") {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    } else if (input.control && input.shift && input.key.toLowerCase() === "s") {
      showLauncher();
      event.preventDefault();
    }
  });

  const url = normalizeUrl(readConfig().serverUrl);
  if (url) openGame(url);
  else showLauncher();
}

ipcMain.handle("ld:connect", (_e, raw) => {
  const url = normalizeUrl(raw);
  if (!url) return { ok: false, error: "Địa chỉ máy chủ không hợp lệ." };
  writeConfig({ ...readConfig(), serverUrl: url });
  openGame(url);
  return { ok: true };
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => globalShortcut.unregisterAll());
