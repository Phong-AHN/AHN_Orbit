# Việc cần anh làm — AHN Orbit

> Cập nhật 2026-10-16. Đây là những việc **chỉ anh làm được**: quyết định thương
> mại, tài khoản bên thứ ba, và thao tác trên hạ tầng production. Mọi thứ khác
> em tự làm và không cần hỏi.
>
> Trạng thái code: `docs/CLAUDE_HANDOFF.md` §3. Quyết định kỹ thuật:
> `docs/DECISIONS.md`. Quy trình vận hành: `docs/RUNBOOK.md`.

---

## 🔴 CHẶN RA MẮT — không có thì không bán được

### 1. Meta App Review + Business Verification

**Vì sao chặn:** hiện chỉ publish được lên **một Page anh đã tự xác minh**. Bất
kỳ khách hàng nào khác kết nối tài khoản của họ đều sẽ bị Meta từ chối cho tới
khi app được duyệt. Không dòng code nào thay đổi được điều này.

#### Standard Access vs Advanced Access — vì sao không nộp lẻ được

Điều này quyết định cả mục này, nên ghi lên đầu. Tài liệu access levels của
Meta nói rõ:

| | Xin được từ ai |
|---|---|
| **Standard Access** (mặc định) | **Chỉ người có role trên app** — admin, developer, tester |
| **Advanced Access** | **Bất kỳ ai** — cần Business Verification + App Review từng quyền |

Client của agency là người ngoài, không có role trên app Orbit. Nên **mọi
scope mà hộp thoại OAuth xin đều phải đạt Advanced Access** trước khi một client
thật kết nối được. Không có chuyện "nộp vài cái trước, cái còn lại để sau
và tính năng đó tạm không chạy".

**Hậu quả thực tế:** nếu code xin một scope chưa được duyệt, client vẫn kết
nối được nhưng grant trả về **thiếu scope đó** — không báo lỗi gì. Rồi:

- quyền bình luận thiếu → hộp bình luận Instagram **trống trơn**
- quyền số liệu thiếu → biểu đồ Instagram **lỗi quyền**

Orbit nói trước điều đó ở nút Reply (`engagement.replyScopes`), nhưng phần
đọc thì không có gì để nói — không có dữ liệu thì giống y như không ai bình luận.

**Và một scope không thể thêm vào grant đã cấp.** Nên nộp thiếu hôm nay
không chỉ tốn thêm một vòng review 2–6 tuần — nó còn bắt **kết nối lại toàn
bộ tài khoản** của mọi client sau đó. Hôm nay là lúc rẻ nhất để làm đủ: chưa
có client thật nào để phải đi xin kết nối lại.

**Cần nộp gì:**

| Quyền | Dùng để |
|---|---|
| `pages_manage_posts` | Đăng bài lên Facebook Page |
| `pages_read_engagement` | Đọc số liệu Page |
| `instagram_content_publish` | Đăng lên Instagram |
| `instagram_manage_insights` | Đọc số liệu Instagram — **chưa gắn vào app, xem 1d** |
| `business_management` | Khám phá tài khoản khi kết nối |
| `pages_read_user_content` | Đọc bình luận và reaction của một bài |
| `pages_manage_engagement` | **Trả lời** bình luận Facebook (Community inbox) |
| `instagram_business_manage_comments` | Đọc và trả lời bình luận Instagram |

**Ba quyền cuối là mới (10/2026)** và kéo theo một việc không code nào tránh
được: **một scope không thể thêm vào một grant đã cấp**. Mọi tài khoản Facebook
đã kết nối trước đợt này phải được **kết nối lại** mới trả lời bình luận được —
**và bây giờ cả Instagram cũng vậy**, vì quyền bình luận vừa được
thêm vào danh sách xin lúc kết nối.
Trước khi kết nối lại, hộp bình luận vẫn đọc được và nút Reply sẽ từ chối —
sản phẩm nói trước điều đó thay vì để anh phát hiện lúc bấm.

**Một lưu ý riêng cho Instagram:** quyền này có **hai tên**, tùy cách kết nối.
Đăng nhập qua Facebook Page thì là `instagram_manage_comments`; đăng nhập bằng
username Instagram thì là `instagram_business_manage_comments`. Một kết nối bao giờ cũng
chỉ giữ **một** trong hai. Orbit tự chọn đúng tên theo từng tài khoản
(**D-103**) — anh chỉ cần nộp cái đầu, vì app đang dùng luồng Facebook Login.

**Lưu ý:** tên quyền Instagram là `instagram_content_publish` — **không có `-ing`**.
Chính tài liệu use-case của Meta ghi sai thành `instagram_content_publishing`, và
đó là lỗi đã làm hỏng một lần thử kết nối thật (xem `DECISIONS.md`).

**`ads_management` / `ads_read` — một việc anh quyết.** Trang insights của Meta
ghi rằng hai quyền này **cần thêm** nếu người dùng nhận vai trò trên Page
**thông qua Business Manager** — mà với agency thì đó là trường hợp **thông
thường**, không phải ngoại lệ. Em không xin, và đây là lý do:

| Xin | Không xin (hiện tại) |
|---|---|
| Số liệu chạy được cho mọi kiểu phân quyền Page | Review gọn hơn nhiều — quyền quảng cáo bị Meta xét rất kỹ |
| | Orbit không chạm vào bất kỳ ad account / campaign / ad set nào — khai mà không dùng là lý do bị từ chối |
| | Đổi lại: một số tài khoản có thể vẫn bị từ chối insights |

Nếu sau khi go-live thấy biểu đồ Instagram trống ở đúng những client được
phân quyền qua Business Manager — thì đó chính là nguyên nhân, và lúc đó xin
thêm hai quyền này là đúng. Em không đoán trước giúp anh vì nó đổi độ nặng
của cả đợt review.

**Cần chuẩn bị:** video demo luồng đăng bài, chính sách quyền riêng tư
(`/privacy-policy` đã có), mô tả use-case, và giấy tờ doanh nghiệp cho Business
Verification.

**Thời gian:** thường **2–6 tuần**, có thể vài vòng. **Nộp càng sớm càng tốt** —
nó chạy song song với việc phát triển, không phụ thuộc gì vào code.

---

### 1b. Quyền bình luận Instagram — **nộp được, đã có nút Check now**

> **Scope cần nộp: `instagram_business_manage_comments`** — production dùng
> Business Login (đã xác nhận, §1d). Mô tả dưới đây đã là bản cho luồng đó.
>
> Nếu sau này bỏ `INSTAGRAM_APP_ID` khỏi production, Orbit lùi về Facebook
> Login và scope đổi thành `instagram_manage_comments` — lúc đó bỏ hai câu
> "no Facebook Page is required" và câu về posts/Stories có gắn thẻ.

> **Lịch sửa để khỏi nhầm:** mục này từng ghi "nộp được ngay" (sai, chưa
> đọc yêu cầu screencast), rồi "chưa nộp được, thiếu webhook" (đúng lúc đó).
> Nay đã có nút **Check now** nên quay được video trong 30 giây — **nộp được.**

Tính năng đã đủ: hộp bình luận đọc và trả lời được bình luận Instagram
(**D-103**), và có nút đọc ngay thay vì chờ sweep 15 phút (**D-104**).

#### Yêu cầu screencast của Meta, và cách đáp ứng

| Meta đòi | Orbit làm được thế nào |
|---|---|
| Quay một người bình luận vào bài của tài khoản đã kết nối | Bài phải **do Orbit đăng** — Orbit chỉ đọc bình luận của bài chính nó đăng |
| Tài khoản trả lời **trong 30 giây** | Bấm **Check now** → bình luận về trong vài giây → gõ reply |
| Link bài thật + từ khoá cho người duyệt | **Chỉ anh có** — xem ngay dưới |

**Quan trọng:** chữ của Meta giả định một bot trả lời tự động theo từ khoá
("automation already setup"). **Orbit không phải thế** — nó là hộp thư cho người
thật đọc và gõ trả lời. Mô tả dưới nói rõ điều đó. Nói thật tốt hơn là để
người duyệt tự bình luận rồi ngồi đợi một bot không tồn tại.

#### Hai thứ anh phải tự điền (cần tài khoản thật)

1. **Link một bài Instagram cụ thể** do Orbit đăng, dạng
   `https://www.instagram.com/p/…`. Bài đăng tay từ app Instagram **không dùng
   được** — Orbit không đọc bình luận của những bài đó.
2. **Từ khoá.** Orbit không dùng từ khoá nào, nên câu thật là: bình luận **bất
   kỳ** gì cũng vào hàng chờ. Đừng bịa ra từ khoá không tồn tại — người duyệt
   sẽ thử đúng từ đó và không thấy gì xảy ra.

**Meta nhắc:** không đưa mật khẩu tài khoản Instagram vào ô đó.

#### Trước khi quay

1. **Deploy** bản này lên production.
2. **Chạy migration `20261013000000_social_comments`** (mục 3) — chưa chạy thì
   `/community` lỗi, không có gì để quay.
3. **Kết nối lại tài khoản Instagram** (mục 1) — tài khoản cũ thiếu scope bình
   luận, đọc được nhưng không trả lời được.
4. **Đăng một bài qua Orbit** và lấy link của nó — đó là link ở bước 1 trên.

#### Mô tả để dán vào ô "Hãy mô tả chi tiết…"

Tiếng Anh, vì review bằng tiếng Anh. **Thay `[LINK]` bằng link thật** trước
khi nộp — Meta bắt buộc có nó.

