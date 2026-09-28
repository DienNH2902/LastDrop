# LAST DROP ARENA

Đồ án mẫu game FPS battle arena trên trình duyệt, dành cho laptop/PC. Giao diện và vòng lặp phòng chờ → trận đấu → kết quả lấy cảm hứng từ game battle royale; tên, logo, map và UI được tạo riêng. Đây là prototype học tập, chưa phải game tương đương PUBG PC hay production-ready.

## Công nghệ

- Client: HTML/CSS/JavaScript modules và Three.js (tải từ jsDelivr khi mở game).
- Server: Node.js + WebSocket (`ws`). Server cấp mã phòng 6 số, giới hạn 5 người, lưu vị trí/máu/kill và xử lý phát súng.
- Một tiến trình server chạy trên máy host; người chơi kết nối qua cùng URL. Host có thể chơi cùng phòng.

## Chạy trên máy

1. Cài Node.js LTS trên Windows/macOS/Linux.
2. Mở terminal tại thư mục `last-drop`.
3. Chạy `npm install`, rồi `npm start`.
4. Mở `http://localhost:3000` trên Chrome/Edge. Chủ phòng chọn **Tạo phòng**, gửi mã 6 số cho bạn bè; người khác nhập mã và chọn **Tham gia**.
5. Chủ phòng bấm **Bắt đầu trận**. Diễn biến trận xem mục **Luồng trận** bên dưới. Click vùng game để khóa chuột, Esc để tạm dừng. Mọi người cần có kết nối tới cùng server.

Để thử nhiều máy trong cùng Wi-Fi, mở cổng TCP 3000 trên firewall máy host và cho người chơi vào `http://IP-LAN-của-host:3000`. Không cần port forwarding khi chỉ chơi cùng LAN.

## Luồng trận

1. **Phòng chờ trong map** (`staging`): sau khi chủ phòng bấm bắt đầu, mọi người vào thẳng map, tay không, chưa có súng hay vật phẩm; đi lại bằng WASD. Mỗi máy dựng xong map thì báo `ready`.
2. **Đếm ngược 5 giây** (`countdown`): bắt đầu khi tất cả người chơi đã `ready` (chờ tối đa 20 giây nếu có máy chậm).
3. **Trên máy bay** (`plane`): cả phòng đứng cạnh nhau trong cùng một máy bay, bay thẳng một đường (hướng ngẫu nhiên) từ ngoài zone xuyên qua map. Có mini-map đường bay, đèn nhảy chuyển đỏ → xanh khi máy bay vào zone, nghe tiếng động cơ. **Space** hoặc **F** để nhảy khi vào zone; ai chưa nhảy thì tự bị đẩy ra khi máy bay rời zone.
4. **Rơi tự do** (`freefall`): WASD bay ngang theo hướng nhìn, **Shift** lao nhanh, **Space/F** bung dù; có tiếng gió. Dưới 35 m mà chưa bung thì tự bung.
5. **Dù** (`parachute`): hạ chậm, vẫn điều khiển bằng WASD; có tiếng bung dù, giao diện dù đơn giản ở đầu màn hình.
6. **Tiếp đất** (`ground`): có tiếng chạm đất; từ lúc này mới cầm súng, bắn, nạp đạn, nhặt đồ. Nếu rơi trúng cây/đá/nhà, server đẩy ra chỗ trống gần nhất.

Server (`server/server.js`) giữ pha trận, đường bay, thời điểm nhảy và chặn hành động sai pha (không bắn/nhặt đồ khi chưa tiếp đất). Client mô phỏng chuyển động trên không của chính mình và gửi `air` / `chute` / `land`; server giới hạn tốc độ và độ cao bất thường. Các số chỉnh nhanh: `PLANE_SPEED`, `PLANE_ALT`, `COUNTDOWN_MS` (server) và bảng `AIR` (`game.js`).

## Cấu trúc

```text
last-drop/
  server/server.js       Phòng, kết nối và xử lý trạng thái trận
  public/index.html      Menu, lobby, HUD, kho đồ, settings, kết quả
  public/game.js         Scene 3D, FPS controls, âm thanh UI và kết nối
  public/style.css       Giao diện responsive
  public/logo.svg        Logo vector
```

## Thử nghiệm

