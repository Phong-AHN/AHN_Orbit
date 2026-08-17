import { z } from 'zod';

/**
 * Production task schemas (SRS §11).
 *
 * As elsewhere, what is absent matters: no `organizationId`, no `postId` in the
 * body — both come from the route and the tenant context — and no `completedAt`,
 * which the service stamps when a task actually reaches DONE.
 */

export const PRODUCTION_STAGES = [
  'IDEA',
  'COPYWRITING',
  'DESIGN',
  'INTERNAL_REVIEW',
  'CLIENT_REVIEW',
  'SCHEDULING',
] as const;

export const PRODUCTION_TASK_STATES = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE'] as const;

export const createTaskSchema = z.object({
  stage: z.enum(PRODUCTION_STAGES),
  assigneeId: z.string().uuid().nullish(),
  dueAt: z.string().datetime().nullish(),
  /**
   * A blocking task holds the post in DRAFT.
   *
   * Default false, deliberately: a task that stops the work should be an
   * explicit choice, not something a person discovers when the post will not
   * move.
   */
  blocking: z.boolean().default(false),
});

export const updateTaskSchema = z
  .object({
    state: z.enum(PRODUCTION_TASK_STATES).optional(),
    assigneeId: z.string().uuid().nullish(),
    dueAt: z.string().datetime().nullish(),
    blocking: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Provide at least one field to update',
  });

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
