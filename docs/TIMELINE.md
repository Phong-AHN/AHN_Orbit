# Timeline phát triển Social Square (AHN Orbit)

Dựng lại ngày 2026-11-09 từ hai nguồn:

- **Lịch sử chat với Claude Code**: 363 tin nhắn trong 33 ngày làm việc, từ 12/8 đến 9/11.
- **Git**: 114 commit trên `main`, và 116 decision trong [DECISIONS.md](DECISIONS.md). Số D-115 được giữ chỗ cho kế hoạch AI trả lời bình luận.

Cách đọc:

- Giờ trong chat đã đổi sang giờ Việt Nam (UTC+7). Commit lấy theo giờ commit.
- Có những ngày làm việc không commit, nên code của ngày đó nằm trong commit của ngày sau. Ví dụ: việc ngày 19/8 nằm trong commit 22/8, việc từ 5/10 đến 13/10 nằm trong commit `61e3cb9` ngày 14/10. Một số D-xxx vì thế được ghi muộn hơn ngày thảo luận.
- Mật khẩu, token và chuỗi kết nối từng dán vào chat **không** chép vào đây.

---

## Tóm tắt các mốc

| Ngày | Mốc |
|---|---|
| trước 12/8 | Phase 1 làm được khoảng 60% (T1.1–T1.6, T1.8–T1.14), chưa có trong lịch sử chat này |
| 12/8 | Xong Phase 1 (T1.15–T1.19) |
| 13/8 | Commit đầu tiên. Deploy lên Vercel, worker lên Railway. **Đăng bài Facebook** với API thật |
| 14/8 | **Đăng bài Instagram**. Xong Phase 2, Phase 3 (analytics, report) và lên kế hoạch Phase 4 (AI) |
| 15–16/8 | Các vòng chạy tự động để đưa sản phẩm lên mức production, đối chiếu SRS, tạo OWNER-TODO |
| 17/8 | **TikTok** |
| 18/8 | Facebook/Instagram **Reels**, **Threads** |
| 18–19/8 | **LinkedIn**, **YouTube**, **Pinterest** |
| 22/8 | Cài đặt riêng cho từng nền tảng, sửa analytics |
| 21/9 | Tạo lại database production |
| 2/10 | Làm lại toàn bộ UI. Production sập vì database và Redis cũ bị xóa, phải dựng lại |
| 13/10 | Phân vai rõ, chuyển sang sidebar. Trang pháp lý cho Meta. Hộp thư Community |
| 16–21/10 | Hồ sơ **Meta App Review**: mô tả quyền, gọi API test, câu hỏi xử lý dữ liệu |
| 19–20/10 | Bình luận Instagram, gia hạn token, Community dạng từng bài |
| 23/10 | Tin nhắn riêng Facebook/Instagram (D-107) |
| 26–27/10 | AI tự trả lời tin nhắn (D-108) |
| 30/10 | Đổi tên thành **Social Square**. **AI agent qua MCP** + Copilot "Squire". Sinh ảnh bằng AI. Trang test cho reviewer TikTok và YouTube |
| 31/10 | Hướng dẫn cho người mới, chế độ sandbox của Pinterest |
| 4/11 | **X (Twitter)** |
| 5/11 | **Bluesky**, xóa client/brand, mở giới hạn gói. Nộp Meta App Review lúc 14:24 |
| 6/11 | Kế hoạch AI trả lời bình luận |
| 9/11 | Sửa lỗi tài khoản bị báo mất kết nối (D-114). **Nâng gói thủ công** (D-116). Meta trả lời từ chối video `instagram_business_basic` |

---

## Giai đoạn 1 — Nền móng và MVP (12/8 – 22/8)

### 12/8 — Hoàn tất Phase 1

- Tiếp tục từ `docs/CLAUDE_HANDOFF.md`, lúc đó Phase 1 đã làm được khoảng 60%.
- Chốt hai quyết định:
  - Scheduler bỏ qua bài của tài khoản không còn ACTIVE, nhưng giữ bài lại để đăng sau khi kết nối lại (D-032).
  - Health probe dùng rate-limit riêng (D-031).