- Tạo phòng ở một trình duyệt, tham gia từ tối đa bốn cửa sổ/máy khác bằng cùng mã.
- Bắt đầu trận, kiểm tra HUD số người, di chuyển, góc ngắm và đạn.
- Lưu ý: sát thương được server kiểm tra bằng cùng tia 3D từ camera-center với hitbox hộp xoay theo thân/chân và hình cầu đầu, khớp kích thước model đang hiển thị. Chưa có kiểm tra vật cản giữa hai người. Prototype chưa có vùng bo, loot thật, reload, animation, voice chat, matchmaking, tài khoản, upload mặt, spectator, kill assist hay chống gian lận đầy đủ. Solo trong phòng hiện không tự thắng/kết thúc.
- Ba thiết lập graphics là placeholder; bản này dựng map khối ngẫu nhiên để chạy nhanh. Chưa có bộ đếm thời gian vòng đấu hay giả lập bot.

## Đưa lên mạng và chia sẻ

Server cần một dịch vụ chạy Node.js có WebSocket; chọn **Web Service**, không phải static site. Ví dụ triển khai free tier hiện có: Render. Đưa thư mục này lên một GitHub repository, sau đó trong Render chọn **New → Web Service**, kết nối repo và cấu hình:

- **Root Directory:** `outputs/last-drop` nếu repo đặt project trong thư mục outputs; bỏ trống nếu repo chỉ chứa nội dung bên trong `last-drop`.
- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Instance Type:** Free để demo.

Khi deploy xong, mở URL HTTPS Render cấp và chia sẻ cho bạn bè. Trình duyệt tự kết nối WebSocket bảo mật `wss:` trên cùng domain. Render hỗ trợ WebSocket; nhưng free web service sẽ ngủ sau 15 phút không nhận traffic và khi mở lại có thể mất khoảng một phút khởi động. Các gói miễn phí còn giới hạn tài nguyên/băng thông và không được khuyến nghị production. Kiểm tra lại hạn mức và điều khoản trước khi nộp đồ án vì chúng có thể đổi.