> AHN Orbit is a social media management platform used by agencies to operate
> accounts on behalf of their client businesses. Each client is an isolated
> workspace; agency staff are granted access per client, and every action is
> recorded in an audit log the client can be shown.
>
> We request `instagram_business_manage_comments` to read and reply to the
> public comments left on media that our app published, for Instagram
> professional accounts whose owners have connected them to Orbit through
> Business Login for Instagram.
>
> **The problem it solves.** An agency managing ten client brands otherwise has
> to sign into ten separate Instagram accounts to answer customer comments — in
> practice by sharing client credentials, which is a security risk and
> something clients are rightly reluctant to do. Our app uses Business Login
> for Instagram, so a client signs in with their own Instagram account, no
> Facebook Page is required, and they grant a scoped authorization they can
> revoke at any time. Nobody on the agency side ever holds the client's
> password.
>
> **How the permission is used.** For each post we published, we retrieve the
> comments on it and their replies, and display them in one queue alongside the
> Facebook comments we already handle. A staff member can assign a comment to a
> colleague, mark it handled, and post a reply as the brand. A reply is sent to
> the comment's own replies edge, so it is threaded under the comment it
> answers and reaches the person who wrote it.
>
> **This is a staffed inbox, not an auto-responder.** Replies are written and
> sent by a person. We do not match keywords, and we send no automated or
> templated reply of any kind — the product exists so that an agency's staff
> can answer their clients' audiences from one place, not so that replies
> happen without them.
>
> **What we do not do with it.** This permission also allows creating,
> updating and deleting comments. We only create replies to comments left by
> other people; we do not hide, edit or delete comments, and our application
> has no interface for doing so. We do not read comments on media our app did
> not publish, and we do not read posts or Stories that merely tag or mention
> the account.
>
> **Why it is necessary.** There is no alternative route: Instagram comments
> cannot be read or answered without this permission, so without it the inbox
> cannot include Instagram at all — an agency would see its Facebook comments
> in Orbit and have to leave the product to answer the Instagram ones.
>
> **Data handling.** We store the comment text, the time it was posted, and the
> public username displayed beside it, scoped to the workspace of the client
> who authorized the connection and enforced at both the application and
> database layers. **We do not store any identifier for the person who
> commented.** We read the author id only to tell the brand's own replies apart
> from the audience's, and discard it in the same step; nothing downstream
> receives it. We do not profile commenters, do not use comment content for
> advertising or model training, and delete stored comments on request or when
> a client disconnects their account.
>
> ---
>
> **How to test this app**
>
> Test post: [LINK]
>
> This post was published through AHN Orbit to a connected Instagram
> professional account. Our app only reads comments on media it published
> itself, so please comment on this specific post rather than another one on
> the account.
>
> 1. Leave a comment on the post above. **Any text works** — our app does not
>    use trigger keywords or automated replies, so there is no phrase you need
>    to use. Every comment on the post enters the queue.
> 2. In the screencast you will see our staff user open **Community** in Orbit,
>    press **Check now** to read the account immediately, and see the comment
>    appear in the queue within a few seconds.
> 3. The staff user then types a reply and sends it. The reply appears threaded
>    under the original comment on Instagram.
>
> Please note that replies are sent by a human operator, so a comment left
> outside the recorded session will sit in the queue until a staff member
> answers it. The screencast shows the full cycle end to end.

#### Hai câu trong mô tả đáng kiểm tra lại

| Câu | Chứng cứ trong code |
|---|---|
| Không lưu mã định danh người bình luận | bảng `SocialComment` không có cột nào cho nó; `AudienceComment` chỉ có `ours: boolean` |
| Không ẩn, không xoá | `engagement.moderate: false`, không có hàm nào gọi hide/delete |
| Chỉ đọc bài do Orbit đăng | ingestion chạy theo `PostVariant.externalPostId` |
| Không trả lời tự động | không có code nào sinh reply; `replyToComment` luôn cần `input.message` từ người dùng |


### 1c. Quyền đăng bài Instagram — mô tả để nộp

> **Scope cần nộp: `instagram_business_content_publish`** — production dùng
> Business Login (§1d). Mô tả dưới đây đã là bản cho luồng đó.

Đây là quyền **cốt lõi** — không có nó thì Orbit không đăng được gì lên
Instagram. Tính năng đã có đầy đủ từ lâu, nên mô tả dưới đây khớp với code.

Một điều cần biết trước khi đọc: phần cuối mô tả **tự chối** một thứ mà
Meta cho phép. Bản thân quyền này cho dùng dữ liệu phân tích tổng hợp / ẩn danh
để cải thiện ứng dụng và để làm marketing — Orbit **không làm việc đó**, và nói
thật điều đó thì hồ sơ mạnh hơn: người duyệt đọc một quyền khai mà không dùng
là phạm vi không giải trình được. Đừng xóa đoạn đó để "xin cho chắc".

**Mô tả để dán vào ô "Hãy mô tả chi tiết…"** (tiếng Anh, vì review bằng
tiếng Anh):

> AHN Orbit is a social media management platform used by agencies to publish
> and manage content on behalf of their client businesses. Each client is an
> isolated workspace; agency staff are granted access per client, and every
> publish is recorded in an audit log the client can be shown.
>
> We request `instagram_business_content_publish` to publish organic feed
> content to Instagram professional accounts whose owners have connected them
> to Orbit through Business Login for Instagram.
>
> **How the permission is used.** Agency staff compose a post in Orbit — a
> caption of up to 2,200 characters with up to 30 hashtags, plus either a
> single image, a single video published as a Reel, or a carousel of 2 to 10
> images. At the scheduled time we create a media container on the connected
> account and then publish it, which is the two-step flow the API requires.
> Media is stored by us and fetched by Instagram from a URL we provide.
> Everything published is organic content to the main feed; we do not create
> ads, and we have no ad account.
>
> **The value it adds.** The reason an agency needs this is approval, not
> convenience. Nothing reaches Instagram until it has passed the internal
> review and the client's own approval, both recorded with who approved what
> and when — so the client sees and authorizes their brand's posts before
> publication rather than after. Scheduling, the content calendar and
> per-client reporting all sit in one place across every brand the agency
> manages.
>
> Without the permission, the agency's alternative is to collect its clients'
> Instagram login credentials and post manually from each account. That is
> exactly what we exist to replace: because we use Business Login for
> Instagram, a client signs in with their own Instagram account, no Facebook
> Page is required, and they grant a scoped authorization they can revoke at
> any time. Nobody on the agency side ever holds the client's password.
>
> **Why it is necessary.** There is no alternative route — Instagram content
> cannot be published programmatically without this permission, so without it
> the product cannot publish at all, which is its primary function.
>
> **How we treat a publish that may have gone out.** Because publication is two
> calls, a network failure can leave the outcome genuinely unknown. We never
> retry blindly. We reconcile against the account's recent media, and if the
> result is still inconclusive we stop and flag the post for a person to check,
> rather than risk posting the same content twice to a client's audience.
>
> **What we do not do.** We do not post Stories. We do not edit or delete
> published media — the API offers neither, and our app has no interface for
> it. We do not use the aggregated, de-identified or anonymised analytics
> allowance that accompanies this permission: the metrics we read are shown to
> the client as their own post performance, and we do not use them to improve
> our application or for any marketing or advertising purpose. We do not use
> client content to train models.

**Mọi câu trong đó đều đọc được từ code**, nên nếu người duyệt hỏi thì có chỗ
để chỉ:

| Câu trong mô tả | Chứng cứ trong code |
|---|---|
| Caption 2.200 kí tự, 30 hashtag | `instagram/capabilities.ts` — `text.maxLength`, `hashtags.maxCount` |
| Ảnh đơn / video thành Reel / carousel 2–10 | `instagram/provider.ts` — `createImageContainer`, `createReelContainer`, `createCarouselContainer` |
| Hai bước: container rồi publish | `publish()` — `POST /media` → `POST /media_publish`, định tuyến sang `graph.instagram.com` cho Business Login |
| Không sửa, không xoá | `lifecycle.edit: false`, `lifecycle.delete: false` |
| Không Stories | chỉ có ba hàm container ở trên, không có `STORIES` |
| Không đăng trùng; kết quả không rõ thì dừng cho người xem | **D-027** — `reconcile()`, trạng thái `NEEDS_REVIEW` |
| Hai cấp duyệt + audit log | **D-102**, bảng `Approval` và `AuditLog` |

**Khác với mục 1b**: quyền này **không** cần kết nối lại tài khoản. Nó nằm
trong danh sách xin từ đầu, nên mọi tài khoản đang kết nối đều đã có.

---

### 1d. Soát 25 quyền đang gắn trên app — xin cái nào, bỏ cái nào

So danh sách trên App Dashboard với scope mà code **thực sự đưa vào hộp thoại
OAuth** (đọc từ các hằng `*_SCOPES`, không phải từ trí nhớ). Ba nhóm:

#### Production dùng **Business Login** — đã xác nhận 16/10/2026

`INSTAGRAM_APP_ID` và `INSTAGRAM_APP_SECRET` **đã set trên production**, nên
Instagram kết nối bằng **Business Login**: đăng nhập bằng username Instagram,
không cần Facebook Page, gọi API qua `graph.instagram.com`.

Luồng Facebook Login (qua Page) vẫn còn trong adapter để phục vụ tài khoản đã
kết nối trước đó, nhưng **không còn được chào trên màn hình connect**. Nên
nhóm scope `instagram_*` (không có `business`) **không cần nộp**.

> **Lịch sửa:** bản soát đầu tiên của em xếp bốn quyền `instagram_business_*`
> vào nhóm "chưa mở UI, không nộp". **Sai** — em grep thiếu `apps/web/app`.
> Chúng chính là nhóm cần nộp.

#### A. Nộp — đúng 10 quyền

| Quyền | Luồng | Mô tả ở |
|---|---|---|
| `pages_show_list` | Facebook | — |
| `pages_read_engagement` | Facebook | — |
| `pages_manage_posts` | Facebook — đăng bài | — |
| `pages_read_user_content` | Facebook — đọc bình luận | — |
| `pages_manage_engagement` | Facebook — trả lời bình luận | — |
| `read_insights` | Facebook — số liệu Page | — |
| `instagram_business_basic` | Instagram — nền tảng, bắt buộc đi kèm | — |
| `instagram_business_content_publish` | Instagram — đăng bài | **§1c** |
| `instagram_business_manage_comments` | Instagram — bình luận | **§1b** |
| `instagram_business_manage_insights` | Instagram — số liệu | **§1e** |

Cả bốn quyền Instagram **đã gắn sẵn** trên app — không phải thêm gì.

#### B. Bỏ thêm — nhóm Facebook Login cho Instagram (5 quyền)

`instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`,
`business_management`, và `instagram_manage_insights` (cái này chưa gắn — cứ
để nguyên, **không cần gắn nữa**).

> **`business_management` có hai lý do bỏ, mỗi lý do tự nó đủ.**
>
> 1. Nó chỉ nằm trong `INSTAGRAM_PUBLISH_SCOPES` — luồng Facebook Login cho
>    Instagram, mà production không dùng.
> 2. **Rất có thể ngay cả trên luồng đó cũng không cần.** Docstring ghi đây
>    là bộ mặc định *wizard của Meta tự thêm*, không phải bộ Orbit cần. Và
>    blurb nói quyền này dùng để quản lý tài sản doanh nghiệp như **tài
>    khoản quảng cáo** — Orbit không có ad account nào.
>
>    **Nguồn không thống nhất, nên ghi đúng mức chắc chắn:** bảng chính thức
>    trong Instagram Platform overview của Meta liệt kê `instagram_basic`,
>    `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`
>    cho luồng Facebook Login — **không có** `business_management`. Nhưng
>    nhiều hướng dẫn bên thứ ba thì có, có thể liên quan đến Page được
>    phân quyền qua Business Manager.
>
> Quyền này **đọc và ghi** tài sản doanh nghiệp, nên người duyệt sẽ xem kỹ —
> đúng kiểu quyền bị từ chối vì khai mà không dùng.
>
> **Cố ý không xóa khỏi code.** Em để nguyên `business_management` trong
> `INSTAGRAM_PUBLISH_SCOPES`. Nó vô hại ở đó — luồng đó không ai đi, nên scope
> không bao giờ vào dialog nào — và xóa một scope trên đường dự phòng mà em
> **không test được** thì rủi ro hơn là để lại. Nếu sau này thật sự lùi về
> Facebook Login thì lúc đó mới quyết, có tài khoản thật để thử.