- **T1.15** Thông báo: chỉ trong app, chưa gửi email, nhưng email gắn thêm được sau mà không phải sửa lõi (D-033 → D-037).
- **T1.16** Portal cho client: một bề mặt riêng, không lọc lại endpoint của agency (D-038 → D-040).
- **T1.17** Dashboard agency và cảnh báo sức khỏe tài khoản (D-041, D-042).
- **T1.18** Platform admin: admin không phải siêu người dùng của tenant; mọi thao tác phải có lý do và được ghi audit (D-043 → D-046).
- **T1.19** Observability, tài liệu, E2E (D-047, D-048). **Xong Phase 1.**
- Buổi tối: sửa lỗi chạy local (webpack, `_not-found`, hydration).

### 13/8 — Lên production, đăng bài Facebook thật

- Đã có Meta app và Business Portfolio đã xác minh. Hỏi các bước để có MVP hoàn chỉnh.
- `4ab306c` commit đầu tiên. Build trên Vercel lỗi vì thiếu biến môi trường.
- Bỏ mock, chạy MVP thật với database, Redis và S3 thật.
- Firebase Auth và Sentry (`096c56c`, D-049, D-050 đăng nhập Google). Trang `/privacy-policy` (`d77ceb9`).
- Sửa lỗi đăng nhập production (`cee771f`): `NODE_ENV` đặt sai trên Vercel.
- Facebook Login (`765087a`, D-051: JS SDK chỉ trả về code, không trả token).
- Gỡ lỗi luồng bài viết: chuyển trạng thái 409, bài đã lên lịch không hiện trên calendar, luồng gửi client duyệt.
- Thêm **Publish now** bên cạnh lên lịch.
- Worker không nhận job:
  - chuyển Redis sang `noeviction`;
  - deploy worker lên Railway;
  - `/health` báo "no worker consuming", rồi sửa.
- Chuỗi 9 commit "fix post to facebook" (16:46–18:57), sau đó chuyển sang Instagram.
- 23:22 bắt đầu đăng bài Instagram (`b32a307`). Gặp lỗi scope `instagram_content_publishing`.

### 14/8 — Instagram, Phase 2, 3, 4

- **0h–3h, Instagram:**
  - đính kèm ảnh/video;
  - thêm **đăng nhập bằng username Instagram** (Business Login);
  - Reconnect không cập nhật trạng thái, lỗi `redirect_uri`;
  - tách **2 Meta app riêng** cho Facebook và Instagram;
  - tài khoản bị báo mất kết nối sau mỗi lần đăng.
  - Commit: chuỗi "fix post to instagram".
- Sáng: báo cáo nhanh cho sếp, hỏi lại các phase của dự án.
- 09:49 **Phase 2**, chạy liên tục, gom câu hỏi lại hỏi một lần: production task, activity feed, thư viện media (D-052 → D-055).
  - Quyết định: nâng Graph API lên **v25.0** trước Phase 3 (D-056). Không tự tạo pipeline task.
- 13:50 **Phase 3 — Analytics và report:**
  - T3.1–T3.4 với lịch lấy số liệu: backfill 30 ngày; bài dưới 7 ngày lấy mỗi 6 giờ, sau đó mỗi ngày; giữ dữ liệu 13 tháng (D-057 → D-059).
  - T3.5 Report và export (D-060 → D-062).
  - T3.6 Retention và dọn dẹp (D-063, D-064).
- 15:27 **Phase 4 — AI:**
  - gọi Gemini qua `fetch`, không dùng SDK (D-068);
  - 1 request = 1 credit, trial 50 credit/tháng (D-066);
  - từ cấm chỉ cảnh báo, không chặn.

### 15/8 – 16/8 — Các vòng chạy tự động và SRS

- 15/8: bốn đợt brief dài cho Claude tự đóng vai PO / kỹ sư / bảo mật / QA, đưa sản phẩm lên mức production (36 phase, 35 wave, wave A–T). Đây là nguồn của D-069 → D-084: menu theo ma trận quyền, dashboard theo vai trò, xác nhận thao tác phá hủy, ý tưởng → bản nháp, posting slot, tuần lịch…
- 16/8:
  - Gửi **SRS** và kiểm tra dự án đã đáp ứng chưa, rồi làm hết các chỗ còn thiếu.
  - Tạo file việc cần làm cho chủ dự án (sau thành [OWNER-TODO.md](OWNER-TODO.md)).
  - Làm UI cho QueueSlot, mục cuối của SRS §7.

### 17/8 — TikTok

