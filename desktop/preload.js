// Cầu nối an toàn giữa màn hình nhập máy chủ (launcher.html) và tiến trình chính.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("lastDrop", {
  connect: (url) => ipcRenderer.invoke("ld:connect", url),
  isDesktop: true,
});