Chúng thuộc luồng Page-linked mà màn hình connect không còn chào. Nếu sau này
bỏ `INSTAGRAM_APP_ID` khỏi production thì Orbit tự lùi về luồng này và lúc đó
mới cần chúng — nhưng đổi như vậy sau go-live còn bắt **kết nối lại toàn bộ
tài khoản**, nên coi như một quyết định đã chốt.

> **⚠️ Kiểm tra trước khi bỏ — một câu SQL.**
>
> Luồng Facebook Login vẫn **phục vụ tài khoản đã kết nối từ trước**. Credential
> của chúng giữ scope `instagram_*`, nên bỏ quyền khỏi app sẽ **làm chết đúng
> những tài khoản đó** — tài liệu Meta ghi rõ: hạ một quyền từ Advanced xuống
> Standard là vô hiệu hóa nó với mọi người không có role trên app.
>
> ```sql
> SELECT "accountType", status, COUNT(*)
> FROM "SocialAccount"
> WHERE platform = 'INSTAGRAM'
> GROUP BY "accountType", status
> ORDER BY 1, 2;
> ```
>
> | Kết quả | Việc cần làm |
> |---|---|
> | 0 dòng, hoặc chỉ `INSTAGRAM_LOGIN` | Bỏ cả 5 quyền, an toàn |
> | Có `INSTAGRAM_BUSINESS` + `ACTIVE` | **Cho những tài khoản đó kết nối lại** bằng Business Login trước, rồi mới bỏ |
>
> Giữ cả hai nhóm quyền là lựa chọn còn lại, nhưng nó khiến anh phải demo
> **cả hai luồng** cho App Review — mà màn hình connect chỉ chào một luồng, nên
> luồng còn lại không có gì để quay. Một lần kết nối lại rẻ hơn nhiều.


#### C. Bỏ — không dòng code nào xin (7 quyền)

| Quyền | Vì sao bỏ |
|---|---|
| `instagram_manage_messages` | Chưa có chức năng tin nhắn (mục 7) |
| `whatsapp_business_messaging` | Orbit **không có WhatsApp** ở bất kỳ đâu |
| `whatsapp_business_management` | Như trên |
| `threads_share_to_instagram` | Không dùng |
| `threads_business_basic` | Không dùng — Threads dùng `threads_basic` |
| `ads_management` | Không dùng — xem lưu ý ở mục 1 trước khi bỏ hẳn |
| `ads_read` | Như trên |

Một quyền khai mà không dùng không vô hại: người duyệt sẽ đòi demo nó, và
không demo được là lý do từ chối cả đợt — kéo theo những quyền đang cần thật.

Cả nhóm Instagram **không dùng** ở mục B cũng nên bỏ khi đã biết production
dùng luồng nào.

#### D. Để yên — không cần review, cũng không hại

`public_profile` và `email` là scope mặc định của Facebook Login. Orbit đăng
nhập bằng Firebase nên không dùng tới, nhưng chúng không tốn công review nào.


#### E. Threads — kiểm tra xem danh sách này là của app nào

Trong danh sách có `threads_basic` và `threads_content_publish`, nhưng **thiếu
`threads_manage_insights`** — mà code **có xin** scope đó (`THREADS_PUBLISH_SCOPES`).
Checklist Threads ở cuối file này cũng ghi thiếu nó; em đã sửa.

Threads dùng `THREADS_APP_ID` riêng, nên nếu danh sách 25 quyền này là của app
Facebook thì các scope `threads_*` đang nằm sai chỗ. Anh xem trên dashboard
giúp em: danh sách này thuộc app nào?

> `threads_manage_replies` và `threads_read_replies` thì **không cần** — chúng
> được khai trong code nhưng không bao giờ đưa vào hộp thoại, và Orbit không
> đọc hay viết reply trên Threads.

---

### 1e. Quyền số liệu Instagram — mô tả để nộp

> **Tên scope tùy luồng** (§1d): `instagram_business_manage_insights` với Business
> Login, `instagram_manage_insights` với Facebook Login. Cái thứ hai **chưa gắn
> vào app**; cái thứ nhất thì đã có.

**Gắn quyền này vào use case trước** — nó chưa có trên app (§1d). Gắn xong
thì ô mô tả sẽ hiện ra, dán đoạn dưới vào.

**Cẩn thận hai tên gần giống nhau:**

| Quyền | Luồng | Đợt này |
|---|---|---|
| `instagram_manage_insights` | Facebook Login — Orbit dùng | **Nộp** |
| `instagram_business_manage_insights` | Business Login — chưa mở UI | Không nộp (§1d nhóm D) |

> Nếu sau này mở luồng Business Login thì dùng lại đúng đoạn này, chỉ đổi
> tên scope.

**Mô tả để dán vào ô "Hãy mô tả chi tiết…"** (tiếng Anh, vì review bằng
tiếng Anh):

> AHN Orbit is a social media management platform used by agencies to publish
> and report on content for their client businesses. Each client is an isolated
> workspace, and every client can be shown the analytics for their own brand.
>
> We request `instagram_manage_insights` to retrieve performance metrics for
> Instagram professional accounts whose owners have explicitly connected them
> to Orbit, and for the media we published to those accounts.
>
> **How the permission is used.** For each published post we read `views`,
> `reach`, `likes`, `comments`, `saved` and `shares`. At account level we read
> `reach`, `views`, `likes`, `saves`, `shares`, `comments`,
> `total_interactions`, `profile_links_taps` and `accounts_engaged`. These
> populate the per-client analytics dashboard, the post-level detail view, and
> the PDF reports an agency sends its client. We also read the connected
> account's own profile metadata — username, name and profile picture — so
> staff can see which account they are posting to.
>
> **The value it adds.** An agency managing ten client brands otherwise logs
> into ten Instagram accounts to copy numbers into ten spreadsheets by hand.
> Orbit puts each client's figures beside the posts that produced them, and the
> client sees their own results in their portal without being given access to
> anyone else's. Reporting is the deliverable an agency is paid for, and this
> permission is what makes it accurate rather than retyped.
>
> **Why it is necessary.** Instagram performance metrics are not available
> through any other route — they are not in the media object and cannot be
> derived from it. Without this permission the analytics and reporting half of
> the product cannot function at all.
>
> **How we handle metrics we cannot get.** We never report an unavailable
> metric as zero. Every metric carries its own state — available, deprecated,
> or unsupported — and the interface says which, because a zero that means "we
> could not read this" is a false claim about a client's campaign. We also
> deliberately do not request the follower-gated metrics, including
> `follower_demographics` and other audience demographics: Instagram fails an
> entire batch if one metric is refused, so a small account would otherwise get
> no analytics at all rather than one missing number.
>
> **What we do not do.** We do not read insights for accounts that have not
> connected to Orbit, and we do not read other businesses' public profiles —
> only the connected account's own. We collect no audience demographic data. We
> do not use the aggregated, de-identified or anonymised analytics allowance
> that accompanies this permission: the metrics we read are shown to the client
> as their own performance, and we do not use them to improve our application
> or for any marketing or advertising purpose.

**Mọi câu đều đọc được từ code:**

| Câu trong mô tả | Chứng cứ |
|---|---|
| Sáu metric cho bài, chín metric cho tài khoản | `instagram/capabilities.ts` — `AVAILABLE_METRICS`, `ACCOUNT_METRICS` |
| Không bao giờ báo 0 khi không đọc được | `metricAvailability()` — `AVAILABLE` / `DEPRECATED` / `UNSUPPORTED` |
| Không xin metric theo ngưỡng follower, không lấy demographics | test *"never asks for the metrics that carry a 100-follower minimum"* |
| Đọc profile của chính tài khoản đã kết nối | discovery — `instagram_business_account { id, username, name, profile_picture_url }` |

**Lưu ý:** quyền này cũng nằm trong diện `ads_management` / `ads_read` ở mục 1 —
tài khoản được phân quyền Page qua Business Manager có thể vẫn bị từ chối
insights dù quyền này đã được duyệt.

---

### 1f. `instagram_business_basic` — mô tả để nộp

Quyền nền tảng, và **vẫn có ô mô tả**. Đừng viết kiểu "đây là quyền cơ bản
bắt buộc" — Orbit dùng nó ở năm chỗ cụ thể, và kể ra thì hồ sơ mạnh hơn hẳn.

| Orbit đọc gì | Ở đâu trong code | Để làm gì |
|---|---|---|
| `id,username,name,profile_picture_url` | `exchangeInstagramLoginCode` | Biết tài khoản vừa kết nối là của client nào |
| `refresh_access_token` | `refreshCredential` (**D-105**) | **Giữ kết nối sống** — token hết hạn sau 60 ngày |
| `id` | `probeHealth` | Biết kết nối còn dùng được, trước khi một bài đến giờ đăng |
| `/media` → `id,caption,timestamp,permalink` | `findRecentMedia` | **Chống đăng trùng** khi publish hai bước bị gián đoạn (**D-027**) |
| `permalink` | `permalinkFor`, `getPostStatus` | Mở bài thật từ trong Orbit |

Hai điểm mạnh nhất khi viết mô tả:

1. **Gia hạn token cần đúng quyền này** — tài liệu Meta ghi rõ. Nên câu
   "không có nó thì mọi client phải kết nối lại mỗi hai tháng" là lý lẽ
   không bác được, và nó là thật (xem **D-105**).
2. **Đọc media trả về là cơ chế an toàn**, không phải tiện lợi — biến một
   quyền nghe như "đọc dữ liệu cơ bản" thành thứ ngăn đăng trùng lên tài
   khoản của client.

Bản tiếng Anh để dán nằm trong lịch sử chat; nếu cần lại thì dựng từ bảng
trên — năm mục đánh số, rồi hai đoạn "Why it is necessary" và "What we do not
do" theo cùng khuôn như §1b/§1c/§1e (kể cả câu từ chối điều khoản phân tích
tổng hợp).


---

### 1g. Quyền Facebook — cái nào có ô mô tả

Sáu quyền `pages_*` và `read_insights` phần lớn không có ô riêng, nhưng một
số có. Dưới đây là những gì Orbit thật sự dùng, để dụng mô tả khi cần.