- `1b69621`, `bbfc7e9` "Update all phase": ghi lại toàn bộ Phase 2–4 và các vòng tự động (D-052 → D-085).
- Checklist theo SRS, rồi bản tóm tắt tiếng Anh dạng bảng cho sếp.
- Sửa lỗi Instagram: lần đăng đầu luôn lỗi, đăng lại thì được.
- **TikTok** (D-086):
  - file xác minh domain, redirect URI, client key;
  - lỗi `non_sandbox_target` trong sandbox;
  - thêm **ngắt kết nối tài khoản**;
  - lỗi định dạng video;
  - chấp nhận đăng chế độ riêng tư vì app chưa được TikTok audit.
  - Khoảng 15 commit.
- Sửa ô alt text (lưu sau mỗi ký tự), thêm nút lưu cài đặt TikTok.

### 18/8 — Reels, Threads, LinkedIn

- Kiểm tra fps khi tải video lên (`39d43ca`).
- Video lên Facebook Reels và Instagram Reels (D-087).
- **Threads** (D-088; `ddc4fcb`, `75ce27f`): các URL callback, lỗi video timeout khi đăng.
- Bắt đầu **LinkedIn**.

### 19/8 — LinkedIn, YouTube, Pinterest

- LinkedIn (D-089), **YouTube** (D-090), **Pinterest** (D-091). Code nằm trong commit `2fdb057` ngày 22/8.

### 22/8 — Cài đặt riêng từng nền tảng, AI, analytics

- Khi chọn nhiều nền tảng, mỗi nền tảng hiện đúng phần cài đặt của nó (D-092).
- AI sinh nội dung lỗi vì model Gemini đã bị khai tử (D-093).
- Script thuyết trình demo.
- Analytics trống: tìm ra bốn nguyên nhân (D-094). Like và comment không thuộc Page Insights (D-095).
- Commit `2fdb057` "add AI feature", `be1eb06`, `5624634` "fix analytic".

---

## Giai đoạn 2 — Tạm dừng, sự cố hạ tầng (21/9)

### 21/9

- Đăng nhập production lỗi 500 ở `/api/v1/auth/session`.
- Tạo **database mới**, đồng bộ schema.
- Sửa start command của worker trên Railway thành `node apps/worker/dist/index.js`.

---

## Giai đoạn 3 — Làm lại UI và mở rộng tính năng (2/10 – 15/10)

### 2/10 — Làm lại UI, production sập

- Làm lại toàn bộ UI bằng OpenUI và skill Frontend Design (`c4ef65d`, D-096).
- Chuyển `.env` sang Docker local.
- Thêm `/api/health` và `/health/deep` để biết biến môi trường nào đang lỗi (`4fb5f44`, `0a3eabf`, D-097).
- Production không đăng nhập được:
  - project Supabase và Redis Cloud cũ đều đã bị xóa;
  - host `db.*.supabase.co` chỉ có IPv6, nên phải dùng pooler.
  - Dựng lại DB và Redis, redeploy Railway.

### 5/10 – 9/10 — Nhóm tính năng tiếp theo

- 5/10: liệt kê các tính năng có thể làm tiếp, chia nhóm. Nhóm 0 đã xong trên production; bắt đầu Nhóm 1: hướng dẫn setup (D-098), chuyển quyền sở hữu tổ chức (D-099)…
- 9/10: kiểm tra bài trước khi đăng, hiện thông tin media và yêu cầu media của từng nền tảng (D-100).

### 13/10 – 15/10 — Phân vai và Community

- 13/10:
  - Ba vai trò (agency, client, admin), mỗi vai có cổng đăng nhập riêng, sidebar bên trái, thông báo qua lại giữa các vai (D-101).
  - Trang **Privacy Policy, Data Deletion, Terms of Service** để kết nối Meta production.
  - Phân tích khoảng cách so với Buffer. Hộp thư **Community** (D-102).
- 14/10: `61e3cb9` "upgrade" (D-098 → D-102). Sửa lỗi trang Community, giảm khoảng trống hai bên (`6522bc4`).
- 15/10:
  - Nội dung co giãn theo màn hình (`3ce200e`).
  - URL chuyển hướng cho Instagram Business Login.
  - Khuyên **không nộp** oEmbed Read, Marketing API Access Tier, `instagram_manage_messages`.

---

## Giai đoạn 4 — Meta App Review, bình luận, tin nhắn (16/10 – 27/10)

### 16/10 — User guide và hồ sơ quyền Meta

