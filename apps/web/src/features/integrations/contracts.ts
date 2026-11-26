import { z } from 'zod';
import { SLACK_EVENT_TYPES } from '@orbit/notifications';

/**
 * Connecting an organization's Slack channel (D-129).
 *
 * `webhookUrl` is optional on purpose: once connected, changing which events
 * are sent must not require pasting the secret again — and the page cannot
 * show it to be copied back, because it is never returned.
 */
export const saveSlackSchema = z.object({
  webhookUrl: z
    .string()
    .trim()
    .max(500)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /** A label for the page, e.g. `#social-alerts`. Slack decides the real channel. */
  channel: z
    .string()
    .trim()
    .max(80)
    .optional()
    .nullable()
    .transform((value) => (value ? value : null)),
  events: z.array(z.enum(SLACK_EVENT_TYPES)).max(SLACK_EVENT_TYPES.length),
});

export type SaveSlackInput = z.infer<typeof saveSlackSchema>;
