/**
 * @orbit/notifications — telling people things (SRS §22, T1.15).
 *
 * A package rather than code in one app, because both processes raise
 * notifications: the web app when a post moves through review, the worker when
 * a publish fails or an account's token dies. The part that must not be
 * duplicated is `resolveRecipients` — fan-out is a disclosure decision, and two
 * implementations of "who may see this" is one too many.
 *
 * Shaped like `@orbit/auth`: domain decisions plus the data access they need,
 * with `@orbit/rbac` making every authorization call.
 */

export {
  NOTIFICATION_TYPES,
  isNotificationType,
  type NotificationType,
  type NotificationEvent,
  type NotificationResource,
} from './types.js';

export { notificationContent, type NotificationContent } from './content.js';

export { EMAIL_DELIVERY_ENABLED, channelsFor, type DeliveryPreferences } from './channels.js';

export {
  RECIPIENT_RULES,
  resolveRecipients,
  type RecipientOverrides,
  type RecipientRule,
  type RecipientScope,
} from './recipients.js';

export { notify, type NotifyInput, type NotifyResult } from './write.js';

export {
  listNotifications,
  markAllRead,
  markRead,
  unreadCount,
  type ListNotificationsOptions,
  type NotificationView,
} from './read.js';