- User guide `.docx` bằng tiếng Việt, rồi bản tiếng Anh.
- Đưa tin nhắn Instagram vào kế hoạch, làm sau khi Meta go-live.
- Soạn mô tả để nộp cho các quyền:
  - `instagram_manage_comments`, `instagram_content_publish`;
  - `instagram_business_manage_insights`, `_manage_comments`, `_content_publish`, `_basic`;
  - `instagram_basic`;
  - `pages_read_user_content`, `pages_manage_posts`.
- Mục tiêu: lấy **Advanced Access** để go-live.

### 19/10 — Bình luận Instagram, Redis đầy

- Mô tả thêm cho `pages_show_list`, `pages_manage_engagement`, `threads_*`, `business_management`, `read_insights`, `pages_read_engagement`. Cấu hình sản phẩm TikTok (Login Kit, Content Posting).
- `904d6c3` "upgrade facebook feature":
  - bình luận Instagram (D-103);
  - nút làm mới có thời gian chờ (D-104);
  - **gia hạn token Business Login**, trước đó token hết hạn sau 60 ngày mà không ai gia hạn (D-105).
- Publish now lỗi 500 vì Redis đầy. Phải xóa sạch dữ liệu test trong Redis; lệnh này anh tự chạy vì công cụ chặn. Commit `095b39b`, `48c78fd` "fix worker".

### 20/10 — Gọi API test cho Meta, carousel, tự duyệt bài nội bộ

- Meta báo "0/1 lệnh gọi API" cho từng quyền. Viết script gọi API test (`meta-review-calls.ts`), chạy với 3 cặp app id/secret mới.
- Chạy migration `20261013000000_social_comments` trên production.
- Community hiển thị theo từng bài, giống giao diện Facebook/Instagram (`f0792b2`). Sửa lỗi trả lời bình luận Facebook làm tài khoản bị ngắt kết nối.
- Trả lời bảng câu hỏi xử lý dữ liệu của Meta.
- Góp ý từ người dùng về carousel → làm đến hết mức P2: tải nhiều file cùng lúc, kéo thả sắp xếp, vùng thả file, bộ đếm slide.
- Bài nội bộ theo phương án B: người viết được tự duyệt bài nội bộ (D-106). Chạy migration trên production.

### 21/10 — YouTube, LinkedIn, Pinterest; Railway bị tạm dừng

- Thêm biến môi trường cho key YouTube, LinkedIn, Pinterest.
- Điền form xét duyệt của LinkedIn, Google OAuth và ToS. Thử kết nối YouTube để quay video demo cho Google (`b44ecda` "add Youtube").
- Chạy lại API test cho Meta; còn thiếu hai quyền bình luận, chạy tiếp cho đủ. Soạn hướng dẫn cho reviewer của Meta.
- Railway hết trial, không redeploy được, phải chuyển sang tài khoản Railway mới.

### 22/10 — Tìm chỗ chạy worker khác

- Điền form developer của Pinterest.
- Railway lỗi. So sánh các lựa chọn: miễn phí, VPS DigitalOcean, gói Hobby của Railway (chạy 3 worker được không).
- Viết vài câu tiếng Anh giải thích cho sếp worker làm gì.

### 23/10 – 24/10 — Tin nhắn riêng

- 23/10: kế hoạch trả lời tin nhắn trên các nền tảng có API, rồi làm luôn, đăng ký với Meta sau. Tin nhắn riêng Facebook/Instagram và webhook (D-107, `e567dc3`). Chạy migration production.
- 24/10:
  - Bài YouTube báo PUBLISHED nhưng không thấy trên kênh → hiện URL bài trong trang chi tiết.
  - Soạn giải trình scope `youtube.upload` cho Google (dưới 100 chữ).

### 26/10 – 27/10 — AI trả lời tin nhắn

- 26/10: AI trả lời tin nhắn khi không có người trực, dựa trên tài liệu admin cung cấp và Gemini, có đủ ràng buộc về thông tin nhạy cảm và đạo đức (D-108, `0012cc7`). Anh chốt:
  - tin nhắn ghi rõ "Phản hồi tự động từ AI Assistant";
  - tạm dùng API miễn phí.
- 27/10:
  - Chạy migration production.
  - Worker trên Railway hết RAM.
  - Redis báo `OOM … maxmemory`: viết script `redis-trim` để soi và dọn các nhóm key lớn (DLQ, job maintenance lặp).
  - Hỏi điều gì xảy ra khi 2 worker cùng chạy một repo.
  - Lỗi build Prisma trên Railway.
  - Tin nhắn Messenger không về web (webhook). AI không tự trả lời. Soạn nội dung cơ sở tri thức về AHN Media.
  - Commit `9c956d7` "add message", `f094971`, `a482f63`, `5ace125`.

