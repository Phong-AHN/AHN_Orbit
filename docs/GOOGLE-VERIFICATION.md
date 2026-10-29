# Google OAuth verification — YouTube

Trạng thái 2026-10-30: Google trả hồ sơ, yêu cầu quay lại video và cung cấp cách
test. Tài liệu này là toàn bộ việc cần làm để nộp lại.

## 1. Google đang yêu cầu gì

| Yêu cầu trong email | Nghĩa là |
|---|---|
| *Least privilege* — video chưa cho thấy vì sao cần scope, vì sao không dùng scope hẹp hơn | Video phải **dùng thật** từng scope trên màn hình, và nói rõ vì sao scope hẹp hơn không đủ |
| *Consent Screen* — hiện đủ scope, bấm "Show all services" nếu bị ẩn | Trong video phải thấy màn hình đồng ý của Google với **cả 2 scope** đọc được rõ |
| *Scope Matching* | Scope app xin phải **giống hệt** scope khai trong Google Cloud Console — không thừa, không thiếu |
| *Test Credentials* | Google phải tự test được, không bị chặn bởi đăng nhập, xác minh số điện thoại, thẻ… |
| *Step-by-step instructions* | Email trả lời phải có các bước đi qua tính năng |
| *Critical note for live apps* | Không để người dùng thật gặp scope chưa được duyệt; quay video ở môi trường riêng nếu cần. Trạng thái app giữ **In Production** |

Social Square xin đúng 2 scope, lấy từ `YOUTUBE_PUBLISH_SCOPES`
(`packages/providers/src/youtube/capabilities.ts`):

| Scope | Dùng để | Vì sao không hẹp hơn được |
|---|---|---|
| `https://www.googleapis.com/auth/youtube.upload` | `videos.insert` — đăng video agency đã lên lịch | Đây đã là scope hẹp nhất cho việc upload |
| `https://www.googleapis.com/auth/youtube.readonly` | `channels.list?mine=true` — biết tài khoản sở hữu kênh nào; `videos.list` — trạng thái và lượt xem của video đã đăng | `youtube.upload` không cho đọc danh sách kênh hay số liệu. Scope rộng hơn (`youtube`, `youtube.force-ssl`) cho xoá/sửa — Social Square không làm |

## 2. Việc anh làm trước khi quay

1. **Google Cloud Console → Google Auth Platform → Data Access**: kiểm tra danh
   sách scope là **đúng 2 scope trên**, không có scope nào khác. Nếu có thêm
   (ví dụ `youtube`, `youtube.force-ssl`), xoá đi.
2. **Clients → OAuth client của web → Authorized redirect URIs**: thêm
   `https://www.anhoi.co/review/youtube/callback`
   (giữ nguyên URI đang có của sản phẩm).
3. **Vercel → Environment Variables (Production)**:
   - `GOOGLE_REVIEW_ACCESS_CODE` = một chuỗi ngẫu nhiên **ít nhất 16 ký tự**
     (ví dụ tạo bằng `openssl rand -base64 24`). Chuỗi này gửi cho Google.
   - Kiểm tra `APP_URL` = `https://www.anhoi.co` (redirect URI ở bước 2 được
     ghép từ biến này — lệch một chữ là Google báo `redirect_uri_mismatch`).
   - Redeploy.
4. Mở `https://www.anhoi.co/review/youtube`, tự chạy hết 4 bước một lần bằng
   một tài khoản Google có kênh YouTube.

Gỡ `GOOGLE_REVIEW_ACCESS_CODE` sau khi được duyệt: không có biến này, trang trả 404.

## 3. Trang test cho Google — `/review/youtube`

Không cần tài khoản Social Square. Được bảo vệ bằng mã truy cập ở trên.

- Xin **đúng 2 scope như sản phẩm** (dùng chung adapter YouTube).
- **Không lưu gì**: token chỉ nằm trong cookie mã hoá, 30 phút, không ghi
  database, không thuộc tenant nào.
- 4 bước: nhập mã → màn hình đồng ý của Google → xem kênh và video gần đây
  (`youtube.readonly`) → upload một video (`youtube.upload`) → Disconnect (thu hồi
  quyền với Google).
- File video tối đa 4 MB (giới hạn của Vercel). Mặc định **Private**. Bắt buộc
  chọn "made for kids" — giống sản phẩm, Social Square không bao giờ tự chọn thay.