| Quyền | Orbit dùng để | Ở đâu |
|---|---|---|
| `pages_show_list` | Liệt kê Page khi kết nối | `discoverAccounts` |
| `pages_read_engagement` | Đọc Page đã kết nối | nền tảng |
| `pages_manage_posts` | Đăng và xoá bài do Orbit đăng | `publish`, `deletePost` |
| `pages_read_user_content` | **Đọc bình luận** + **đếm reaction/comment/share** | `fetchComments`, `fetchPostAnalytics` |
| `pages_manage_engagement` | **Trả lời** bình luận | `replyToComment` |
| `read_insights` | Số liệu Page | `fetchAccountAnalytics` |

#### `pages_read_user_content` — hai điểm đáng đưa vào mô tả

**1. `.limit(0)` là bằng chứng thật.** Orbit đọc
`reactions.summary(true).limit(0)` và `comments.summary(true).limit(0)` —
`.limit(0)` trả về **chỉ con số**, không kèm nội dung reaction/comment và không
kèm danh tính ai đã tương tác. Đây là code đang chạy, không phải lời hứa.

**2. Lý do "tại sao cần" có sẵn từ thông báo lỗi của Meta.** Nó từ chối
`comments.summary(true)` với *"(#10) requires the 'pages_read_user_content'
permission"*. Đây từng là bug thật ở project này: scope không được khai, publish
vẫn chạy nên tài khoản trông khỏe mạnh, chỉ analytics lặng lẽ hỏng.

#### `pages_read_engagement` — đoạn từ chối quan trọng nhất cả bộ

Orbit dùng cho **hai việc**:

| Việc | Endpoint |
|---|---|
| Xác nhận Page còn với tới được (health) | `GET /{page-id}?fields=id` |
| Đối soát publish gián đoạn — **chống đăng trùng** | `GET /{page-id}/posts?fields=id,message,created_time,permalink_url` |

> **Blurb cấp quyền đọc dữ liệu người theo dõi: tên, **PSID**, ảnh đại diện.**
>
> PSID là mã định danh một con người. Đây là thứ rộng nhất mà bất kỳ quyền
> nào trong bộ này cấp, và Orbit **không đọc một chứt nào**: không endpoint
> follower nào trong adapter, không bảng nào lưu, không màn hình nào hiển thị.
> Và vì không xin quyền tin nhắn nên không bao giờ có PSID.
>
> **Từ chối thẳng tốt hơn im lặng.** Người duyệt đọc blurb này sẽ tự hỏi liệu
> một công cụ agency có thu thập danh sách follower của client không — trả lời
> trước khi họ hỏi.

Cũng từ chối: **sự kiện** của Page, và Page chưa kết nối với Orbit.

#### `read_insights` — và một chỗ **không được** copy từ bản Instagram

Metric Orbit thực sự gọi ở cấp Page (`fetchAccountAnalytics` lọc `page_*`):

`page_follows` · `page_follows_city` · `page_follows_country` ·
`page_post_engagements` · `page_media_view` · `page_total_media_view_unique`

> **⚠️ Đừng khai "we collect no audience demographic data" cho Facebook.**
>
> Câu đó **đúng với Instagram** — code cố ý bỏ `follower_demographics` và các
> metric theo ngưỡng follower (§1e). Nhưng Facebook thì `page_follows_city` và
> `page_follows_country` **có được gọi**, vì `fetchAccountAnalytics` lấy mọi
> metric bắt đầu bằng `page_`.
>
> Khai giống nhau cho cả hai là một câu sai — và là loại sai mà người duyệt
> đối chiếu hai hồ sơ sẽ thấy. Cách viết đúng: đây là **số đếm tổng hợp theo
> địa điểm** như Meta trả về, không phải dữ liệu cá nhân, và Orbit không
> nhận thông tin về bất kỳ follower cụ thể nào.

**Từ chối:** blurb cấp Insights cho **Trang, ứng dụng và miền web**. Orbit chỉ
đọc Page.

**Điểm mạnh:** metric bị Meta rút (`page_impressions`, `page_fans`…) trả về
**lỗi** chứ không phải kết quả rỗng, nên Orbit theo dõi danh sách đã rút và đánh
dấu `DEPRECATED` thay vì để cả báo cáo hỏng — và không bao giờ báo 0 cho một
metric không đọc được.

#### `pages_show_list` — lý lẽ mạnh nhất của cả bộ

**Page access token lấy từ chính endpoint này.** `GET /me/accounts` trả về
danh sách Page kèm `access_token` riêng của từng Page — và mọi thứ Orbit làm
sau đó (đăng bài, đọc bình luận, đọc số liệu) đều xác thực bằng token đó.
Không có quyền này thì **không có token nào để dùng các quyền còn lại.**

Hai điểm nữa đáng đưa vào mô tả, vì đều là hành vi thật:

| Hành vi | Bằng chứng |
|---|---|
| **Người dùng chọn Page**, Orbit không tự kết nối hết | `account-picker.tsx`; Page không chọn thì không lưu |
| Page thiếu quyền `CREATE_CONTENT` — **hiện kèm lý do**, không ẩn đi | `discoverPages` đọc `tasks` và gắn cờ thay vì lọc bỏ |

Điểm thứ nhất quan trọng với agency: người bấm nút thường là nhân viên có
quyền trên vài Page riêng không liên quan. Cho họ chọn là thứ giữ quyền truy
cập của agency đúng trong phạm vi client đó.

**Từ chối:** blurb nói quyền này dùng được để *"xác minh một người có hoạt
động quản lý Trang"*. Orbit không làm việc đó — chỉ dùng cho màn hình chọn Page.

#### `pages_manage_posts` — Orbit **chỉ tạo bài**

Blurb cấp bốn thứ; Orbit dùng một. Đã kiểm tra trong code, không phải đoán:

| Quyền cho phép | Orbit | Bằng chứng |
|---|---|---|
| **Tạo** bài trên Page | ✅ dùng | `publish()` |
| **Sửa** bài đã đăng | ❌ không | `canEditPublished` chỉ có trong test, không caller nào trong sản phẩm |
| **Xoá** bài đã đăng | ❌ không | `provider.deletePost` chỉ được contract test gọi; `deletePost` của web **từ chối** bài đã PUBLISHED |
| **Xoá bài người khác tạo** (khi có thêm `pages_read_user_content`) | ❌ không | không có code nào |

Câu người dùng thấy khi thử xoá bài đã đăng, dùng được làm dẫn chứng:

> *"This post has already been published. Deleting it here would not remove it
> from the platform."*

> **Ghi chú kĩ thuật — không phải việc của App Review.** Adapter khai
> `lifecycle.edit: true` và `lifecycle.delete: true` cho Facebook, nhưng sản
> phẩm không dùng cả hai. Descriptor đúng về **nền tảng làm được gì**, còn
> **sản phẩm có dùng hay không** là chuyện khác — đó là thiết kế của lớp
> capability, không phải lỗi. Nhưng khi viết mô tả cho Meta thì phải khai
> theo **sản phẩm**, không theo descriptor.

#### `pages_manage_engagement` — cấp bốn nhóm, Orbit dùng một

Đã kiểm tra trong code, không phải đoán:

| Quyền cho phép | Orbit | Bằng chứng |
|---|---|---|
| **Tạo** bình luận (trả lời) | ✅ dùng | `replyToComment` — POST `/{comment}/comments` |
| **Sửa** bình luận | ❌ không | không có code nào |
| **Xoá** bình luận (kể cả của Page khác, vì có thêm `pages_read_user_content`) | ❌ không | hai lệnh DELETE duy nhất là `/permissions` (ngắt kết nối) và `deletePost` (không có caller) |
| **Like / bỏ like** thay mặt Page | ❌ không | không có `/likes` ở đâu trong adapter |

Descriptor khai `engagement.moderate: false`, và không có màn hình kiểm duyệt nào
trong sản phẩm.

> **Điểm vận hành — không đưa vào mô tả, nhưng anh cần biết.** Ngoài scope,
> Meta còn đòi Page token phải đến từ người giữ **task MODERATE** trên Page đó.
> Đó là cấu hình phía chủ Page, không phải phía Orbit — nên reply có thể bị từ
> chối trên **một Page cụ thể** dù quyền đã được duyệt và các Page khác vẫn chạy.
> Nếu gặp, xem vai trò của người đã kết nối Page đó trước, đừng đi tìm lỗi scope.

#### Ba thứ phải từ chối trong mô tả `pages_read_user_content`

Blurb của `pages_read_user_content` cấp rộng hơn nhiều so với những gì Orbit
dùng. Khai thật ba điểm này:

| Quyền cho phép | Orbit |
|---|---|
| **Xoá bình luận của người dùng** trên bài của Page | Không xoá, không ẩn, không sửa — `engagement.moderate: false` |
| Đọc bài **có gắn thẻ** Page | Không đọc |
| Đọc nội dung và xếp hạng của **Page khác** | Không đọc |

Cộng với điều khoản phân tích tổng hợp — từ chối như ở §1b/§1c/§1e/§1f.

---

### 1h. Quay screencast — **3 video, không phải 14**

Meta duyệt theo từng quyền, nhưng **một video gắn được cho nhiều quyền**. Và
vì Meta bắt buộc quay cả luồng OAuth — mà mỗi nền tảng một màn hình đồng ý
khác nhau — cách chia đúng là **theo nền tảng**.

| Video | Quyền nó chứng minh |
|---|---|
| **1. Facebook** | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `pages_read_user_content`, `pages_manage_engagement`, `read_insights` |
| **2. Instagram** | `instagram_business_basic`, `_content_publish`, `_manage_comments`, `_manage_insights` |
| **3. Threads** | `threads_basic`, `threads_content_publish` |

`public_profile` và `email` không cần review, không cần quay.

---

#### Luật chung cho cả ba video

1. **Phải có màn hình OAuth.** Meta đòi thấy người dùng bấm kết nối và **cài
   màn hình đồng ý liệt kê các quyền**. Thiếu đoạn này là lý do bị trả lại
   phổ biến nhất, dù phần sau quay đầy đủ.
2. **Không quay mật khẩu.** Đăng nhập trước khi bắt đầu quay, hoặc cắt đoạn đó.
   Meta nói rõ không đưa thông tin đăng nhập.
3. **Quay ở độ phân giải đọc được chữ.** Người duyệt phải đọc được nhãn nút.
4. **Đi chậm.** Dừng 2–3 giây ở mỗi màn hình quan trọng.
5. **Giao diện đang là tiếng Anh** — giữ nguyên, review bằng tiếng Anh.

---

#### Trước khi quay — bốn việc, thiếu một là quay ra trang lỗi

1. **Deploy** bản hiện tại lên production.
2. **Chạy migration `20261013000000_social_comments`** (§3). Chưa chạy thì
   `/community` lỗi 500.
3. **Kết nối lại tất cả tài khoản** — scope bình luận và số liệu là mới, và
   **scope không thêm được vào grant đã cấp**.
4. **Đăng sẵn 1–2 bài qua Orbit** trên mỗi nền tảng, trước hôm quay. Số liệu
   cần thời gian mới có, và bình luận chỉ đọc được trên bài **do Orbit đăng**.