---

## Giai đoạn 5 — Social Square: AI agent và nền tảng mới (29/10 – 6/11)

### 29/10 — Redis riêng, CI

- Redis báo "max number of clients reached" → chuyển sang **Redis riêng trên Railway**.
  - Giảm một nửa số kết nối Redis của worker (`279ef85`).
  - AI Assistant xử lý từng cuộc hội thoại một (`2a620dc`).
- AI Assistant có mục riêng trên dashboard (`8796f77`).
- CI GitHub đỏ hết → sửa cấu hình CI và MinIO (`a8eb88f`, `e841d98`, `039d7fc`).

### 30/10 — Ngày nhiều việc nhất (16 commit)

- Google trả lời yêu cầu xác minh: phải xin quyền hẹp nhất. → Trang test `/review/youtube` có mã truy cập (`40e6006`).
- **Đổi tên sản phẩm thành Social Square** (`7a13ac1`). Tên nội bộ `@orbit/*` giữ nguyên.
- **AI agent qua MCP** hành động thay một người và không bao giờ vượt quyền người đó (D-109; `20e04b9`, `d81a58c`, `228683e`).
  - Copilot được dùng ở gói Free trong giai đoạn dev và test.
  - Chạy migration production.
  - Connector cho Claude (`b9b43ea`), hướng dẫn kết nối từ ChatGPT.
- Copilot thành bong bóng chat ở góc dưới phải, đặt tên **Squire** (`7142277`, `d85bdea`).
- **Sinh ảnh bằng AI** để dùng trong bài (D-110, `2ff26f5`).
- 16:21 quy tắc mới: **anh tự push, Claude chỉ commit**.
- TikTok trả hồ sơ vì icon app không khớp favicon:
  - làm trang chủ công khai và icon Social Square (`b1cb2db`);
  - trang test `/review/tiktok` có mã truy cập từ trang chủ (`672d618`, `644dcd9`);
  - thêm scope `video.upload` (`e943b29`).

### 31/10 — Onboarding, Pinterest

- Tour hướng dẫn cho người mới (spotlight, overlay, các bước), đi theo đúng quy trình: client → brand → kết nối → ý tưởng → bài → thống kê (`94d96ac`, `4c3fe63`).
- Bổ sung thông tin cho hồ sơ xác minh YouTube.
- Pinterest không đăng được:
  - lỗi quyền app không còn làm tài khoản bị hạ trạng thái;
  - **chế độ sandbox** cho app còn ở Trial;
  - bắt buộc chọn board;
  - xin thêm scope cho board riêng tư.
  - Commit `59e13d1` → `8caf007`.
- Deploy worker trên Railway bị kẹt ở trạng thái queued.

### 2/11

- Mọi redirect OAuth (Facebook, TikTok…) đều lỗi → trang production luôn chuyển về host của `APP_URL`, để callback tìm thấy cookie (`c357fc6`).

### 4/11 — X (Twitter), đổi tên

- Điền form developer của X. **Provider X**: đăng bài và analytics, gia hạn credential trước khi dùng (D-111, `31a6f2c`).
  - Sửa OAuth state (`c5b6e57`).
  - X hết credit → lỗi billing không retry và chỉ rõ chỗ cần xem (`9bcd9a0`).
  - Chi phí cho mỗi bài đăng.
- Đổi tên agency, client, brand ngay tại chỗ (`391c7df`).
- Kết nối trên trình duyệt Android chỉ mở app → cho phép hoàn tất trong trình duyệt (`b445b9f`).

### 5/11 — Bluesky, mở giới hạn gói

- Nút đăng xuất ở mọi màn hình (`017834f`).
- Owner và Admin xóa được client và brand (`58f7618`).
- **Bluesky** qua atproto OAuth (D-112, `6d5d7ae`). Chạy migration production (`b01db93`).
- **14:24 nộp Meta App Review.**
- Mở giới hạn gói cho các tổ chức hiện có vì đang dùng nội bộ (D-113, `28536fc`). Migration **chưa chạy** trên production.
- Bài X bị từ chối → chỉ poll media khi X báo đang xử lý (`a6f3efc`).
- Đăng lại bài lỗi không còn bắt chọn lại nền tảng (`6d7b8d0`).

