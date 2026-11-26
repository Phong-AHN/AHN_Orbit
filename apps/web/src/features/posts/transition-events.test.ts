import { describe, expect, it } from 'vitest';
import { POST_STATUSES } from '@orbit/core';
import { transitionEvents } from './transition-events';

/** What a post moving tells people (SRS §22, D-129). */
describe('transition events', () => {
  it('says a scheduled post was canceled', () => {
    expect(transitionEvents('SCHEDULED', 'CANCELED')).toEqual(['post.canceled']);
  });

  it('says a scheduled post went back to draft', () => {
    expect(transitionEvents('SCHEDULED', 'DRAFT')).toEqual(['post.unscheduled']);
  });

  it('says nothing about canceling a post that was never on the schedule', () => {
    for (const from of POST_STATUSES.filter((status) => status !== 'SCHEDULED')) {
      expect(transitionEvents(from, 'CANCELED'), from).toEqual([]);
    }
  });

  it('keeps the review events as they were', () => {
    expect(transitionEvents('DRAFT', 'INTERNAL_REVIEW')).toEqual(['post.approval_requested']);
    expect(transitionEvents('INTERNAL_REVIEW', 'CLIENT_REVIEW')).toEqual([
      'post.approval_requested',
      'post.client_review_requested',
    ]);
    expect(transitionEvents('CLIENT_REVIEW', 'CHANGES_REQUESTED')).toEqual([
      'post.changes_requested',
    ]);
    expect(transitionEvents('CLIENT_REVIEW', 'APPROVED')).toEqual(['post.approved']);
    expect(transitionEvents('APPROVED', 'SCHEDULED')).toEqual([]);
  });
});
