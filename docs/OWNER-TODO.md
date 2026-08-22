# Việc cần anh làm — AHN Orbit

> Cập nhật 2026-08-16. Đây là những việc **chỉ anh làm được**: quyết định thương
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

**Cần nộp gì:**

| Quyền | Dùng để |
|---|---|
| `pages_manage_posts` | Đăng bài lên Facebook Page |
| `pages_read_engagement` | Đọc số liệu Page |
| `instagram_content_publish` | Đăng lên Instagram |
| `instagram_manage_insights` | Đọc số liệu Instagram |
| `business_management` | Khám phá tài khoản khi kết nối |

**Lưu ý:** tên quyền Instagram là `instagram_content_publish` — **không có `-ing`**.
Chính tài liệu use-case của Meta ghi sai thành `instagram_content_publishing`, và
đó là lỗi đã làm hỏng một lần thử kết nối thật (xem `DECISIONS.md`).

**Cần chuẩn bị:** video demo luồng đăng bài, chính sách quyền riêng tư
(`/privacy-policy` đã có), mô tả use-case, và giấy tờ doanh nghiệp cho Business
Verification.

**Thời gian:** thường **2–6 tuần**, có thể vài vòng. **Nộp càng sớm càng tốt** —
nó chạy song song với việc phát triển, không phụ thuộc gì vào code.

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
| `GEMINI_API_KEY` | Google AI Studio | tuỳ chọn¹ |
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

**Thứ tự bắt buộc: migration → worker → web.**

Hai migration đang chờ:

| Migration | Nội dung |
|---|---|
| `20260814000000_variant_provider_ref` | Thêm `PostVariant.providerRef` |
| `20260814010000_report` | Bảng `Report` + 2 enum |

```bash
pnpm db:migrate:deploy
```

**Nếu deploy worker trước khi chạy migration:** mọi lần publish Instagram sẽ hỏng
với lỗi thiếu cột, và mọi job render report sẽ hỏng.

Grace period của worker **không được dưới 90 giây** — một publish có thể đang
giữa chừng với timeout 60s.

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

1. **Media folders** (schema đã có, thiếu UI)
2. **Calendar week/list view** (hiện chỉ có month)
3. **Composer platform preview** (Facebook và Instagram đang trông giống hệt nhau)
4. **QueueSlot UI** (model có, chưa có màn hình)
5. **Rà soát responsive + accessibility có hệ thống**

Em sẽ không hỏi gì về những mục này.

## TikTok (added 2026-08-17)

### 🔴 Blocking — nothing publishes publicly without these

- [ ] **Register a TikTok app** at developers.tiktok.com and set
      `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET`. Without them TikTok is not
      offered at all — the provider simply does not register.
- [ ] **Add the Content Posting API product** to the app, and enable the
      **Direct Post** configuration. Without Direct Post enabled, only the
      "send to their inbox" mode works.
- [ ] **Request the `video.publish` scope** (Direct Post) and/or `video.upload`
      (inbox mode), plus `video.list` for analytics.
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
- [ ] **Request `threads_basic` and `threads_content_publish`.** Reply
      permissions are not asked for — Orbit does not read or write replies, and
      an unused permission only makes review harder.

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