---

#### Video 1 — Facebook (~3 phút)

| # | Quay gì | Chứng minh quyền |
|---|---|---|
| 1 | `Settings → Accounts → Connect`, chọn Facebook, bấm **Continue with Facebook** | — |
| 2 | **Màn hình đồng ý của Meta** — dừng để đọc được danh sách quyền | tất cả |
| 3 | **Danh sách Page hiện ra, chọn một Page** — nói rõ đang chọn, không phải tự kết nối hết | **`pages_show_list`** |
| 4 | Page hiện trong `Settings → Accounts` với trạng thái **Active** | **`pages_read_engagement`** (health probe) |
| 5 | `Posts → New`: soạn bài, gắn ảnh, chọn Page, lên lịch | — |
| 6 | **Luồng duyệt**: `INTERNAL_REVIEW` → `CLIENT_REVIEW` → `APPROVED` — cho thấy ai duyệt | — (nhưng là **giá trị cốt lõi**, đừng bỏ) |
| 7 | Bài chuyển `PUBLISHED`, mở **permalink** sang Facebook thật | **`pages_manage_posts`** |
| 8 | `Community`: bình luận trên bài đó hiện trong hàng chờ | **`pages_read_user_content`** |
| 9 | Gõ reply, gửi, **mở Facebook cho thấy reply nằm dưới bình luận** | **`pages_manage_engagement`** |
| 10 | `Analytics`: số liệu Page và bài | **`read_insights`** |

> Bước 6 không chứng minh quyền nào, nhưng **đó là lý do sản phẩm tồn tại** và
> là thứ phân biệt Orbit với một bot đăng bài. Mọi mô tả ở §1b–§1g đều nói
> "nothing reaches the platform until the client has approved it" — quay nó
> là bằng chứng cho câu đó.

---

#### Video 2 — Instagram (~3 phút) — **có mốc 30 giây**

| # | Quay gì | Chứng minh quyền |
|---|---|---|
| 1 | `Connect`, chọn Instagram, bấm **Continue with Instagram** | — |
| 2 | **Màn hình đồng ý của Instagram** — dừng để đọc | tất cả |
| 3 | Tài khoản hiện ra **kèm @username và ảnh đại diện** | **`instagram_business_basic`** |
| 4 | Soạn bài ảnh, qua duyệt, đăng, mở permalink sang Instagram thật | **`_content_publish`** |
| 5 | `Analytics`: số liệu bài Instagram | **`_manage_insights`** |
| 6 | **Đoạn 30 giây** — xem bảng riêng dưới | **`_manage_comments`** |

**Đoạn 30 giây, quay liền mạch không cắt:**

1. Mở Instagram, để một người bình luận vào bài Orbit vừa đăng.
2. Chuyển sang Orbit → `Community`.
3. Bấm **Check now**. Bình luận hiện ra sau vài giây.
4. Gõ reply, gửi.
5. Quay lại Instagram, **reply nằm threaded dưới bình luận gốc**.

> **Vì sao phải có nút Check now:** hàng chờ được lấp bằng sweep **15 phút**.
> Không bấm thì bình luận không kịp xuất hiện trong 30 giây Meta cho phép.
> Đó là lý do nút đó được làm (**D-104**).

> **Đừng giả vở là bot.** Chữ của Meta giả định một bot trả lời tự động theo từ
> khoá. Orbit là hộp thư cho người thật, và mô tả ở §1b nói rõ điều đó. Quay
> đúng sự thật: một nhân viên đọc và gõ câu trả lời.

---

#### Video 3 — Threads (~2 phút)

| # | Quay gì | Chứng minh quyền |
|---|---|---|
| 1 | `Connect`, chọn Threads, qua **màn hình đồng ý** | — |
| 2 | Profile hiện ra **kèm @username và ảnh đại diện** | **`threads_basic`** |
| 3 | Soạn bài — **cho thấy bộ đếm dừng ở 500 ký tự**, khác Facebook/Instagram | — (điểm cộng thật) |
| 4 | Qua duyệt, đăng, mở permalink sang Threads thật | **`threads_content_publish`** |

---

#### Hai thứ làm cả ba video mạnh hơn

**Cho thấy nhiều client.** Orbit là công cụ agency, và mọi mô tả đều mở đầu bằng
"mỗi client là một workspace cô lập". Một cảnh liếc qua danh sách workspace
chứng minh điều đó rẻ hơn mọi đoạn văn.

**Mở portal của client một lần.** `/portal/{workspaceId}` cho thấy client **tự
nhìn thấy dữ liệu của chính họ** — đây là câu trả lời trực tiếp cho ràng buộc
của `threads_basic` (*"visible only to the user who created them"*) và cho mọi
đoạn "Data handling" trong các mô tả.

---

### 2. Biến môi trường trên production

Chưa set thì deploy sẽ hỏng. Đặt trên **cả Vercel (web) và Railway (worker)** —
cả hai đều gọi API.

| Biến | Giá trị | Bắt buộc |
|---|---|:--:|
| `FACEBOOK_GRAPH_VERSION` | `v25.0` | ✅ |
| `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` | từ Meta app | ✅ |
| `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` | app Instagram Login riêng | ✅ |
| `CREDENTIAL_ENCRYPTION_KEY` | 32 byte ngẫu nhiên, base64 | ✅ |
| `STATE_SIGNING_SECRET` | 32 byte ngẫu nhiên, base64 | ✅ |
| `DATABASE_URL` / `DIRECT_URL` | Supabase | ✅ |
| `REDIS_URL` | Redis Cloud, **phải là `noeviction`** | ✅ |
| `S3_*` | bucket chặn toàn bộ public access | ✅ |
| `APP_URL` | URL production thật | ✅ |
| `ORBIT_ROLE=worker` | **chỉ trên Railway**, không đặt ở Vercel | ✅ |
| `SENTRY_DSN` | **bắt buộc khi `APP_ENV=production`** — cả web lẫn worker | ✅ |
| `S3_ENDPOINT` | **phải để TRỐNG trên production** — chỉ dùng cho MinIO local. Set nó là boot fail | ❌ |
| `GEMINI_API_KEY` | Google AI Studio | tuỳ chọn¹ |

