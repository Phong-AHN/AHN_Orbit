# TikTok app review — trang test `/review/tiktok`

Cùng mô hình với `/review/youtube` (docs/GOOGLE-VERIFICATION.md): reviewer của
TikTok test Login Kit + Content Posting API (Direct Post) mà không cần tài khoản
Social Square.

- Chỉ mở khi có `TIKTOK_REVIEW_ACCESS_CODE` (≥ 16 ký tự) và app TikTok đã cấu hình.
- **Lối vào là trang chủ**: mục *For TikTok app reviewers* (`https://www.anhoi.co/#tiktok-review`,
  có link "TikTok review" trên header) có hướng dẫn 3 bước và ô nhập mã. Nhập đúng →
  cookie mở khoá có chữ ký, 30 phút → chuyển tới `/review/tiktok`. Vào thẳng
  `/review/tiktok` khi chưa nhập mã sẽ bị đưa về mục đó. Sai mã quá 10 lần / 10 phút
  mỗi IP bị chặn tạm.
- Không lưu gì: token nằm trong cookie mã hoá 30 phút, scope `/review/tiktok`.
- Xin **đúng scope của sản phẩm** (lấy từ adapter TikTok): `user.info.basic`,
  `user.info.profile`, `video.publish`, `video.list`.
- Form đăng làm đúng **Content Posting UX guidelines** của TikTok: hiện nickname,
  quyền riêng tư không có giá trị mặc định, Comment/Duet/Stitch mặc định tắt (và
  khoá nếu creator đã tắt trong TikTok), commercial content disclosure, dòng đồng ý
  Music Usage Confirmation / Branded Content Policy, xem trước video.

Code: `apps/web/app/review/tiktok/`, `apps/web/src/features/tiktok-review/`.

## Việc anh làm

1. **TikTok Developer Portal → Login Kit → Redirect URI**: thêm
   `https://www.anhoi.co/review/tiktok/callback` (giữ URI cũ của sản phẩm).
2. **Vercel → Environment Variables (Production)**: `TIKTOK_REVIEW_ACCESS_CODE` =
   chuỗi ngẫu nhiên ≥ 16 ký tự (ví dụ `openssl rand -base64 24`). Redeploy.
3. Tự chạy thử từ trang chủ `https://www.anhoi.co/#tiktok-review` bằng một tài khoản TikTok.
   Khi app chưa được audit, TikTok chỉ cho đăng **“Only me”** (SELF_ONLY).
4. Quay video demo (dưới), rồi dán **review notes** (dưới) khi nộp.
5. Gỡ `TIKTOK_REVIEW_ACCESS_CODE` sau khi được duyệt — không có biến này trang trả 404.

## Kịch bản video (2–3 phút, quay toàn màn hình, thấy thanh địa chỉ)

1. `https://www.anhoi.co` — trang chủ Social Square.
2. Kéo tới mục *For TikTok app reviewers* → nhập mã → **Open the TikTok test page** →
   **Continue with TikTok** → màn hình authorize của
   TikTok, dừng 3 giây ở danh sách quyền → **Authorize**.
3. Step 2: tên, avatar, @username (user.info.basic / profile).
4. Step 3: chọn video → thấy preview → caption → chọn quyền riêng tư (cho thấy
   không có mặc định) → Comment/Duet/Stitch → bật *Disclose video content* để thấy
   hai lựa chọn rồi tắt lại → tick đồng ý → **Post to TikTok** → thông báo publish ID.
5. Mở app TikTok trên điện thoại / tiktok.com: video đã lên (Only me).
6. Step 4: danh sách video và lượt xem (video.list) → Step 5: **Disconnect**.

## Review notes (tiếng Anh — điền mã)

> Test without a Social Square account: open https://www.anhoi.co and go to the
> "For TikTok app reviewers" section (or https://www.anhoi.co/#tiktok-review).
> Access code: **[TIKTOK_REVIEW_ACCESS_CODE]**
> 1. Enter the code and click "Open the TikTok test page", then "Continue with TikTok"
>    and authorize with any TikTok account.
> 2. Step 2 shows the account (user.info.basic, user.info.profile).
> 3. Step 3: choose a short MP4 under 4 MB, pick who can view (no default), set
>    interaction and disclosure options, agree to the Music Usage Confirmation and
>    click "Post to TikTok" (video.publish, Direct Post). Use "Only me" while unaudited.
> 4. Step 4 lists recent videos with view counts (video.list).
> 5. "Disconnect and revoke access" revokes the token. Nothing is stored.

## Còn thiếu trong sản phẩm (không phải trang test)

Composer của sản phẩm chưa có **commercial content disclosure** và **dòng đồng ý
Music Usage Confirmation** cạnh nút đăng. TikTok kiểm tra các yêu cầu này cả ở
sản phẩm khi audit — nên bổ sung trước khi mở Direct Post công khai.
