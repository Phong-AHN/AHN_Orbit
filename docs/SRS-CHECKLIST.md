# AHN Orbit — SRS compliance checklist

> Đối chiếu từng mục trong bảng phân loại tính năng (`docs/BUILD-PLAN.md` §1,
> trả lời SRS §40) với **mã thật đang có trong repo**, kiểm chứng bằng grep vào
> ngày 2026-08-19 (cập nhật sau TikTok, Reels, Threads, LinkedIn, YouTube và
> Pinterest). Không mục nào ở đây được đánh dấu dựa trên trí nhớ.
>
> **✅ xong** · **⚠️ một phần** (làm rõ thiếu gì) · **❌ chưa làm**
>
> `P0` = bắt buộc cho MVP · `P1` = quan trọng sau MVP · `P2` = tương lai

## Tóm tắt

| | P0 | P1 | P2 | Tổng |
|---|:--:|:--:|:--:|:--:|
| ✅ xong | 47 | 21 | 5 | **73** |
| ⚠️ một phần | 2 | 1 | 0 | **3** |
| ❌ chưa làm | 0 | 7 | 10 | **17** |
| **Tổng** | **49** | **29** | **15** | **93** |

**Toàn bộ P0 đã có mã chạy được.** Hai mục P0 còn ⚠️ là *chất lượng nền tảng*
(responsive, accessibility): đã làm theo từng trang nhưng **chưa quét có hệ
thống** — xem cuối tài liệu.

---

## 1. Xác thực & bảo mật (SRS §6, §31)

| Tính năng | Pri | | Ở đâu |
|---|:--:|:--:|---|
| Email/mật khẩu, xác minh, đặt lại (Firebase) | P0 | ✅ | `packages/auth/src/identity.ts` |
| Đăng nhập Google | P0 | ✅ | Firebase provider |
| Session cookie + xác minh phía server | P0 | ✅ | `packages/auth/src/session.ts` |
| CSRF, XSS, cookie an toàn, validate đầu vào | P0 | ✅ | `session.ts` (`sameSite`), Zod ở mọi route |
| Rate limiting | P0 | ✅ | `packages/queue/src/rate-limit.ts`, dùng ở AI + publishing |
| OAuth state validation + mã hoá token | P0 | ✅ | `features/social/oauth-state.ts`, `providers/src/credential-cipher.ts` |
| Audit logging | P0 | ✅ | `apps/web/src/server/audit.ts` — mọi mutation |
| Xác thực chữ ký webhook | P0 | ✅ | `X-Hub-Signature-256` HMAC-SHA256 trong `facebook/provider.ts:644`. **Chưa có endpoint webhook nào gọi tới** — provider webhook là P2, nên hàm này đang chờ sẵn đúng như thiết kế: có trước khi cần |
| 2FA | P1 | ❌ | Cần nâng lên Identity Platform — **chờ anh quyết chi phí** |
| SSO / SAML | P2 | ❌ | |

## 2. Đa tenant & phân quyền (SRS §4, §5)

| Tính năng | Pri | | Ở đâu |
|---|:--:|:--:|---|
| CRUD Organization / Workspace / Brand | P0 | ✅ | `features/tenancy/` |
| Membership + lời mời | P0 | ✅ | `features/tenancy/ui/`, `/accept-invitation` |
| RBAC engine + đủ 7 vai trò | P0 | ✅ | `packages/rbac/` — 66 permission |
| Tầng dữ liệu scope theo tenant | P0 | ✅ | `withTenant`, `packages/db` từ chối `upsert` |
| Postgres RLS làm lớp chắn | P0 | ✅ | 34 composite tenant FK + RLS |
| Thu hẹp phân quyền theo brand | P1 | ✅ | `packages/rbac/src/matrix.ts` — scope `BRAND` |
| Chuyển quyền sở hữu | P1 | ⚠️ | Permission `org:transfer_ownership` đã có trong ma trận; **chưa có route hay UI** |
| Vai trò tuỳ biến | P2 | ❌ | |

## 3. Mạng xã hội (SRS §7, §8)

| Tính năng | Pri | | Ghi chú |
|---|:--:|:--:|---|
| Kiến trúc provider adapter + capability system | P0 | ✅ | `packages/providers/` |
| Facebook Pages: OAuth, kết nối, health, ngắt | P0 | ✅ | Đã publish thật end-to-end |
| Facebook: đăng text / link / 1 ảnh | P0 | ✅ | |
| Facebook: đăng nhiều ảnh | P0 | ✅ | |
| Facebook: đăng video | P1 | ✅ | Reels, ba pha; Meta tự tải file qua `file_url` (**D-087**) |
| Facebook: Reels | P1 | ✅ | 9:16, 3–90 giây, 24–60fps |
| Refresh token + luồng kết nối lại | P0 | ✅ | `features/social/health.ts` |
| Instagram | P1 | ✅ | Ảnh, carousel 2–10, và **Reels** (`media_type=REELS`, chờ container) |
| **LinkedIn** | P1 | ✅ | Text/ảnh/link lên company page; **xoá được bài** (**D-089**). Video và analytics chưa làm |
| X | P1 | ❌ | |
| **TikTok** | P2 | ✅ | Video + photo, chunk upload, reconcile theo `publish_id` (**D-086**) |
| **Threads** | P2 | ✅ | Text/ảnh/carousel, chờ container mọi loại bài, token tự làm mới (**D-088**) |
| **YouTube** | P2 | ✅ | Upload video resumable; khai báo *made for kids* bắt buộc, Orbit không tự chọn (**D-090**) |
| **Pinterest** | P2 | ✅ | Pin ảnh và video; bắt buộc chọn board, video pin bắt buộc có ảnh bìa (**D-091**) |
| Webhook từ provider | P2 | ❌ | |