> **Worker trên Railway — ba cái bắt được lúc deploy hỏng (19/10/2026).**
>
> 1. **`PORT`.** Railway tiêm biến này rồi probe vào đó. Worker trước đây bind
>    cứng 3100 và **không đọc `PORT`**, nên healthcheck gõ vào cổng đóng và
>    Railway giết một container đang chạy bình thường. **Đã sửa** — giờ ưu tiên
>    `WORKER_HEALTH_PORT` → `PORT` → 3100. Anh **không cần** đặt
>    `WORKER_HEALTH_PORT` trên Railway nữa; đặt vào lại là hỏng.
> 2. **Ba biến `NEXT_PUBLIC_FIREBASE_*`.** Trước đây worker **bắt buộc** phải có
>    chúng khi `APP_ENV=production` — dù đó là cấu hình của trình duyệt và worker
>    không có trình duyệt. **Đã sửa**: worker được miễn ba biến đó.
> 3. **`S3_ENDPOINT` phải trống.** Nếu copy cả khối env từ local sang thì biến
>    này đi theo, và production từ chối boot. **Không phải bug** — cố ý như vậy.
>
> Worker **vẫn cần** đủ: `DATABASE_URL`, `REDIS_URL`, `S3_BUCKET`,
> `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `CREDENTIAL_ENCRYPTION_KEY`,
> `STATE_SIGNING_SECRET`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`,
> `FIREBASE_PRIVATE_KEY`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`,
> `SENTRY_DSN`, `ORBIT_ROLE=worker`.

| `RESEND_API_KEY` + `EMAIL_FROM` | Resend | tuỳ chọn² |
| `SENTRY_DSN` | Sentry | tuỳ chọn |

¹ Không có thì production **từ chối ngay lần gọi đầu** — trợ lý viết bài không
im lặng trả về mock.
² Không có thì **không dòng email nào được ghi**; thông báo in-app vẫn hoạt động
bình thường.

> ⚠️ **Hai việc mất dữ liệu vĩnh viễn nếu làm sai:**
> - Mất `CREDENTIAL_ENCRYPTION_KEY` = mất **toàn bộ** kết nối mạng xã hội. Hãy sao lưu.
> - `ORBIT_ROLE=worker` đặt nhầm trên Vercel = hai tiến trình cùng tiêu thụ hàng đợi.
>
> File `.env.vercel.production` trong repo **chỉ là tài liệu tham khảo** —
> không có gì đọc nó. Sửa file đó không thay đổi gì.

---

### 3. Chạy migration lên production

**Thứ tự bắt buộc: migration → worker → web.** Migration ở đây **chạy bằng tay**
(chính mục này) — Vercel build không chạy. File nằm trong repo không có nghĩa là
nó đã được áp dụng.

**Hiện không còn migration nào chờ** (kiểm tra 2026-10-20 bằng `prisma migrate status`).

Đã chạy (ghi lại để khỏi chạy lại): `20260814000000_variant_provider_ref`,
`20260814010000_report`, `20261013000000_social_comments` (2026-10-20),
`20261020000000_workspace_client_approval` (2026-10-20, **D-106**). Cột mới có
mặc định `true`, nên cả 4 workspace hiện có vẫn duyệt như cũ cho tới khi anh đổi.

Khi có migration mới:

```bash
pnpm db:migrate:deploy
```

Grace period của worker **không được dưới 90 giây** — một publish có thể đang
giữa chừng với timeout 60s.

#### Sau khi chạy: đánh dấu workspace nội bộ của AHN

Settings → **Clients & brands** → trong thẻ workspace của AHN, bỏ tick **"Client
approves posts"** → xác nhận **Make internal**.

Từ lúc đó, trong workspace đó, người viết bài tự duyệt và tự lên lịch bài của
chính mình (nút **Approve & schedule**). Không ai khác phải duyệt. Họ vẫn
**không** được bấm Publish now, không được duyệt bài của người khác.

Chỉ **Owner và Admin** thấy ô này. Account Manager không đổi được, kể cả với
workspace họ quản lý — vì tắt client là bỏ client khỏi mọi bài trong workspace
cùng lúc. Đừng tắt cho workspace của khách hàng.

---

### 3b. Hai chỗ sai trong trang pháp lý — Meta sẽ đọc

Ba URL Meta yêu cầu đều đã có và đều trả 200 khi chưa đăng nhập
(`/privacy-policy`, `/terms-of-service`, `/data-deletion`). Nhưng còn hai chỗ
**chỉ anh trả lời được**, và đây là tài liệu người duyệt của Meta sẽ đọc:

| Chỗ | Vấn đề |
|---|---|
| `GOVERNING_LAW` trong `/terms-of-service` | Đang là `'Viet Nam'` — em đặt tạm, không đoán. Trụ sở pháp lý của bên vận hành quyết định giá trị này |
| Bảng nhà cung cấp trong `/privacy-policy` | **Thiếu Railway**, nơi worker đang chạy. *Sửa lại 20/10/2026:* trước đây mục này ghi Supabase và Redis Cloud “đã bị xoá” — **sai**, cả hai đang chạy (em đã migrate lên Supabase và đọc Redis Cloud trực tiếp). Bảng đúng về hai cái đó. |

Bảng nhà cung cấp là một tuyên bố về việc dữ liệu khách hàng đang nằm ở đâu. Em
không sửa bằng phỏng đoán: anh xác nhận hiện production đang dùng những dịch vụ
nào, em sửa trong một phút.

---

## 🟡 CẦN ANH QUYẾT — em đang chờ để làm tiếp

### 4. Xác thực bằng email/mật khẩu + 2FA

**Hiện trạng:** chỉ có đăng nhập Google. SRS §2 yêu cầu email/password, đặt lại
mật khẩu, xác minh email, và 2FA.

**Vấn đề chi phí:** 2FA của Firebase Auth đòi nâng lên **Google Cloud Identity
Platform**, có phí theo MAU. `docs/00-ANALYSIS.md` §B9 đã nêu từ đầu dự án và
chưa ai trả lời.

**Ba lựa chọn:**

| Phương án | Chi phí | Ghi chú |
|---|---|---|
| Chỉ thêm email/password (bỏ 2FA) | Miễn phí | Firebase Auth có sẵn. Thoả 3/4 yêu cầu |
| Nâng Identity Platform | Theo MAU | Thoả toàn bộ SRS §2 |
| Giữ nguyên chỉ Google | Miễn phí | Không thoả SRS |

**Em đề xuất:** làm email/password trước (miễn phí, thoả phần lớn), hoãn 2FA cho
tới khi có khách hàng thật yêu cầu.

---

### 5. Thư viện xuất PDF

**Hiện trạng:** chỉ có CSV. SRS §14 yêu cầu cả PDF.

| Phương án | Đánh đổi |
|---|---|
| **puppeteer** | ~300MB, chạy Chrome trên worker, bố cục đẹp, bề mặt bảo mật lớn |
| **pdfkit** | Nhẹ, bố cục phải viết tay, đủ cho báo cáo dạng bảng |
| **Không làm** | CSV mở được bằng Excel; nhiều agency chấp nhận |

**Em đề xuất:** `pdfkit`. Báo cáo là bảng số liệu, không cần render HTML, và
300MB trên worker là chi phí thật mỗi lần deploy.

---

### 6. Nền tảng còn lại — chỉ còn X (Twitter)

Sáu nền tảng đã xong: Facebook, Instagram, TikTok, Threads, LinkedIn, YouTube,
Pinterest.

| Nền tảng | Độ khó | Ghi chú |
|---|---|---|
| X (Twitter) | Trung bình | **Chi phí API cao** — bậc trả phí bắt buộc để đăng bài |

**Cần anh quyết:** X là nền tảng duy nhất còn thiếu, và nó là nền tảng duy nhất
phải **trả tiền hàng tháng** mới đăng được. Anh cho biết có khách nào thực sự
cần X không trước khi em bỏ 1–1.5 tuần vào nó.

---

## 🟢 SAU KHI DEPLOY — kiểm tra trong tuần đầu

- [ ] `GET /api/health/deep` báo database, Redis, storage đều tới được và **`worker: true`**
- [ ] Publish thật một bài lên Page thật, xác nhận bài xuất hiện
- [ ] 6 job định kỳ đã đăng ký: `reconcile-stuck-jobs` (5 phút),
      `cleanup-staged-accounts` (mỗi giờ), `sweep-account-health` (mỗi giờ),
      `analytics-rollup` (mỗi giờ), `drain-email-outbox` (2 phút),
      `retention` (03:20 hằng ngày)
- [ ] Sau đêm đầu tiên, có dòng `AuditLog` với `action = 'retention.swept'`.
      **Không có nghĩa là sweep không chạy** và analytics sẽ tích tụ vô hạn
- [ ] Analytics xuất hiện cho bài đã đăng trong vài giờ
- [ ] Nếu bật AI: số dòng `AIUsage` khớp với số request trên console Gemini
- [ ] Nếu bật email: nhận được một email thật khi publish thất bại

---

## 🔵 SAU KHI GO-LIVE VỚI META — biến các quyền còn lại thành thật

> Thứ tự: hoàn tất mục **1** (App Review + Business Verification) trước. Mọi
> việc dưới đây đều phụ thuộc vào việc app đã được duyệt và go-live.
>
> `instagram_manage_comments` **không** nằm ở đây nữa — tính năng đã làm xong nên
> nó nộp cùng đợt App Review này luôn. Xem mục **1b**.

### 7. Instagram Direct — `instagram_manage_messages`

> **Đúng tên là cái này**, không phải `instagram_business_manage_messages`. Cái
> thứ hai thuộc luồng Business Login (đăng nhập bằng username Instagram, cần
> một Meta app riêng) — Orbit dùng Facebook Login, xem mục 8.

**Hiện trạng: Orbit chưa có chức năng tin nhắn.** Community inbox chỉ có bình
luận (`SocialComment`, Facebook và Instagram). Không có dòng code nào đọc hay
gửi Instagram Direct, nên **chưa nộp được**: Meta đòi một video quay màn hình
cho thấy quyền đang được dùng, kèm cả luồng OAuth — không có màn hình nào
để quay. Bình luận và tin nhắn là hai quyền khác nhau: làm xong bình luận
(**D-103**) không giúp được gì thêm cho mục này.

**Vì sao nên làm:** quản lý community ở agency là bình luận **và** tin nhắn.
Community của Buffer chỉ có bình luận và review Google Business — **không có
Instagram DM**. Đây là một trong vài chỗ mà làm vượt Buffer dễ hơn là đuổi theo.
Trên Instagram, phần lớn câu hỏi của khách hàng nằm trong DM.

**Chọn đúng nhóm khi nộp.** Màn hình App Review cho hai lựa chọn. Orbit là công
cụ đa tenant, đọc DM **thay cho tài khoản của doanh nghiệp khác** — tức lựa chọn
**thứ nhất**, kéo theo yêu cầu nặng hơn (Tech Provider verification). Chọn
"cho tài khoản của chính tôi" sẽ bị từ chối vì không khớp với app thật.

**Thứ tự làm:**

1. **Webhook endpoint** — chưa có. Model `WebhookEvent` đã có, `verifyWebhook`
   và `parseWebhook` đã viết cho Facebook, nhưng **không route nào nhận
   webhook**; `parseWebhook` hiện không có ai gọi. DM **không thể poll** như
   bình luận: Meta push message event, và có quy tắc cửa sổ 24 giờ để trả lời.
   Việc này đáng làm dù DM có tới hay không — nó cũng làm bình luận trở thành
   real-time và đẩy sweep 5 phút xuống thành lớp dự phòng.
2. **Hai quyết định bên dưới** — em cần trước khi viết schema.
3. **Đọc + trả lời DM**, trong provider adapter, sau một cờ trong capability
   descriptor, cùng hình dạng như `engagement`.
4. **Quay video** trên tính năng thật, rồi nộp.

**Hai quyết định em đang chờ:**

Với bình luận, em **cố ý không lưu mã định danh nào** của người bình luận —
bảng không có cột cho nó, và chính sách quyền riêng tư đã ghi điều đó thành văn.

**DM không thể làm như vậy.** Một cuộc trò chuyện là *với một người*; không lưu
Instagram-scoped ID của họ thì không trả lời được. Và nội dung DM là thư từ
riêng tư, nặng hơn một bình luận đã công khai.

| Cần anh quyết | Lựa chọn |
|---|---|
| Lưu mã định danh người gửi + quy tắc giữ dữ liệu | Bắt buộc, nếu muốn tính năng chạy. Giữ bao lâu thì anh chọn |
| Khách hàng có thấy hộp DM của họ trong portal không? | Hiện portal không có bất kỳ dữ liệu khán giả nào |

Trả lời hai câu đó là em làm được. Và chính sách quyền riêng tư sẽ phải sửa
thêm một lần nữa — như lần làm bình luận, trang pháp lý là một phần của tính
năng, không phải việc làm sau.

**Bản nháp mô tả để nộp** (giữ lại, chỉ dùng **sau khi** tính năng đã có — nộp
sớm hơn là khai một chức năng không tồn tại). Tiếng Anh, vì review bằng tiếng Anh:

> AHN Orbit is a social media management platform used by agencies to operate
> accounts on behalf of their client businesses. Each client is an isolated
> workspace; agency staff are granted access per client, and every action is
> recorded in an audit log the client can be shown.
>
> We request `instagram_manage_messages` to provide a unified inbox for the
> Instagram Direct conversations of client business accounts that have
> explicitly connected their account to Orbit through Business Login for
> Instagram.
>
> **The problem it solves.** An agency managing ten client brands currently has
> to sign into ten separate Instagram accounts to answer customer messages — in
> practice by sharing client credentials, which is both a security risk and
> something clients are rightly reluctant to do. Connecting an account through
> our app replaces credential sharing with a scoped, revocable authorization
> the client controls and can withdraw at any time.
>
> **How the permission is used.** We retrieve conversations and messages for
> connected accounts and display them in one queue, alongside the public
> comments we already handle. Staff can assign a conversation to a colleague,
> mark it handled, and send a reply as the brand. Replies are sent only in
> response to a person's own message, within the platform's messaging window.
>
> **Why it is necessary.** There is no alternative route: Instagram Direct
> conversations cannot be read or answered without this permission, so without
> it the inbox cannot exist at all.
>
> **Data handling.** Messages are stored only to render the inbox and are
> scoped to the workspace of the client who authorized the connection, enforced
> at both the application and database layers. We do not profile message
> senders, do not use message content for advertising or model training, and
> delete stored conversations on request or when a client disconnects their
> account.

Đoạn cuối mô tả thiết kế em *sẽ* làm — anh đọc lại xem có đúng ý định cam kết
của mình trước khi nộp.

---

### 8. Ba quyền **không nộp** — đã xét và loại

Ghi lại để khỏi bàn lại khi gặp chúng trong App Review:

| Mục | Kết luận |
|---|---|
| **Meta oEmbed Read** | **Không cần nộp nữa.** Từ 15/06/2026 Meta cho gọi oEmbed **không cần token và không cần App Review** để nhúng nội dung công khai. Lợi ích duy nhất của việc nộp là rate limit cao hơn. Orbit hiện cũng chưa dùng oEmbed — portal đang là một link mở sang nền tảng |
| **Marketing API Access Tier** | **Không áp dụng.** Orbit làm nội dung tự nhiên, không có tài khoản quảng cáo, campaign hay ad set. Chính dashboard của Meta đang báo **0/500 lệnh gọi** — một cánh cổng chưa mở, không phải một form chờ viết hay hơn |
| **`instagram_business_manage_messages`** | **Chưa có chức năng tin nhắn.** Đây là bản Business Login của quyền ở mục 7 — đúng luồng Orbit dùng, nhưng không có tính năng nào để demo |

**Về `instagram_business_manage_messages`** — quyền này **không phải tên mới**
của `instagram_manage_messages` ở mục 7. Hai cái cùng tồn tại, mỗi cái thuộc một
luồng kết nối, và **scope của luồng này không dùng được cho luồng kia**:

| Luồng kết nối | Đăng nhập bằng | Quyền tin nhắn |
|---|---|---|
| Facebook Login — **Orbit đang dùng cái này** | tài khoản Facebook + Page liên kết | `instagram_manage_messages` |
| Business Login for Instagram | username Instagram | `instagram_business_manage_messages` |

**Lý do không nộp chỉ có một, và nó đủ:** Orbit **chưa có chức năng tin nhắn**
— giống mục 7. Không có màn hình nào để quay video, và mô tả một chức năng
không tồn tại là khai sai.

> **Sửa lại 16/10/2026.** Chỗ này trước đó còn ghi lý do thứ hai — "sai luồng,
> Business Login chưa mở trong UI" — và **đó là sai của em.** Luồng Business
> Login đã nối đầy đủ và chính là luồng Instagram ưu tiên (§1d). Nên nhóm
> `instagram_business_*` còn lại — basic, content_publish, manage_comments,
> manage_insights — **là những quyền cần nộp**, không phải bỏ. Riêng
> `manage_messages` vẫn không nộp, vì tính năng chưa có.

Nếu sau này muốn nhúng bài đã đăng vào portal: gọi endpoint tokenless, đặt trong
provider adapter, và nhớ rằng nó nạp iframe của Meta vào portal — nên chính sách
quyền riêng tư phải sửa (hiện đang ghi script bên thứ ba duy nhất là SDK đăng
nhập Facebook, và chỉ ở trang kết nối).

---

## 📋 Giới hạn vận hành hiện tại

| Giới hạn | Giá trị | Đổi ở đâu |
|---|---|---|
| Giữ analytics | 13–14 tháng | `ANALYTICS_RETENTION_MONTHS` |
| Report tải được | 7 ngày | `REPORT_TTL_MS` |
| Link tải report | 5 phút | `DOWNLOAD_URL_TTL_SECONDS` |
| AI gói dùng thử | 50 request/tháng | `DEFAULT_TRIAL_LIMITS` |
| AI tốc độ | 10/phút/người, 40/phút/tổ chức | `features/ai/rate-limit.ts` |
| Backfill analytics khi kết nối | 30 ngày | `BACKFILL_WINDOW_MS` |
| Email bỏ qua sau | 24 giờ | `MAX_AGE_MS` trong `outbox.ts` |

Đổi hạn mức AI dùng thử **chỉ ảnh hưởng tổ chức tạo sau đó** — tổ chức đang tồn
tại giữ `limits` riêng trên dòng dữ liệu của họ.

---

## Những gì em đang làm tiếp — không cần anh

Danh sách cũ ở đây đã xong hết từ tháng 8 trừ một mục, nên em viết lại cho đúng.
Năm mục cũ: media folders (**D-081**), calendar week view (**D-082**), composer
platform preview (**D-084**) và QueueSlot UI đều đã có; chỉ mục cuối còn lại.

1. **Rà soát responsive + accessibility có hệ thống** — vẫn là hai mục P0 duy
   nhất còn mở. Càng cấp hơn sau khi đổi layout sang sidebar: toàn bộ phần nội
   dung giờ giãn theo màn hình và **chưa ai xem bằng mắt ở bất kỳ độ rộng nào**
   (ở đây không có browser).
2. **Webhook endpoint** — xem mục 7. Em làm được ngay, và nó có giá trị độc lập:
   bình luận trở thành real-time, sweep 5 phút lùi về làm lớp dự phòng.
3. **Post tags + phân tích theo tag** — nhóm một campaign lại rồi đọc số liệu
   theo tag. Một bảng mới, không cần quyết định gì.
4. **Channel groups** — lưu sẵn "Acme · tất cả kênh", chọn một lần.
5. **Nhập bài theo lô bằng CSV** — nhập cả tháng nội dung, kiểm tra từng dòng
   trước khi lưu.

Mục 3–5 là ba thứ Buffer làm tốt hơn Orbit và đều gọn, không chạm vào quy trình
duyệt. Em sẽ không hỏi gì về những mục này.

## TikTok (added 2026-08-17)

### Sản phẩm nào trong portal — 2 trong 6

Portal TikTok chào sáu sản phẩm. Ánh xạ từ chín endpoint adapter thật sự gọi:

| Endpoint trong code | Sản phẩm |
|---|---|
| `/v2/oauth/token/`, `/v2/oauth/revoke/` | **Login Kit** |
| `/v2/user/info/` | **Login Kit** (`user.info.basic`) |
| `/v2/post/publish/creator_info/query/` | **Content Posting API** |
| `/v2/post/publish/video/init/` | Content Posting API — Direct Post |
| `/v2/post/publish/content/init/` | Content Posting API — ảnh |
| `/v2/post/publish/inbox/video/init/` | Content Posting API — inbox |
| `/v2/post/publish/status/fetch/` | Content Posting API |
| `/v2/video/query/` | **Display API** — không nằm trong sáu cái, xem dưới |

**Không thêm bốn cái còn lại:**

| Sản phẩm | Vì sao không |
|---|---|
| **Share Kit** | SDK cho app di động — đẩy nội dung sang app TikTok để người dùng tự hoàn tất. Orbit đăng từ server, không có app di động |
| **Webhooks** | Orbit chưa có endpoint webhook nào. Trạng thái đăng đang poll bằng `status/fetch` |
| **Data Portability API** | Xuất dữ liệu người dùng EEA/UK. Orbit không làm |
| **Local Service API** | Voucher nhà hàng. Không liên quan |

#### `video.list` — thứ duy nhất không có trong danh sách

`/v2/video/query/` cần scope `video.list`, thuộc **Display API**. Tài liệu TikTok
ghi cần *"approval for both a Login Kit and TikTok API products"* nhưng không
gọi tên đúng như portal. Thử thêm Login Kit trước — có thể nó hiện ra sau đó,
hoặc phải đăng ký riêng.

**Thiếu nó thì hỏng gì:**

| Tính năng | Cần `video.list`? |
|---|---|
| Đăng bài (video, ảnh, inbox) | ❌ không |
| Đối soát sau publish gián đoạn | ❌ không — dùng `status/fetch` |
| Đọc trạng thái bài đã đăng | ✅ có |
| Số liệu từng video | ✅ có |

Nên TikTok **vẫn đăng được đầy đủ** nếu thiếu Display API — chỉ mất phần đọc
lại và analytics. Không phải blocking cho việc đăng bài.

> Analytics cấp tài khoản thì **không có dù có Display API** — nó chỉ phục vụ
> số đếm từng video. Descriptor khai `analytics.account: false` đúng như vậy,
> thay vì cộng các video lại thành một con số trông như số liệu tài khoản.

### 🔴 Blocking — nothing publishes publicly without these

- [ ] **Register a TikTok app** at developers.tiktok.com and set
      `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET`. Without them TikTok is not
      offered at all — the provider simply does not register.
- [ ] **Add Login Kit and the Content Posting API products** to the app, and
      enable the **Direct Post** configuration. Without Direct Post enabled,
      only the "send to their inbox" mode works.
- [ ] **Request these scopes**, and only these:

      | Scope | Vì sao |
      |---|---|
      | `user.info.basic` | Nền tảng — `open_id`, `display_name`, `avatar_url` |
      | `user.info.profile` | **@handle.** `username` nằm sau scope riêng này, không phải `basic` |
      | `video.publish` hoặc `video.upload` | Direct Post hoặc inbox — chọn một |
      | `video.list` | Đọc trạng thái bài và số liệu từng video |

      **Không xin `user.info.stats`.** Đó là follower/like count cấp tài khoản,
      và descriptor khai `analytics.account: false` có chủ ý — TikTok không phục
      vụ số liệu cấp tài khoản thật, và cộng các video lại sẽ ra con số trông như
      số liệu tài khoản mà không phải. Xin mà không dùng là lý do bị từ chối.

      > **Bật scope trong portal là chưa đủ.** Scope bật trên app là scope app
      > *được phép xin*, không phải scope được cấp — nó còn phải nằm trong
      > authorization URL. `user.info.profile` từng đúng là trường hợp đó: code
      > có bản đồ field, có gán `handle`, có cả docstring nói "bật trên portal là
      > đủ" — nhưng không xin, nên **không tài khoản TikTok nào có @handle**.
      > Đã sửa 19/10/2026, kèm test chống tái diễn.
- [ ] **Submit the app for TikTok's audit.** Until it passes, **every post the
      app makes is forced private**, whatever visibility anyone chooses. This is
      the same class of blocker as Meta App Review and has the same long lead
      time — start it early.
- [ ] **Register the redirect URI** in Login Kit settings. It must be `https`,
      absolute, and carry no query string or fragment.

### 🟡 Worth knowing

- A TikTok access token lasts **24 hours** and its refresh token **365 days**.
  The refresh sweep handles this, but an account left untouched for a year has
  to be reconnected by hand.
- Videos upload from the worker in chunks against a signed URL that lives
  **15 minutes**. A very large video on a slow link will fail loudly rather than
  post a truncated file.
- **Photo posts are different**: TikTok has no file upload for them, so it
  fetches the images from us. That needs a **verified URL prefix** in the TikTok
  portal, or photo posts fail with `url_ownership_unverified`. Video posts are
  unaffected.

## Threads (added 2026-08-17)

- [ ] **Create a Threads app** and set `THREADS_APP_ID` / `THREADS_APP_SECRET` on
      **both** Vercel and Railway. A Threads app issues **two** id/secret pairs —
      use the **Threads** one. The other pair fails authentication in a way that
      reads like a dead token.
- [ ] **Register the redirect URI**:
      `https://ahn-orbit-web.vercel.app/api/v1/social/oauth/threads/callback`
