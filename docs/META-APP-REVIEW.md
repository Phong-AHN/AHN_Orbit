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

---

## Instagram: bốn quyền, một video

### Quyền nào quay được

Production kết nối Instagram bằng **Business Login for Instagram** (đăng nhập bằng
username Instagram, không cần Page; OWNER-TODO §1d). Màn hình kết nối chỉ xin nhóm
`instagram_business_*`:

| Quyền | Trong video | Nộp lại |
|---|---|---|
| `instagram_business_basic` | Có | **Có** |
| `instagram_business_content_publish` | Có | **Có** |
| `instagram_business_manage_comments` | Có | **Có** |
| `instagram_business_manage_insights` | Có | **Có** |
| `instagram_basic` | Không thể | **Gỡ khỏi bản nộp** |
| `instagram_content_publish` | Không thể | **Gỡ khỏi bản nộp** |
| `instagram_manage_comments` | Không thể | **Gỡ khỏi bản nộp** |

**Vì sao gỡ ba quyền không có `business`:** chúng thuộc luồng *Facebook Login for
Instagram* (Instagram nối qua Facebook Page). Social Square không còn mở luồng đó
trên màn hình kết nối, nên không có màn hình cấp quyền nào hỏi `instagram_basic`
để quay. Video nào cũng sẽ cho thấy màn hình Instagram hỏi `instagram_business_*`,
và Meta sẽ lại trả về với đúng lý do "video không khớp".

Gỡ khỏi bản nộp **không làm hỏng gì**: các quyền này vẫn ở Standard Access như hiện
tại, và production không dùng chúng. Không cần xóa chúng khỏi app.

Muốn được duyệt cả ba thì phải mở lại luồng kết nối qua Page cho Instagram và quay
video thứ hai. Không nên: hai luồng cho một nền tảng là thứ D-105 đã bỏ.

**Kiểm tra thêm khi quay video Facebook:** nếu màn hình cấp quyền Facebook liệt kê
quyền `instagram_*`, thì configuration Facebook Login for Business đang chứa
chúng. Gỡ khỏi configuration đó; Facebook Page không cần quyền Instagram.

### Chuẩn bị riêng

1. **Push và deploy.** Nút Refresh figures (D-122) cần bản web mới; worker phải
   đang chạy.
2. **Tài khoản Instagram để quay:** tài khoản professional (Business hoặc Creator),
   đúng tài khoản đã từng kết nối được (đã có role tester trên app). Đổi ngôn ngữ
   Instagram sang English.
3. **Hôm trước:** đăng một bài ảnh lên tài khoản đó **qua Social Square**. Số liệu
   cần thời gian mới có.
4. **Sáng hôm quay, trước khi ngắt kết nối:** Analytics → hàng **Account** chọn
   tài khoản Instagram → **Refresh figures** → đợi 1–2 phút. Thẻ **Pages and
   profiles** và bài hôm qua phải có số.
   - Nếu vẫn "Not measured yet" hoặc báo lỗi: **dừng, báo lại trước khi quay.**
     Bộ đọc số liệu Instagram xin cả lô chỉ số trong một lệnh gọi, giống bộ đọc
     Facebook trước D-121. Một chỉ số bị từ chối là mất cả lô.
5. **Để màn hình đăng nhập và cấp quyền hiện lại:**
   - Social Square → Settings → Accounts → **Disconnect** tài khoản Instagram
     (không được còn bài đang lên lịch cho nó). Số liệu và bài cũ vẫn giữ liên
     kết khi kết nối lại (D-117).
   - Instagram → Settings → **Apps and websites** → gỡ Social Square nếu có.
   - Trong profile Chrome dùng quay: **đăng nhập Social Square, đăng xuất
     Instagram.**
6. **Một người thật khác** cầm điện thoại, sẵn sàng bình luận (tài khoản thật,
   Meta cấm tài khoản giả). Một ảnh JPEG tỉ lệ 1:1 hoặc 4:5.

### Kịch bản (3–4 phút)