## 4. Nội dung & xuất bản (SRS §9–§14)

| Tính năng | Pri | | Ghi chú |
|---|:--:|:--:|---|
| Composer: text, đính kèm media, chọn nhiều account | P0 | ✅ | `features/posts/ui/composer.tsx` |
| Thiết lập riêng theo nền tảng, hiện cùng lúc cho mọi account | P1 | ✅ | Một thẻ liệt kê mọi account còn thiếu (**D-092**) |
| Variant theo từng account | P0 | ✅ | Kèm first comment nơi platform hỗ trợ |
| Validate theo capability (client + server) | P0 | ✅ | Một engine duy nhất, chạy server-side |
| **Preview** | P0 | ✅ | **D-084** — Facebook và Instagram vẽ khác nhau |
| Draft + autosave | P0 | ✅ | Có phát hiện xung đột khi 2 người sửa |
| Nhân bản / xoá | P0 | ✅ | `duplicatePost` — bản sao luôn là draft mới |
| Máy trạng thái (§10) | P0 | ✅ | Một máy trạng thái duy nhất, dùng chung |
| Lịch: tháng + danh sách | P0 | ✅ | |
| Lịch: tuần | P1 | ✅ | **D-082** |
| Kéo-thả đổi lịch | P0 | ✅ | Cả tháng lẫn tuần; server quyết instant |
| Lên lịch chính xác, đúng múi giờ | P0 | ✅ | Wall-clock gửi lên, server resolve |
| Đăng ngay | P0 | ✅ | Chỉ Owner/Admin/Account Manager |
| Queue slot / lên lịch theo queue | P1 | ✅ | **D-083** — UI vừa xong |
| Queue + worker + publish idempotent | P0 | ✅ | 4 lớp idempotency; **D-027** |
| Retry, backoff, dead-letter | P0 | ✅ | Kết quả mập mờ → `NEEDS_REVIEW`, không retry |
| Log xuất bản + retry thủ công | P0 | ✅ | `/orgs/{slug}/publishing` |
| Trợ giúp hashtag / mention / emoji | P1 | ❌ | Capability đã biết giới hạn hashtag; **chưa có UI gợi ý** |
| Bulk actions, import CSV | P2 | ❌ | |

## 5. Quy trình & cộng tác (SRS §11, §15, §16)

| Tính năng | Pri | | Ghi chú |
|---|:--:|:--:|---|
| Trạng thái duyệt nội bộ + duyệt khách | P0 | ✅ | |
| Duyệt / yêu cầu sửa + bình luận | P0 | ✅ | |
| Màn hình hàng chờ duyệt | P0 | ✅ | `/orgs/{slug}/approvals` |
| Client portal: lịch, chờ duyệt, đã đăng | P0 | ✅ | `(portal)/portal/` — 5 trang |
| Production task (§11) | P1 | ✅ | `features/tasks/` — **D-052** |
| Giao việc | P1 | ✅ | `assignee-select.tsx` |
| Bình luận có mention, đóng thread | P1 | ✅ | `mentionedUserIds`, `resolvedAt` |
| Client portal: analytics + kho asset | P1 | ❌ | Portal hiện chỉ có nội dung, không có số liệu |
| Activity feed | P1 | ✅ | **D-053** — keyset paging |
| Portal gắn nhãn trắng | P2 | ❌ | |

## 6. Media (SRS §17)

| Tính năng | Pri | | Ghi chú |
|---|:--:|:--:|---|
| Upload presigned + xác minh **bytes thật** phía server | P0 | ✅ | Không tin MIME của client |
| Đính kèm media trong composer | P0 | ✅ | |
| URL đọc có chữ ký + cô lập tenant | P0 | ✅ | **D-054** |
| Thư viện: duyệt, tìm, tag, **folder** | P1 | ✅ | **D-081** — xoá folder không bao giờ xoá ảnh |
| Gắn theo brand | P1 | ✅ | |
| Chèn asset có sẵn từ thư viện vào post | P1 | ✅ | `LibraryPicker` nối thẳng vào `MediaPanel` — dùng lại thay vì upload trùng |
| Transcode / tự resize | P2 | ❌ | |

## 7. Phân tích, báo cáo, AI, thanh toán, quản trị (SRS §18–§20, §23–§25, §28, §38)