- [ ] **Request `threads_basic`, `threads_content_publish` and
      `threads_manage_insights`.** The third was missing from this list while
      `THREADS_PUBLISH_SCOPES` asked for it — the same mismatch
      `instagram_manage_insights` had (§1d). Reply permissions are **not** asked
      for: `THREADS_REPLY_SCOPES` exists in the code but never reaches a
      dialog, Orbit does not read or write replies, and an unused permission
      only makes review harder.

### Scope và mô tả App Review

| Scope | Xin? | Vì sao |
|---|---|---|
| `threads_basic` | ✅ | Nền tảng |
| `threads_content_publish` | ✅ | Đăng bài — hai bước `/threads` → `/threads_publish` |
| `threads_manage_insights` | ✅ | Số liệu. **Chưa thấy gắn trên app** — kiểm tra portal |
| `threads_manage_replies` / `threads_read_replies` | ❌ | Khai trong code nhưng **không bao giờ đưa vào dialog**; Orbit không đọc hay viết reply trên Threads |
| `threads_business_basic`, `threads_share_to_instagram` | ❌ | Không dùng — bỏ khỏi app (§1d) |

#### `threads_basic` — dữ kiện để viết mô tả

| Orbit đọc gì | Ở đâu | Để làm gì |
|---|---|---|
| `id,username,name,threads_profile_picture_url` | lúc kết nối | Biết profile vừa kết nối là của client nào |
| `/refresh_access_token` (`th_refresh_token`) | `refreshCredential` | **Giữ kết nối sống** — token 60 ngày |
| `/{id}/threads` → `id,permalink,timestamp,text`, limit 25 | `reconcileByTimeline` | **Chống đăng trùng** khi publish hai bước bị gián đoạn |
| `permalink` | `permalinkFor`, `getPostStatus` | Mở bài thật từ trong Orbit |