| # | Thao tác | Chú thích chèn vào video | Quyền |
|---|---|---|---|
| 1 | Dashboard → **Clients** (thấy nhiều client) | *Social Square: agencies manage social media for their client brands. Each client is a separate workspace.* | — |
| 2 | Clients → brand → nút **Instagram**. Dừng ở dòng "You will sign in at Instagram with the account's own username. No Facebook Page is needed." → **Continue with Instagram** | *The agency connects the client's Instagram professional account with Business Login for Instagram.* | — |
| 3 | Trang đăng nhập Instagram: username, mật khẩu (hiện dấu chấm), **Log in** | *The account owner logs in to Instagram.* | — |
| 4 | Màn hình cấp quyền: dừng 3–5 giây, cuộn hết, bấm **Allow** | *The owner grants instagram_business_basic, instagram_business_content_publish, instagram_business_manage_comments and instagram_business_manage_insights.* | cả bốn |
| 5 | Về Social Square: danh sách hiện tên và username → tick → **Connect 1 account** | *instagram_business_basic: Social Square reads the account's username, name and profile picture so staff know which account they post to.* | basic |
| 6 | Settings → Accounts: tài khoản **Active · checked …** | *instagram_business_basic: the connection is checked on a schedule and renewed before its 60-day expiry.* | basic |
| 7 | **Posts → New post**: caption, gắn ảnh, chọn tài khoản Instagram → **Publish now** → đợi **Published** | *instagram_business_content_publish: staff write the post and publish it to the client's account.* | content_publish |
| 8 | Trang bài: **View on Instagram ↗** → bài hiện trên Instagram | *The post is live on Instagram. Its link is read back from the account.* | content_publish, basic |
| 9 | **Đoạn liền mạch, không cắt** (xem dưới) | *instagram_business_manage_comments: comments on posts we published arrive in one inbox, and a staff member reads and replies. Replies are written by a person, never automated.* | manage_comments |
| 10 | **Analytics** → hàng Account chọn tài khoản Instagram → thẻ **Pages and profiles** ("As of …") → cuộn xuống bài hôm qua có số | *instagram_business_manage_insights: account and post insights for the client's analytics and CSV reports. A metric Instagram has not reported shows as not available, never as zero.* | manage_insights |
| 11 | Cảnh kết | *We never hide, edit or delete comments, never post Stories, and read only accounts the client connected.* | — |

**Đoạn bình luận (bước 9), quay liền mạch:**

1. Người kia bình luận vào bài vừa đăng ở bước 7 (quay màn hình điện thoại, hoặc
   mở Instagram trên một cửa sổ khác).
2. Social Square → **Community** → **Check now** → mở bài: bình luận hiện kèm
   tên người viết; ảnh đại diện của tài khoản hiện ở đầu bài.
3. **Reply** → gõ câu trả lời → **Post reply**.
4. Tải lại bài trên Instagram: câu trả lời nằm ngay dưới bình luận gốc.

Check now chỉ bấm được 1 lần mỗi phút cho mỗi tổ chức (D-104). Đừng bấm thử ngay
trước khi quay.

**Nộp:** tải cùng một video lên cả bốn quyền. Video này thay video
`instagram_business_basic` đã bị trả về.

### `instagram_business_basic` — ô mô tả

> Social Square is a social media management platform used by agencies to publish, moderate and report on content for their client businesses. Each client is an isolated workspace, and agency staff are given access per client.
>
> We request instagram_business_basic because every Instagram feature in our app is built on it. A client connects their own Instagram professional account through Business Login for Instagram: no Facebook Page is needed, and nobody at the agency holds the client's password. We use this permission for five things, only on accounts a client has connected:
>
> 1. Knowing which account was connected. After login we read the account's id, username, name and profile picture, so staff can see which client account they are posting to.
> 2. Keeping the connection alive. Instagram user tokens expire after 60 days, and we renew them with refresh_access_token, which requires this permission. Without it every client would have to reconnect every two months.
> 3. Connection health. We read the account's id on a schedule, so an agency sees a broken connection before a scheduled post is due rather than after it fails.
> 4. Never posting twice. Publishing takes two calls. If the second is interrupted, we read the account's recent media (id, caption, timestamp, permalink) to find out whether the post went out before doing anything else.
> 5. Linking to what we published. We read each published post's permalink so staff can open it on Instagram.
>
> What we do not do. We read only the connected account's own profile and media. We do not read other accounts, followers' data or Stories. We do not use the aggregated, de-identified or anonymised data allowance of this permission.

### `instagram_business_content_publish` — ô mô tả

Bản ở OWNER-TODO §1c, sửa hai chỗ sai với code: "Nothing reaches Instagram until
it has passed the internal review and the client's own approval" (workspace nội bộ
không cần client duyệt, D-106) và "an audit log the client can be shown" (client
không có trang xem audit log).

