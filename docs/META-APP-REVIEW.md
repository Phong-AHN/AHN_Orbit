# Meta App Review — kịch bản quay và bản mô tả theo từng quyền

Lần nộp ngày 5/11/2026 bị trả về vì video, không phải vì trường hợp sử dụng:
Meta ghi rõ *"trường hợp sử dụng của bạn hợp lệ"*. Mỗi video phải cho thấy đủ ba
đoạn: **đăng nhập Meta** → **cấp quyền** → **tính năng dùng quyền đó**, với giao
diện tiếng Anh và chú thích chữ.

Tài liệu Meta đã đọc (10/11): *Screen Recordings*, *Common Mistakes*, và trang
của từng quyền.

---

## Chuẩn bị chung (làm một lần)

1. **Domain mới đã đăng ký ở Meta** (OWNER-TODO §0): App Domains, Site URL,
   Privacy/Terms/Data Deletion URL, và Valid OAuth Redirect URI
   `https://www.socialsquare.site/api/v1/social/oauth/facebook/callback`.
   Thiếu thì cả anh lẫn người duyệt đều không đăng nhập Facebook được.
2. **Firebase → Authorized domains** có `www.socialsquare.site`. Thiếu thì người
   duyệt không đăng nhập được Social Square.
3. **Tài khoản cho người duyệt:** một Gmail riêng, tắt xác minh 2 bước, là Owner
   của một **tổ chức demo riêng** có sẵn client và brand. Không mời vào tổ chức
   thật.
4. **Tiếng Anh:** Facebook → Settings & privacy → Language → English (US). Chrome
   → Languages → English lên đầu.
5. **Quay:** 1080p, chiều rộng màn hình tối đa 1440, phóng to con trỏ, không cần
   âm thanh. Chú thích chữ thêm bằng Clipchamp (có sẵn trên Windows 11).

---

## `pages_read_user_content`

### Chuẩn bị riêng

1. **Một ngày trước:** đăng 1 bài lên Page thử nghiệm **qua Social Square**.
   Social Square chỉ đọc bình luận trên bài do chính nó đăng.
2. **Một người thật khác** (đồng nghiệp, tài khoản thật — Meta cấm tài khoản giả)
   bình luận vào bài đó. Tốt nhất là ngay lúc quay.
3. **Để màn hình cấp quyền hiện lại đầy đủ:**
   - Social Square → Accounts → **Disconnect** Page đó (không được còn bài đang
     lên lịch trên Page, nếu không hệ thống sẽ từ chối ngắt).
   - Facebook → Settings → **Business integrations** → gỡ Social Square.
   - Bài cũ vẫn giữ liên kết với Page sau khi kết nối lại (D-117).
4. Trong profile Chrome dùng để quay: **đăng nhập Social Square trước, đăng xuất
   Facebook.**

### Kịch bản (2–3 phút)

| # | Thao tác | Chú thích chèn vào video |
|---|---|---|
| 1 | Dashboard Social Square | *Social Square: agencies manage social media for their client brands.* |
| 2 | **Clients** → brand → nút **Facebook** → **Continue with Facebook** | *The agency connects the client's Facebook Page.* |
| 3 | Trang đăng nhập Facebook: email, mật khẩu (hiện dấu chấm), **Log in** | *The Page admin logs in with Facebook.* |
| 4 | Màn hình Login for Business: **chọn đúng Page của client**, dừng lại cho rõ | *The user chooses which Pages Social Square may access.* |
| 5 | Màn hình quyền: dừng 3–5 giây, cuộn hết, bấm lưu/đồng ý | *The user grants the requested permissions, including pages_read_user_content.* |
| 6 | Về Social Square: tick Page → **Connect 1 account** → Page hiện **Active** | *The Page is connected.* |
| 7 | Mở bài đó trên facebook.com: thấy bình luận của người khác | *A visitor commented on a post Social Square published to this Page.* |
| 8 | **Community** → **Check now** → mở bài → bình luận hiện kèm tên người viết | *pages_read_user_content: comments on posts we published are read into one inbox for the agency.* |
| 9 | Chỉ vào **Assign** và **Mark handled** | *Assign gives the comment to a colleague. Mark handled clears it from the queue.* |
| 10 | **Analytics** → bài đó: số reaction, bình luận, share | *Reaction and comment counts only, no content and no identities, for the client's report.* |
| 11 | Cảnh kết | *We never delete, hide or edit comments, and never read posts that tag the Page or other Pages' content.* |

**Nếu `pages_manage_engagement` cũng bị trả về**, quay thêm sau bước 9:
**Reply** → gõ câu trả lời → **Post reply** → mở Facebook thấy câu trả lời nằm dưới
bình luận. Một video gắn được cho cả hai quyền; chú thích ghi rõ đoạn nào là quyền
nào.

### Ô mô tả quyền (tiếng Anh)

> Social Square is a social media management platform used by agencies to publish, moderate and report on content for their client businesses. Each client is an isolated workspace, and agency staff are given access per client.
>
> We request pages_read_user_content for two purposes, both limited to Pages a client has explicitly connected to Social Square and to posts our app published. It is also a dependency of pages_manage_engagement, which is part of this submission.
>
> 1. Community inbox. We read the comments on posts we published so an agency can see and answer its clients' audiences in one place, instead of signing into each Page separately. Staff can assign a comment to a colleague, mark it handled, and reply as the brand. Every reply is written and sent by a person; we do not match keywords and send no automated or templated replies.
>
> 2. Engagement counts for reporting. For each published post we read reactions.summary(true).limit(0), comments.summary(true).limit(0) and shares. The .limit(0) returns the count only, with no comment bodies and no information about who reacted. These counts appear in the client's analytics dashboard and in the CSV reports an agency exports for its client.
>
> Why it is necessary. Meta refuses comments.summary(true) without this permission, so without it the analytics cannot show engagement and the community inbox cannot exist.
>
> What we do not do. We do not delete, hide or edit any comment, and our app has no interface for doing so. We do not read posts that tag a client's Page, other Pages' posts or ratings, or comments on posts our app did not publish.
>
> Data handling. For each comment we store the text, the time it was posted and the public display name shown beside it, inside the workspace of the client who authorized the connection; isolation is enforced at both the application and database layers. We store no identifier for the person who commented: the author id is read only to tell the brand's own replies apart from the audience's and is discarded in the same step. Engagement figures are stored as counts. We do not profile commenters or use this content for advertising or model training, and we do not use the aggregated or anonymized data allowance of this permission.

### Ô hướng dẫn test (tiếng Anh)

> 1. Go to https://www.socialsquare.site/sign-in → "Continue with Google" → sign in with [REVIEW_GMAIL] / [PASSWORD].
> 2. Left menu "Clients" → under brand [BRAND] click "Facebook" → "Continue with Facebook". Log in, choose your Page and grant access. Tick the Page and click "Connect 1 account".
> 3. "Posts" → "New post": write a short post, select your Page, then "Publish now".
> 4. On Facebook, comment on that post from another account.
> 5. In Social Square open "Community" → "Check now" → open the post. The comment appears with the commenter's name. "Analytics" shows the post's reaction and comment counts.

**Hai câu không được dùng nữa** (có trong bản nộp 5/11, sai với code):
"PDF reports" (chỉ có CSV) và "delete stored comments when a client disconnects"
(code không xóa).
