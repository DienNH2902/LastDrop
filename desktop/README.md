# Last Drop — bản Windows (.exe)

App Electron mở game trực tiếp từ máy chủ online (cùng máy chủ với bản web). Sửa game trên máy chủ là mọi người có bản mới ngay, không cần phát lại file .exe.

## Đóng gói

```bash
cd desktop
npm install
npm run dist
```

Kết quả: `desktop/dist/LastDrop-<version>.exe` — 1 file chạy ngay, không cần cài.

Muốn bạn bè mở là vào thẳng (không phải nhập địa chỉ), điền sẵn địa chỉ máy chủ vào `config.default.json` trước khi đóng gói:

```json
{ "serverUrl": "https://ten-may-chu-cua-ban.onrender.com" }
```

## Phím trong app

- **F11**: bật / tắt toàn màn hình
- **Ctrl+Shift+S**: đổi địa chỉ máy chủ

Không vào được máy chủ thì app tự quay về màn hình nhập địa chỉ kèm thông báo lỗi.

## Lỗi "Cannot create symbolic link" khi đóng gói

Lỗi của electron-builder khi giải nén bộ công cụ ký trên Windows (không có quyền tạo symlink). Cách xử lý: bật **Developer Mode** của Windows, hoặc giải nén thủ công file `.7z` trong `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\` vào thư mục `winCodeSign-2.6.0` cùng chỗ rồi chạy lại `npm run dist`.
