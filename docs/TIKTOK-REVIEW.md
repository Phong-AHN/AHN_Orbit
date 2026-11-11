# TikTok app review — trang test `/review/tiktok`

Cùng mô hình với `/review/youtube` (docs/GOOGLE-VERIFICATION.md): reviewer của
TikTok test Login Kit + Content Posting API (Direct Post) mà không cần tài khoản
Social Square.

- Chỉ mở khi có `TIKTOK_REVIEW_ACCESS_CODE` (≥ 16 ký tự) và app TikTok đã cấu hình.
- **Lối vào là trang chủ**: mục *For TikTok app reviewers* (`https://www.socialsquare.site/#tiktok-review`,
  có link "TikTok review" trên header) có hướng dẫn 3 bước và ô nhập mã. Nhập đúng →
  cookie mở khoá có chữ ký, 30 phút → chuyển tới `/review/tiktok`. Vào thẳng
  `/review/tiktok` khi chưa nhập mã sẽ bị đưa về mục đó. Sai mã quá 10 lần / 10 phút
  mỗi IP bị chặn tạm.
- Không lưu gì: token nằm trong cookie mã hoá 30 phút, scope `/review/tiktok`.
- Xin **đúng scope của sản phẩm** (đọc trực tiếp từ adapter TikTok): `user.info.basic`,
  `user.info.profile`, `video.publish`, `video.upload`, `video.list`.
- `video.upload` là cho chế độ **"Send to TikTok for them to finish"** của composer
  (video vào hộp thư TikTok, creator tự hoàn tất). Từ 2026-10-30 sản phẩm xin cả
  `video.publish` và `video.upload` khi kết nối; trước đó chỉ xin `video.publish` nên chế
  độ này bị TikTok từ chối. **Tài khoản TikTok đã kết nối trước đó phải Reconnect** mới
  dùng được chế độ inbox. Trong TikTok Portal phải bật cả `video.upload`.
- Form đăng làm đúng **Content Posting UX guidelines** của TikTok: hiện nickname,
  quyền riêng tư không có giá trị mặc định, Comment/Duet/Stitch mặc định tắt (và
  khoá nếu creator đã tắt trong TikTok), commercial content disclosure, dòng đồng ý
  Music Usage Confirmation / Branded Content Policy, xem trước video.

Code: `apps/web/app/review/tiktok/`, `apps/web/src/features/tiktok-review/`.

## Việc anh làm

1. **TikTok Developer Portal → Login Kit → Redirect URI**: thêm
   `https://www.socialsquare.site/review/tiktok/callback` (giữ URI cũ của sản phẩm).
2. **Vercel → Environment Variables (Production)**: `TIKTOK_REVIEW_ACCESS_CODE` =
   chuỗi ngẫu nhiên ≥ 16 ký tự (ví dụ `openssl rand -base64 24`). Redeploy.
3. Tự chạy thử từ trang chủ `https://www.socialsquare.site/#tiktok-review` bằng một tài khoản TikTok.
   Khi app chưa được audit, TikTok chỉ cho đăng **“Only me”** (SELF_ONLY).
4. Quay video demo (dưới), rồi dán **review notes** (dưới) khi nộp.
5. Gỡ `TIKTOK_REVIEW_ACCESS_CODE` sau khi được duyệt — không có biến này trang trả 404.

## Kịch bản video (2–3 phút, quay toàn màn hình, thấy thanh địa chỉ)

1. `https://www.socialsquare.site` — trang chủ Social Square.
2. Kéo tới mục *For TikTok app reviewers* → nhập mã → **Open the TikTok test page** →
   **Continue with TikTok** → màn hình authorize của
   TikTok, dừng 3 giây ở danh sách quyền → **Authorize**.
3. Step 2: tên, avatar, @username (user.info.basic / profile).
4. Step 3: chọn video → thấy preview → caption → chọn quyền riêng tư (cho thấy
   không có mặc định) → Comment/Duet/Stitch → bật *Disclose video content* để thấy
   hai lựa chọn rồi tắt lại → tick đồng ý → **Post to TikTok** → thông báo publish ID.
5. Mở app TikTok trên điện thoại / tiktok.com: video đã lên (Only me).
6. Step 4: chọn video → **Send to my TikTok inbox** → mở app TikTok thấy thông báo
   (video.upload).
7. Step 5: danh sách video và lượt xem (video.list) → Step 6: **Disconnect**.

## Review notes (tiếng Anh — điền mã)

> Test without a Social Square account: open https://www.socialsquare.site and go to the
> "For TikTok app reviewers" section (or https://www.socialsquare.site/#tiktok-review).
> Access code: **[TIKTOK_REVIEW_ACCESS_CODE]**
> 1. Enter the code and click "Open the TikTok test page", then "Continue with TikTok"
>    and authorize with any TikTok account.
> 2. Step 2 shows the account (user.info.basic, user.info.profile).
> 3. Step 3: choose a short MP4 under 4 MB, pick who can view (no default), set
>    interaction and disclosure options, agree to the Music Usage Confirmation and
>    click "Post to TikTok" (video.publish, Direct Post). Use "Only me" while unaudited.
> 4. Step 4 sends a video to your TikTok inbox to finish in the TikTok app (video.upload).
> 5. Step 5 lists recent videos with view counts (video.list).
> 6. "Disconnect and revoke access" revokes the token. Nothing is stored.

### Bản gọn cho ô mô tả sản phẩm và scope (dưới 1000 ký tự kể cả mã, 2026-11-11)

Bản anh soạn lúc đầu thiếu `video.upload`. Trang test có xin scope này, và
TikTok duyệt từng scope, nên scope nào không được giải thích dễ bị trả về.

> Social Square is a social media management platform where businesses and agencies manage TikTok alongside their other accounts.
> - Login Kit signs the user in securely; user.info.basic and user.info.profile show which account is connected (avatar, name, username).
> - video.publish: Social Square reads the creator's privacy and interaction options, the user picks them (no defaults), can disclose commercial content, agrees to the Music Usage Confirmation and confirms.
> - video.upload: sends a video to the creator's TikTok inbox to finish and post in the TikTok app.
> - video.list: recent videos and views, for reporting.
>
> How to test (no account needed):
> 1. Open https://www.socialsquare.site/#tiktok-review
> 2. Enter access code [TIKTOK_REVIEW_ACCESS_CODE] and click "Open the TikTok test page"
> 3. Click "Continue with TikTok" and authorize
> 4. Post a short MP4 under 4 MB as "Only me", click "Send to my TikTok inbox", view recent videos, then "Disconnect and revoke access"

**Trước khi nộp:** đăng ký `https://www.socialsquare.site/review/tiktok/callback`
trong Login Kit (cả Sandbox lẫn Production). Thiếu bước này thì người duyệt sẽ
gặp đúng lỗi `redirect_uri` như hôm 11/11.

## Sản phẩm (không phải trang test) — đã bổ sung 2026-11-11 (D-119)

Phần **TikTok settings** trong trình soạn bài đã có:
- **Commercial content disclosure**: tắt sẵn; bật lên thì phải chọn "Your brand",
  "Branded content", hoặc cả hai. Branded content không đăng được ở chế độ "Only
  this account".
- Dòng **Music Usage Confirmation** (thêm Branded Content Policy khi có branded
  content).

Mỗi bài Direct Post giờ **luôn gửi** `brand_content_toggle` và
`brand_organic_toggle`. Trước đó sản phẩm không gửi, nên TikTok trả
`invalid_param` và bài báo "The platform rejected this post".