Không có cam kết “miễn phí không giới hạn”. Không thể đảm bảo không lag qua Internet vì còn phụ thuộc ping, Wi-Fi, vị trí server và máy người chơi. Với 4–5 người, một server gần người chơi và gửi trạng thái khoảng 10 lần/giây thường là điểm khởi đầu hợp lý; prototype này gửi vị trí theo nhịp khoảng 11 lần/giây. Các bước deploy dựa trên hướng dẫn chính thức của [Render Web Services](https://render.com/docs/web-services), [Render free instances](https://render.com/docs/free) và [Render WebSockets](https://render.com/docs/websocket).

## Hiệu năng & mạng — quy tắc bắt buộc giữ

Server Render **không render đồ họa** (không cần GPU); đồ họa chạy trên máy từng người chơi. Gói free của Render chỉ có ~0.1 CPU nên mọi phép tính trong vòng lặp trận phải rẻ. Các lỗi đã gặp và cách đã sửa — khi thêm tính năng mới đừng lặp lại:

**Server (`server/server.js`)**
- Vật cản tĩnh được tra qua lưới 16 m (`attachObstacleGrid` / `nearObstacles`). Đừng viết lại vòng `for (const o of room.obstacles)` cho truy vấn theo điểm (va chạm, độ cao, nước, cầu).
- Bắn súng: dò địa hình **một lần** dọc tia và lọc thô vật cản theo khoảng cách tới tia. Bản cũ dò lại cho từng ngọn đồi → 6,3 ms/phát, bắn auto làm server đứng; nay ~0,1 ms/phát.
- Gói `state` gửi 20 lần/giây, số được làm tròn, không gửi trường nội bộ (`controls`, `lastTickAt`...). Client đang nghẽn mạng thì bỏ gói cũ thay vì xếp hàng.
- Lỗi trong một gói tin / một tick được bắt lại (không làm sập cả server); kết nối chết được dọn bằng ping 15 giây.
- File tĩnh được nén gzip và cache trong RAM (tự làm mới khi file đổi).

**Client (`public/game.js`)**
- Người chơi khác và xe được **nội suy theo mốc thời gian server**, vẽ trễ `INTERP_DELAY_MS` (100 ms) — không đặt thẳng vị trí từ gói tin (gây giật/tele).
- Xe mình lái được **mô phỏng ngay trên máy** (`stepCar`, cùng công thức với server) và hiệu chỉnh mềm khi có gói server (`reconcileDrive`). Nếu sửa vật lý xe ở server thì sửa y hệt `stepCar`.
- Không tạo/xóa đèn (`PointLight`) giữa trận: đổi số đèn buộc biên dịch lại shader của mọi vật liệu (khựng khi bắn phát đầu, khi máy bay hiện/ẩn). Đèn chớp nòng và đèn máy bay luôn có sẵn, chỉ đổi cường độ.
- Không `dispose()` material lấy từ `makeMat()` (dùng chung); loot/vệt đạn/hạt máu dùng geometry + material chung và bể đối tượng, không tạo mới mỗi phát bắn.
- Loot chỉ vẽ trong 75 m, cỏ chia ô 50 m và tắt ngoài 120 m, đường xá gộp chung một mesh theo màu; minimap vẽ lớp địa hình tĩnh một lần.
- DOM trong vòng lặp khung hình chỉ ghi khi giá trị đổi (`setText`, `setHtml`, `setStyle`); không ghi `localStorage` trong xử lý gói tin.
- Bắn liên thanh được nhịp theo khung hình (`updateAutoFire`), mỗi phát gửi **một** gói `shoot`.
- Độ phân giải render tự hạ khi FPS < 45 (`adaptResolution`); góc phải HUD hiện PING (xanh/vàng/đỏ).

## Bản đồ tự nhiên (rừng / sa mạc)

- `server/mapgen.js` sinh map từ seed: dãy núi (chuỗi khối núi elip xoay, phủ ~40% rừng / ~60% sa mạc), viền map là núi uốn lượn nên không lộ mép vuông; sông + hồ + đầm lầy (rừng); làng gom cụm, nhà quay cửa ra đường; đường cong nối các làng, cắt nhau trên đất liền, luôn có ít nhất một cầu qua sông, lan can + rào bờ sông quanh cầu; làng / điểm ngắm trên núi có đường đèo lên. Mọi vật thể kiểm tra chồng lấp bằng lưới chiếm chỗ.
- `public/terrain.js` dùng chung cho server và client: dựng lưới độ cao 2 m (tra O(1)), san nền đường theo mặt cắt dọc giới hạn độ dốc, san nền nhà, cao nguyên. Sửa hình dạng địa hình chỉ sửa ở file này để server/client luôn khớp.
- Vật phẩm chỉ sinh **trong nhà** (`createLoot`), mỗi ô sàn tối đa một món. Xe giữ nguyên logic spawn.
- Client vẽ mặt đất liền khối chia 6×6 ô (GPU bỏ phần ngoài tầm nhìn), đường/sông là dải băng bám địa hình, cỏ là bụi lá mảnh chỉ vẽ trong ~75 m (50 m ở chế độ Performance).

## Tự tạo và import đồ họa

Map hiện sinh trực tiếp từ hình khối trong `public/game.js` (`initWorld`). Để tự làm asset miễn phí, dựng model trong Blender, export `.glb`, đặt file vào `public/assets/`, rồi import `GLTFLoader` từ Three.js và thêm model vào scene trong `initWorld`. Giữ texture nhỏ, gộp vật thể tĩnh và dùng ít polygon để tối ưu. Có thể thay các khối người chơi trong `renderPlayers()` bằng model nhân vật. Không dùng ảnh khuôn mặt nếu chưa có đồng ý rõ ràng; upload ảnh và phân phối ảnh cần thêm kiểm soát quyền riêng tư/bảo mật.

## PWA (Add to Home / cài lên desktop)

Thêm `public/manifest.webmanifest`, `public/sw.js` (service worker tối giản, chỉ cache shell tĩnh, không đụng vào WebSocket) và các icon trong `public/icons/`. Khi site chạy trên **HTTPS** (bắt buộc — service worker không đăng ký được trên HTTP thường, chỉ `localhost` mới được miễn), Chrome/Edge trên Windows sẽ tự hiện nút cài (biểu tượng màn hình ⊕/máy tính ở thanh địa chỉ, hoặc menu ⋮ → "Cài Last Drop..."). Sau khi cài, game mở như app riêng, có icon taskbar/desktop, không cần gõ lại URL mỗi lần.

## Phát triển tiếp theo

1. Thêm hệ thống vòng bo, nhặt đồ, đạn/reload, va chạm và nhiều loại vũ khí.
2. Thêm kiểm tra tầm bắn/đường đạn bằng raycast server-side và nội suy vị trí người chơi.
3. Thay map procedural bằng map GLB có collider; hoàn thiện animation, âm thanh môi trường và accessibility.
4. Bổ sung reconnect, rate limiting, kiểm thử tải, TLS/domain, logging và quy tắc quyền riêng tư trước khi mở public.
