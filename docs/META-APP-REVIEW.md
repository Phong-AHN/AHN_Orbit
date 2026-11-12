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

---

## `pages_manage_posts`

### Dùng chung video với `pages_read_user_content` được không?

**Được**, nếu video có đủ các đoạn dưới đây. Meta duyệt theo từng quyền, nhưng
một video gắn được cho nhiều quyền, miễn là mỗi quyền đều được thấy rõ:

1. Đăng nhập Facebook từ trạng thái **đã đăng xuất**, chọn Page, màn hình cấp quyền.
2. Soạn bài trong Social Square (**Posts → New post**), chọn Page.
3. Đăng (**Publish now**, hoặc lên lịch rồi đợi bài lên).
4. **Mở bài thật trên Facebook**, bằng link "View on Facebook" trong trang bài
   viết. Ví dụ của chính Meta cho quyền này kết thúc ở đúng cảnh này: bài hiện
   trên Page.

Chú thích ở bước 3–4: *"pages_manage_posts: Social Square creates the post on the
client's Page."* Nếu video đang có thiếu bước 4, chỉ cần quay thêm đoạn đó.

**Về quy trình duyệt:** bản mô tả cũ lấy việc duyệt (nội bộ → client) làm giá
trị chính, nhưng video không quay cảnh đó, nên dễ bị trả về với đúng lý do
"video không khớp với mô tả". Có hai cách:
- quay thêm vài giây: **Send for review → Approve** trước khi đăng; hoặc
- dùng bản mô tả dưới đây, chỉ nhắc việc duyệt như một tính năng đi kèm.

Bản cũ còn câu *"Nothing reaches a client's Page until it has passed the internal
review and the client's own approval"*. Câu này không đúng mọi lúc: workspace nội
bộ (D-106) không cần client duyệt.

### Ô mô tả quyền (tiếng Anh)

> Social Square is a social media management platform used by agencies to publish and manage content on behalf of their client businesses. Each client is an isolated workspace, agency staff are granted access per client, and every publish is recorded in an audit log.
>
> We request pages_manage_posts to publish organic posts to Facebook Pages that a client has explicitly connected to Social Square.
>
> How the permission is used — creating posts only. Agency staff compose a post in Social Square (text, optionally a link, a photo, several photos or a video), choose the client's Page, and publish it now or at a scheduled time. Social Square then creates the post on that Page, and shows a link to it. That is the entire use: we create organic Page posts and nothing else. We do not create ads and have no ad account.
>
> The value it adds. An agency manages many client brands; this puts writing, scheduling and publishing for every client's Page in one place, and a post can be routed through internal review and the client's approval before it goes out, with who approved what recorded. Without it, the agency would collect its clients' Facebook credentials and post from each Page by hand; connecting the Page through our app replaces that with a scoped authorization the client controls and can revoke at any time.
>
> Why it is necessary. A Page post cannot be created programmatically without this permission, so without it the product cannot publish to Facebook at all, which is its primary function.
>
> How we avoid posting twice. The Page feed endpoint accepts no idempotency key, so a network failure can leave us unsure whether a post was created. We never retry blindly: we check the Page's recent posts to find out, and if that is still inconclusive we stop and ask a person to check, rather than risk publishing the same content twice.
>
> What we do not do. This permission also allows editing and deleting Page posts, including, with pages_read_user_content, posts created by other people. We do none of those. We do not edit a post after it is published, and our app has no interface for it. We do not delete published posts: deleting a post inside Social Square is refused once it has been published, with a message that it would not remove it from Facebook. We never touch a post created by anyone other than our app. We do not use the aggregated, de-identified or anonymised analytics allowance of this permission, and we do not use client content to train models.

### Ô hướng dẫn test

Dùng chung các bước 1–3 của `pages_read_user_content`, thêm một bước cuối:

> 4. On the post's page in Social Square, click "View on Facebook": the post is on your Page.

---

## `pages_show_list`, `pages_read_engagement`, `read_insights`

Cả ba là quyền Facebook, nên **dùng chung video Facebook ở trên**. Mỗi quyền chỉ
cần một cảnh có chú thích riêng. Thêm vào video:

| Ở cảnh | Chú thích | Quyền |
|---|---|---|
| Sau khi đăng nhập Facebook, Social Square hiện **danh sách Page** của người đó; tick Page của client → **Connect 1 account** | *pages_show_list: lists the Pages this person manages, so they choose which to connect. Only the chosen Page is saved.* | `pages_show_list` |
| **Settings → Accounts**: Page hiện **Active · checked …** | *pages_read_engagement: Social Square reads the Page's own data to confirm the connection still works.* | `pages_read_engagement` |
| Trang bài viết: **View on Facebook ↗** | *pages_read_engagement: the link to the published post is read from the Page.* | `pages_read_engagement` |
| **Analytics** → chọn Page ở hàng **Account** → thẻ **Pages and profiles**: Followers, Page views, Unique page views, Engagements ("As of …"); bên dưới là số liệu của bài | *read_insights: Page and post insights for the client's analytics and reports. A metric Meta has not reported shows as not available, never as zero.* | `read_insights` |