### 6/11 — X, Railway, kế hoạch trả lời bình luận

- Lỗi từ X luôn ghi rõ là X từ chối và vì sao (`62551cc`).
- Railway không deploy commit mới, vẫn chạy commit lúc làm Bluesky. Mỗi lần đăng lỗi giờ ghi lại worker được build từ commit nào (`f0a3c69`).
- Kế hoạch **AI trả lời bình luận công khai** theo loại bình luận và nội dung bài ([COMMENT-AUTO-REPLY-PLAN.md](COMMENT-AUTO-REPLY-PLAN.md), `9cb7e34`, giữ số D-115).

---

## Giai đoạn 6 — Ổn định và thương mại hóa (9/11)

### 9/11

- Giữ đăng nhập: vào trang đăng nhập khi chưa đăng xuất thì vào thẳng dashboard (`6882fb8`).
- Tìm mọi nguyên nhân khiến tài khoản bị báo mất kết nối, tham khảo cách Buffer xử lý. Chỉ báo mất kết nối khi đúng là mất (D-114, `0dddf7b`).
- Có 3 project Railway cùng deploy repo này → khuyên giữ **một worker duy nhất**.
- **Nâng gói thủ công** (D-116, `c2bc484`, `044e1ac`):
  - Owner xin nâng gói trong Settings → Plan;
  - AHN thu tiền;
  - platform admin duyệt ở `/admin/plans`.
  - Bảng gói hiện là bản mẫu, chưa có giá.
- 13:20 anh push cả ba commit trên lên `origin/main`.
- Meta từ chối video của `instagram_business_basic`: chưa quay đủ luồng đăng nhập, cấp quyền và hiển thị profile. Đã soạn kịch bản quay lại và ghi chú cho người duyệt.
- Dựng timeline này.

---

## Nền tảng mạng xã hội — ngày tích hợp

| Nền tảng | Ngày | Ghi chú |
|---|---|---|
| Facebook | 13/8 | Reels 18/8; bình luận 13/10 → 20/10; tin nhắn 23/10 |
| Instagram | 13–14/8 | Đăng nhập bằng username 14/8; bình luận 19/10; gia hạn token 19/10 (D-105) |
| TikTok | 17/8 | Đăng riêng tư khi chưa audit; trang reviewer 30/10 |
| Threads | 18/8 | |
| LinkedIn | 18–19/8 | |
| YouTube | 19/8 | Trang reviewer Google 30/10 |
| Pinterest | 19/8 | Chế độ sandbox 31/10 |
| X | 4/11 | Tính phí theo credit API |
| Bluesky | 5/11 | atproto OAuth |

## Hạ tầng — các lần thay đổi

| Ngày | Thay đổi |
|---|---|
| 13/8 | Vercel (web), Railway (worker), Redis Cloud, Supabase, S3 |
| 21/9 | Tạo lại database |
| 2/10 | Supabase và Redis Cloud cũ bị xóa → dựng lại; dùng pooler thay host IPv6 |
| 19/10, 27/10 | Redis đầy → xóa sạch, rồi viết script `redis-trim` |
| 21/10 | Railway hết trial → chuyển tài khoản Railway mới |
| 29/10 | Redis chuyển sang Railway |
| 9/11 | Còn 3 project Railway cùng deploy → nên giữ 1 |

---

## Việc còn mở (tính đến 9/11)

1. **Xác nhận migration production.** Code D-116 đã push lúc 13:20 ngày 9/11. Nếu `pnpm db:migrate:deploy` chưa chạy thì Settings → Plan và `/admin/plans` sẽ báo lỗi. Lệnh này chạy cả D-113 (mở giới hạn gói) và D-116 (bảng yêu cầu nâng gói).
2. **Push** commit timeline này.
3. **Meta App Review:** quay lại video `instagram_business_basic` và nộp lại.
4. Hồ sơ xác minh Google/YouTube và TikTok audit đang chờ.
5. Railway:
   - giữ một worker;
   - sửa Watch Paths, vì commit chỉ đổi `packages/` không làm worker redeploy;
   - bỏ `railway.json` trước 2026-12-01.
6. Đổi mật khẩu Redis Cloud cũ đã dán vào chat (19/10, 27/10), nếu instance đó còn chạy.
7. Các quyết định còn chờ trong kế hoạch AI trả lời bình luận (§11, D-115). Bảng giá và nội dung gói thật cho D-116.