| Tính năng | Pri | | Ghi chú |
|---|:--:|:--:|---|
| Thu thập analytics + bản đồ khả dụng | P1 | ✅ | Phase 3 — **không bao giờ hiện "0" cho số liệu không có** |
| UI analytics post & account | P1 | ✅ | Backfill 30 ngày, giữ 13 tháng |
| Dashboard agency + cảnh báo | P1 | ✅ | Cảnh báo account-health là P0 |
| Báo cáo khách, export **CSV** | P1 | ✅ | `REPORT_FORMATS = ['CSV']` |
| Báo cáo khách, export **PDF** | P1 | ❌ | **Chờ anh chọn thư viện PDF** (đề xuất `pdfkit`) |
| Báo cáo theo lịch | P2 | ❌ | |
| Brand Brain (lưu giọng thương hiệu) | P1 | ✅ | `features/brand-voice/` |
| AI caption / rewrite / hashtags | P1 | ✅ | Gemini qua REST; 1 request = 1 credit |
| AI lập kế hoạch nội dung, repurpose | P2 | ✅ | `features/ideas/`, `ai/repurpose` |
| AI dựa trên hiệu suất | P2 | ❌ | |
| Schema subscription + kiểm tra hạn mức plan | P0 | ✅ | Thực thi ở **4 chiều**: workspace/member (`tenancy`), social account (`social`), dung lượng (`media`), AI credit (`ai`) |
| Stripe checkout + portal | P1 | ❌ | Chỉ có cột `stripeCustomerId` và biến môi trường |
| Admin: org, user, job, health | P0 | ✅ | 5 trang + 8 route |
| Admin: system log, subscription | P1 | ❌ | Permission `admin:view_system_logs` đã có, chưa có màn hình |
| Đóng vai người dùng (impersonation) | P2 | ❌ | Permission đã có, cố tình chưa cài |

## 8. Chất lượng nền tảng (SRS §29–§33, §41)

| Tính năng | Pri | | Ghi chú |
|---|:--:|:--:|---|
| Design system + token + đủ 4 trạng thái UI | P0 | ✅ | `@orbit/ui` |
| Responsive desktop/tablet; mobile dùng được | P0 | ⚠️ | Làm theo từng trang, **chưa quét hệ thống** 320→1440px |
| Nền tảng accessibility | P0 | ⚠️ | Semantic/label/focus có sẵn theo component, **chưa audit toàn bộ** |
| Log có cấu trúc + Sentry | P0 | ✅ | `@orbit/observability` |
| Unit test: RBAC, cô lập, transition, validate, idempotency | P0 | ✅ | **805 test** |
| Integration test: auth, OAuth, publishing, queue | P0 | ✅ | **663 test** |
| E2E: luồng tới hạn §32 | P0 | ✅ | **19 test** — `apps/web/e2e/publishing-flow.e2e.test.ts` |
| Tài liệu OpenAPI | P0 | ✅ | `/api/v1/openapi.json` |
| Kiểm thử tải / hiệu năng | P2 | ❌ | |

---

## Hai mục P0 còn ⚠️, nói thẳng

Cả hai đều **không phải chưa làm gì** — chúng chưa được *kiểm chứng có hệ
thống*, và đó là hai chuyện khác nhau:

- **Responsive.** Mọi trang đều dựng bằng flex/grid và token, bảng rộng đã bọc
  `overflow-x-auto`. Nhưng chưa ai mở từng trang ở 320 / 375 / 390 / 430 / 768 /
  1024 / 1440px để xem cái gì vỡ. Rủi ro thật nằm ở lịch tuần (7 cột,
  `min-w-[52rem]`) và các bảng analytics.
- **Accessibility.** Component trong `@orbit/ui` có label, `role`, focus ring;
  dialog có bẫy focus. Chưa chạy một lượt audit đủ: thứ tự heading, độ tương
  phản ở cả hai theme, điều hướng chỉ bằng bàn phím, thông báo cho screen
  reader khi nội dung đổi bất đồng bộ.

Đây là hai việc tiếp theo trong kế hoạch.

## Bốn quyết định đang chờ anh

Chi tiết trong [OWNER-TODO.md](OWNER-TODO.md):

1. **Thư viện PDF** cho export báo cáo — đề xuất `pdfkit`.
2. **Chi phí Identity Platform** cho 2FA.
3. **Thứ tự ưu tiên** provider còn thiếu — hiện chỉ còn **X (Twitter)**.
4. **Nộp Meta App Review** — không có nó thì Facebook/Instagram chỉ chạy được
   với tài khoản test.

## Những gì cố ý không làm

Không phải mọi ô ❌ đều là thiếu sót. Ba mục dưới đây là **quyết định**, có ghi
lý do trong `DECISIONS.md`:

- **Video Facebook/Instagram** — capability khai `video: null` nên engine *từ
  chối* thay vì thử rồi đăng hỏng. Từ chối rõ ràng tốt hơn một bài đăng sai.
- **Kéo-thả theo *giờ*** trong lịch — **D-082**. Lưới giờ biến sai lệch 11 phút
  thành sai lệch vài pixel; giờ được *gõ* chứ không *nhắm*.
- **Impersonation** — permission tồn tại trong ma trận nhưng cố ý chưa cài, vì
  nó cần đường audit riêng trước khi ai đó dùng được.