> **Đoạn bắt buộc phải có trong mô tả quyền này: *ai nhìn thấy dữ liệu*.**
> Blurb ghi rõ cách dùng hợp lệ là hiển thị bài *"chỉ cho chính người đã tạo
> ra chúng"*. Người duyệt đọc câu đó rồi nhìn một công cụ multi-tenant sẽ
> hỏi ngay — trả lời thẳng tốt hơn để họ tự suy diễn. Câu trả lời là thật:
> profile thuộc về client, dữ liệu chỉ client đó và nhân sự agency được họ
> cấp quyền nhìn thấy, cô lập được cưỡng chế ở **cả tầng ứng dụng và database**.

> **Threads refresh token đúng cách** — `th_refresh_token`, có kiểm tra cửa sổ
> và từ chối khi token đã hết hạn. Ghi lại để đối chiếu: đây là thứ luồng
> Instagram Business Login **thiếu** cho đến khi sửa hôm 16/10 (**D-105**).

#### `threads_content_publish` — dữ kiện để viết mô tả

| Điểm | Giá trị thật trong code |
|---|---|
| Giới hạn ký tự | **500** — ngắn nhất trong các nền tảng (IG 2.200, FB 63.206) |
| Link | tối đa 1 |
| Carousel | 2–20 mục |
| Text thuần | ✅ được — khác Instagram, media không bắt buộc |
| Sửa bài đã đăng | ❌ API không có |
| Xoá bài đã đăng | ❌ API không có |
| Chống đăng trùng | container id trả lời trực tiếp "bài đã ra chưa" |

Giới hạn 500 ký tự đáng đưa vào mô tả: nó cho thấy sản phẩm hiểu Threads
khác các nền tảng kia, chứ không đẩy cùng một caption đi khắp nơi.

### Worth knowing

- A Threads connection lasts **60 days** and renews itself **only while it is
  still valid**. An account left idle past that cannot be refreshed and has to
  be reconnected by hand — unlike TikTok, where the window is a year.
- Threads caps publishing at **250 posts per rolling 24 hours per profile**, and
  Meta asks integrators to enforce it. The engine does.
- Media specifications are barely documented by Meta. The limits Orbit enforces
  for Threads images and video are deliberately generous and marked UNVERIFIED;
  Threads itself remains the authority and its refusals are reported verbatim.

## LinkedIn (added 2026-08-18)

### 🔴 Blocking

- [ ] **Create a LinkedIn app** and request the **Community Management API**
      product. `w_organization_social` — posting to a company page — is only
      granted through it, and approval is a review, not a checkbox.
- [ ] Set `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` on **both** Vercel and
      Railway.
- [ ] **Register the redirect URI**:
      `https://ahn-orbit-web.vercel.app/api/v1/social/oauth/linkedin/callback`
- [ ] Make sure whoever connects **holds an admin role on the company page**.
      LinkedIn only offers pages where that person is ADMINISTRATOR,
      DIRECT_SPONSORED_CONTENT_POSTER or CONTENT_ADMIN. Someone who administers
      no page can sign in successfully and have nothing to connect.

### 🟡 On a calendar, not a checklist

- [ ] **`LINKEDIN_API_VERSION` expires.** It is `YYYYMM` and LinkedIn sunsets a
      version roughly a year after release — currently pinned to `202608`. This
      is the only integration in the product with a scheduled end date; put a
      reminder somewhere before it becomes an incident.

### Not built, deliberately

- **Video** — needs LinkedIn's separate Videos API. Declared `video: null` so
  the composer refuses it rather than accepting a file publishing would reject.
- **Multiple images** — needs the MultiImage API. One image per post today.
- **Analytics** — not collected. The ingestion sweep skips LinkedIn.

---

## YouTube (added 2026-08-19)

### 🔴 Blocking

- [ ] **Tạo OAuth client** trong Google Cloud Console, bật **YouTube Data API
      v3**. Loại client: *Web application*.
- [ ] Đặt `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` trên **cả** Vercel và
      Railway.
- [ ] **Đăng ký redirect URI**:
      `https://ahn-orbit-web.vercel.app/api/v1/social/oauth/youtube/callback`
- [ ] **Cấu hình OAuth consent screen** ở chế độ *External*. Chưa được Google
      xác minh thì **chỉ những email nằm trong danh sách test user mới kết nối
      được** — người khác thấy màn hình cảnh báo và không đi tiếp được.
- [ ] **Xin Google verification.** `youtube.upload` là *sensitive scope*: chưa
      xác minh thì app kẹt ở 100 test user. Quy trình này là một cuộc rà soát,
      không phải ô tích.

### 🟡 Cần biết trước khi lên lịch nhiều video

- **Hạn mức là của *dự án*, không phải của kênh: 100 lượt upload mỗi ngày cho
  toàn bộ deployment.** Mọi khách hàng dùng chung con số này. Vượt hạn mức,
  Orbit ghi nhận lỗi và **không** hạ trạng thái kênh — nhưng bài vẫn không đăng
  được cho tới nửa đêm giờ Thái Bình Dương.
- **Token Google sống 1 tiếng.** Đây là kết nối làm mới thường xuyên nhất trong
  sản phẩm. Nó tự làm mới; chỉ cần biết để không hoảng khi thấy log refresh dày.
- **Một tài khoản Google có thể không có kênh YouTube nào.** Trường hợp đó là
  thật và Orbit nói rõ — phải tạo kênh trên YouTube trước rồi kết nối lại.

### Cố ý không làm

- **Xoá video** — cần scope rộng `.../auth/youtube`, thứ cũng cho phép xoá *bất
  kỳ* video nào của kênh. Không đáng đổi, nên khai `delete: false`; muốn xoá thì
  vào YouTube Studio.
- **Analytics theo kênh** — cần YouTube Analytics API, một API khác hẳn.
- **"Đăng dạng Shorts"** — YouTube không có công tắc đó. Video dọc và đủ ngắn thì
  tự thành Shorts.

### Điều mỗi bài đăng bắt buộc phải chọn

**Made for kids.** YouTube bắt buộc khai báo trên mọi lần upload, và đó là một
tuyên bố pháp lý (COPPA) chứ không phải một tuỳ chọn. **Orbit không chọn thay.**
Bài chưa chọn sẽ *không đăng* — báo lỗi ngay trong composer, không phải im lặng
chọn giùm.

---

## Pinterest (added 2026-08-19)

### 🔴 Blocking

- [ ] **Tạo app** tại developers.pinterest.com và **xin standard access**. Trial
      access chỉ với tới tài khoản của chính người phát triển — đủ để thử, không
      đủ để chạy khách.
- [ ] Đặt `PINTEREST_CLIENT_ID` / `PINTEREST_CLIENT_SECRET` trên **cả** Vercel và
      Railway.
- [ ] **Đăng ký redirect URI**:
      `https://ahn-orbit-web.vercel.app/api/v1/social/oauth/pinterest/callback`

### 🟡 Cần biết

- **Mỗi pin phải nằm trên một board, và Orbit không tự chọn.** Composer đọc danh
  sách board thật từ tài khoản; chưa chọn thì bài không đăng.
- **Pin video bắt buộc có ảnh bìa.** Pinterest hiển thị ảnh tĩnh ở mọi chỗ video
  chưa chạy, và **không** tự lấy khung hình. Cách làm: đính kèm thêm **một ảnh**
  vào bài — ảnh đó thành bìa. Orbit không tự sinh ảnh bìa, vì đó sẽ là một tấm
  hình chưa ai duyệt xuất hiện trước khán giả của khách.
- **Board bí mật không hiện ra.** Orbit không xin scope đọc chúng — cố ý.
- **Token: 30 ngày, làm mới được trong 60 ngày.** Tài khoản có đăng bài đều thì
  không bao giờ phải kết nối lại; để không dùng quá 2 tháng thì phải kết nối lại
  bằng tay.

### Cố ý không làm

- **Analytics theo tài khoản** — chỉ dành cho business account và mô hình báo cáo
  khác hẳn.
- **Sửa pin sau khi đăng** — Orbit chưa có luồng sửa-sau-khi-đăng ở bất kỳ nền
  tảng nào.

---

## Một khoảng trống chung của TikTok, YouTube và Pinterest

Ba nền tảng này có **thiết lập bắt buộc theo từng bài** (quyền riêng tư của
TikTok, khai báo made-for-kids của YouTube, board của Pinterest). Hiện tại việc
kiểm tra nằm **ở lúc đăng**, không phải lúc duyệt bài.

Composer **đã cảnh báo ngay từ đầu** (**D-092**): một thẻ riêng liệt kê *mọi*
tài khoản còn thiếu thiết lập, mở sẵn, kèm câu nói rõ thiếu cái gì — chọn 5 nền
tảng cùng lúc thì thấy cả 5, không phải bấm từng tab. Tài khoản đã đủ thì thu
gọn lại thành một dòng "Ready".

Nhưng cảnh báo đó nằm ở **trình duyệt**. Server `/validate` vẫn chưa biết về các
thiết lập này, nên **một bài lên lịch mà thiếu thiết lập vẫn hỏng đúng giờ
đăng** nếu ai đó bỏ qua cảnh báo — chứ không bị chặn lúc duyệt.

Sửa triệt để cần dạy cho capability descriptor biết nền tảng nào bắt buộc thiết
lập gì, để bộ validate kiểm tra được mà không cần biết tên nền tảng nào. Đó là
thay đổi chạm cả bảy adapter, nên em ghi lại (**D-090/D-091**) thay vì làm lặng
lẽ. Anh muốn em làm thì nói.