Code: `apps/web/app/review/youtube/`, `apps/web/src/features/google-review/`.

## 4. Kịch bản quay video (khoảng 3–4 phút, tiếng Anh, có thể nói hoặc chèn chữ)

Quay toàn màn hình, thấy rõ thanh địa chỉ. Dùng một tài khoản Google có kênh.

1. **Giới thiệu (15 giây)** — `https://www.anhoi.co`:
   "Social Square is a social media management platform. Agencies connect their
   clients' YouTube channels to schedule and publish videos."
2. **Luồng thật trong sản phẩm (60–90 giây)** — đăng nhập Social Square → *Accounts* →
   *Connect YouTube*. Đến màn hình của Google: nếu scope bị thu gọn, **bấm "Show
   all services"** / mở rộng để thấy đủ 2 scope, dừng lại 3–4 giây. Allow.
   Quay lại Social Square, kênh hiện trong danh sách.
   Nói: "Social Square requests youtube.upload to publish videos, and youtube.readonly to
   list the channels this account owns and to read a published video's status
   and view counts."
3. **Dùng `youtube.readonly` (20 giây)** — chỉ vào tên kênh vừa kết nối (lấy từ
   `channels.list`), và một bài đã đăng có trạng thái / lượt xem.
4. **Dùng `youtube.upload` (60 giây)** — tạo bài video → chọn kênh YouTube → chọn
   *Made for kids: No* → *Publish now* (hoặc lên lịch 1–2 phút) → bài chuyển
   *Published* → bấm *View on YouTube* để thấy video trên YouTube Studio.
5. **Vì sao không hẹp hơn (15 giây)**:
   "youtube.upload alone cannot list a user's channels or read video statistics.
   We do not request the broader youtube or youtube.force-ssl scopes because Social Square
   never edits, deletes or manages videos, playlists or comments."
6. **Disconnect (10 giây)** — *Accounts* → *Disconnect* kênh đó.

Nếu luồng trong sản phẩm khó quay (ví dụ worker đang lỗi), quay toàn bộ trên
`/review/youtube`: bước 2 = nhập mã → Connect with Google; bước 3 = Step 2 trên
trang; bước 4 = Step 3; bước 6 = Step 4.

Tải video lên YouTube ở chế độ **Unlisted**, lấy link.

## 5. Email trả lời Google (tiếng Anh — điền 2 chỗ trong ngoặc)

> Hello Third-Party Data Safety Team,
>
> Thank you for the review. We have recorded a new demonstration video and added a
> test environment that requires no account.
>
> **Demo video:** [link to the unlisted YouTube video]
>
> **Scopes requested** (identical to those configured in the Cloud Console):
> - `https://www.googleapis.com/auth/youtube.upload` — to publish a video that an
>   agency scheduled for its client's channel (`videos.insert`). Social Square only creates
>   videos.
> - `https://www.googleapis.com/auth/youtube.readonly` — to list the channels the
>   signed-in account owns (`channels.list?mine=true`) so the agency connects the
>   right one, and to read a published video's status and view counts
>   (`videos.list`) for the client's report.
>
> `youtube.upload` alone cannot list channels or read statistics. We do not request
> `youtube` or `youtube.force-ssl`, because Social Square never edits, deletes or manages
> videos, playlists or comments.
>
> **How to test without a Social Square account**
> 1. Open https://www.anhoi.co/review/youtube
> 2. Enter the access code: **[GOOGLE_REVIEW_ACCESS_CODE]**
> 3. Click "Connect with Google" and sign in with any Google account that has a
>    YouTube channel. The consent screen lists both scopes. Click Allow.
> 4. "Step 2" shows the connected channel and its recent uploads
>    (`youtube.readonly`).
> 5. "Step 3": choose any short video under 4 MB, keep the title, choose
>    "Made for children: No", click "Upload to YouTube". The video is uploaded
>    as Private to that channel (`youtube.upload`), and a link to it is shown.
> 6. "Step 4": "Disconnect and revoke access" revokes the grant with Google.
>
> The test page requests exactly the same scopes as the production app, stores no
> tokens or data (the token is held only in an encrypted, 30-minute session
> cookie), and needs no phone verification or payment.
>
> Best regards,
> AHN Media — Social Square