> Social Square is a social media management platform used by agencies to publish and manage content on behalf of their client businesses. Each client is an isolated workspace, agency staff are granted access per client, and every publish is recorded in an audit log.
>
> We request instagram_business_content_publish to publish organic feed content to Instagram professional accounts whose owners have connected them to Social Square through Business Login for Instagram.
>
> How the permission is used. Agency staff compose a post in Social Square: a caption of up to 2,200 characters with up to 30 hashtags, and a single image, a single video published as a Reel, or a carousel of 2 to 10 images. They choose the client's account and publish now or at a scheduled time. We create a media container on the account and then publish it, which is the two-step flow the API requires; Instagram fetches the media from a URL we provide. Social Square then shows a link to the published post. Everything is organic feed content. We create no ads and have no ad account.
>
> The value it adds. An agency manages many client brands; this puts writing, scheduling and publishing for every client's account in one place, and a post can be routed through internal review and the client's approval before it goes out, with who approved what recorded. Without it, the agency would collect its clients' Instagram passwords and post by hand. Business Login replaces that with an authorization the client grants from their own account and can revoke at any time.
>
> Why it is necessary. Instagram content cannot be published programmatically without this permission, so without it the product cannot publish to Instagram at all, which is its primary function.
>
> How we avoid posting twice. Because publishing is two calls, a network failure can leave the outcome unknown. We never retry blindly: we check the account's recent media, and if that is still inconclusive we stop and ask a person to check, rather than risk publishing the same content twice.
>
> What we do not do. We do not post Stories. We do not edit or delete published media, and our app has no interface for it. We do not use the aggregated, de-identified or anonymised analytics allowance of this permission, and we do not use client content to train models.

### `instagram_business_manage_comments` — ô mô tả

Dùng bản ở OWNER-TODO §1b, **xóa cụm** "and every action is recorded in an audit
log the client can be shown" ở câu đầu. Ô "Test post" điền link bài đăng ở bước 7
(để nguyên bài đó trên Instagram cho người duyệt bình luận).

### `instagram_business_manage_insights` — ô mô tả

Thay bản ở OWNER-TODO §1e. Bản đó ghi tên quyền cũ (`instagram_manage_insights`)
và nói client xem số liệu trong portal (portal không có trang số liệu).

> Social Square is a social media management platform used by agencies to publish and report on content for their client businesses. Each client is an isolated workspace.
>
> We request instagram_business_manage_insights to show each client how their Instagram professional account and the posts we published for them perform. We read insights only for accounts the client connected through Business Login for Instagram.
>
> How the permission is used. For each post we published we read views, reach, likes, comments, saved and shares. For the account we read reach, views, likes, saves, shares, comments, total_interactions, profile_links_taps and accounts_engaged. They appear on the Analytics page, per account and beside each post, and in the CSV reports an agency exports for its client.
>
> The value it adds. Reporting results is a core part of what an agency does for its clients. Without this, staff sign into each client's Instagram account and copy numbers into spreadsheets by hand.
>
> Why it is necessary. Instagram performance metrics are not available without this permission; they are not part of the media object.
>
> How we handle the data. Insights are read on a schedule, or when staff press Refresh figures, never when a page is opened. A metric Instagram has not reported is shown as not available, never as zero. We read totals only and request no demographic metrics, so nothing about an individual follower is collected.
>
> What we do not do. We read insights only for accounts connected to Social Square, never for other businesses' accounts. We do not use the aggregated, de-identified or anonymised data allowance of this permission to improve our app or for marketing or advertising.

### Ô hướng dẫn test (tiếng Anh, chung cho bốn quyền)

> 1. Go to https://www.socialsquare.site/sign-in → "Continue with Google" → sign in with [REVIEW_GMAIL] / [PASSWORD].
> 2. Left menu "Clients" → under brand [BRAND] click "Instagram" → "Continue with Instagram". Log in with an Instagram professional account and allow access. Tick the account and click "Connect 1 account" (instagram_business_basic).
> 3. "Posts" → "New post": write a caption, attach an image, select the Instagram account, then "Publish now". On the post's page, "View on Instagram" opens it (instagram_business_content_publish).
> 4. Comment on that post from another Instagram account. In Social Square open "Community" → "Check now" → open the post; the comment appears. Click "Reply", type a reply and click "Post reply"; it appears under the comment on Instagram (instagram_business_manage_comments).
> 5. "Analytics" → choose the account under "Account": the "Pages and profiles" card shows account insights, and the posts below show their own. Instagram can take up to a day to report figures for a new post (instagram_business_manage_insights).