**Chuẩn bị riêng cho `read_insights` (sửa 12/11, D-121):**
- Trước bản sửa này, trang Analytics **không hiện chỉ số cấp Page**. Worker cũng
  chưa từng lấy được chỉ số nào: Meta từ chối cả lô vì một tên chỉ số. Phải push
  bản sửa và **Deploy Latest Commit cho worker** trước.
- Worker đọc số liệu Page mỗi ngày một lần (cửa sổ tính từ 00:00 UTC). Không
  muốn đợi thì bấm **Refresh figures** trên trang Analytics (D-122), đợi 1–2 phút
  rồi tải lại trang. Meta vẫn có thể báo số liệu Page trễ tới một ngày.
- Quay bằng một bài đã đăng qua Social Square **từ hôm trước**; Page nên có chút
  tương tác. Lọc theo đúng Page bằng hàng **Account**, để phần tổng không trộn số
  của X, Bluesky hay TikTok.

### `pages_show_list` — ô mô tả

> Social Square is a social media management platform used by agencies to publish and report on content for their client businesses. Each client is an isolated workspace.
>
> We request pages_show_list so the person connecting Facebook can choose which of the Pages they manage to connect to a client. After Facebook Login we call /me/accounts and list the Pages by name; the person ticks the client's Page and only the Pages they choose are saved. A Page on which they lack the role needed to publish is shown with that reason rather than hidden, so they know why it cannot be used.
>
> Why it is necessary. The same call returns each Page's access token, and every other Page permission in this submission is used with that token. Without pages_show_list there is no Page token, and the product cannot work with Facebook at all.
>
> What we do not do. We do not connect Pages the person did not choose; Pages that are not chosen are discarded together with their tokens. We do not use this permission to verify whether someone manages a Page. We do not use the aggregated, de-identified or anonymised data allowance of this permission.

### `pages_read_engagement` — ô mô tả

> Social Square is a social media management platform used by agencies to publish and report on content for their client businesses. Each client is an isolated workspace.
>
> We request pages_read_engagement to read the connected Page's own content and metadata, for three things:
>
> 1. Connection health. We read the Page's id with its token on a schedule, so an agency sees a broken connection before a scheduled post is due rather than after it fails.
> 2. Never posting twice. The Page feed endpoint has no idempotency key, so if a publish is interrupted we read the Page's recent posts (id, message, created time, permalink) to find out whether it went out, before deciding anything else.
> 3. The link to each published post, read from the post, so staff and the client can open it on Facebook. Where the reaction count is not available we also read the post's like count for the client's report.
>
> Why it is necessary. Without it we cannot confirm a connection works, cannot check whether an interrupted post was published — which risks posting the same content twice to a client's audience — and cannot link to what we published.
>
> What we do not do. This permission also allows reading followers' data — names, PSIDs and profile pictures — and Page events. We do not read either. We read only Pages a client has connected to Social Square, and we do not use the aggregated, de-identified or anonymised data allowance of this permission.

### `read_insights` — ô mô tả

> Social Square is a social media management platform used by agencies to publish and report on content for their client businesses. Each client is an isolated workspace.
>
> We request read_insights to show each client how their Facebook Page and the posts we published for them perform. For the Page we read page_follows, page_media_view, page_total_media_view_unique and page_post_engagements, shown on the Analytics page as Followers, Page views, Unique page views and Engagements. For each published post we read post_media_view, post_total_media_view_unique, post_reactions_by_type_total and post_clicks. These fill the client's analytics dashboard and the CSV reports an agency exports for its client.
>
> Why it is necessary. Page and post insights are not available without this permission, and reporting results to the client is a core part of what an agency does with our product.
>
> How we handle the data. Insights are read on a schedule, never when a page is opened. A metric Meta has not reported is shown as not available, never as zero. We read totals only: no breakdown by location, age or gender, and nothing about any individual follower.
>
> What we do not do. We read insights only for Pages a client has connected — not for apps or web domains. We do not use the aggregated, de-identified or anonymised data allowance of this permission to improve our app or for marketing or advertising.

### Ô hướng dẫn test (thêm vào bản chung)

> After connecting the Page (steps 1–2 above):
> - pages_show_list: the Page list you choose from after Facebook Login.
> - pages_read_engagement: Settings → Accounts shows the Page as Active, with when it was last checked; on a published post, "View on Facebook" opens it.
> - read_insights: Analytics → choose the Page under "Account": the "Pages and profiles" card shows the Page's followers, views and engagements (read once a day), and the posts below show their own insights. Meta can take up to a day to report them for a new post.

**Ghi chú (12/11, D-121):** `page_follows_city` và `page_follows_country` **không
còn được gọi**, vì giá trị của chúng là một bảng chứ không phải một con số. Bản mô
tả giờ có thể nói "totals only". Đừng dùng lại bản mô tả cũ có liệt kê hai chỉ số
này.
