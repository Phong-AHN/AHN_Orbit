import { describe, expect, it } from 'vitest';
import {
  attachmentWord,
  attachmentsOf,
  describeRemaining,
  participantLabel,
  previewLine,
  windowLabel,
} from './inbox';

const now = new Date('2026-10-23T10:00:00.000Z');
const inHours = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();

describe('windowLabel', () => {
  it('says how long is left, calmly, with plenty left', () => {
    expect(windowLabel({ state: 'OPEN', closesAt: inHours(20) }, now)).toEqual({
      text: 'Reply within 20 h',
      tone: 'neutral',
    });
  });

  /** Under three hours "later" stops being safe. */
  it('warns when the window is nearly over', () => {
    expect(windowLabel({ state: 'OPEN', closesAt: inHours(2) }, now).tone).toBe('warning');
  });

  it('names the human-agent window, so a days-old reply makes sense', () => {
    expect(windowLabel({ state: 'HUMAN_AGENT', closesAt: inHours(72) }, now)).toEqual({
      text: 'Reply as a person within 3 days',
      tone: 'warning',
    });
  });

  it('says plainly that a closed conversation cannot be answered', () => {
    expect(windowLabel({ state: 'CLOSED', closesAt: null }, now)).toEqual({
      text: 'Can’t reply until they message again',
      tone: 'danger',
    });
  });
});

describe('describeRemaining', () => {
  /** Rounded down: never promises more time than is left. */
  it('rounds down at every scale', () => {
    expect(describeRemaining(59 * 60_000)).toBe('59 min');
    expect(describeRemaining(119 * 60_000)).toBe('1 h');
    expect(describeRemaining(47.9 * 3_600_000)).toBe('47 h');
    expect(describeRemaining(71 * 3_600_000)).toBe('2 days');
  });

  it('never says zero minutes', () => {
    expect(describeRemaining(20_000)).toBe('1 min');
    expect(describeRemaining(-5)).toBe('moments');
  });
});

describe('previewLine', () => {
  it('shows the person’s text, and marks the brand’s own', () => {
    expect(
      previewLine({
        direction: 'INBOUND',
        text: 'Còn hàng không?',
        attachments: [],
        deletedAt: null,
      }),
    ).toBe('Còn hàng không?');
    expect(
      previewLine({ direction: 'OUTBOUND', text: 'Dạ còn ạ', attachments: [], deletedAt: null }),
    ).toBe('You: Dạ còn ạ');
  });

  it('describes an attachment-only message', () => {
    expect(
      previewLine({
        direction: 'INBOUND',
        text: null,
        attachments: [{ type: 'image', url: 'https://cdn.test/x' }],
        deletedAt: null,
      }),
    ).toBe('Sent a photo');
  });

  /** An unsent message keeps its place and loses its words. */
  it('does not show the words of an unsent message', () => {
    expect(previewLine({ direction: 'INBOUND', text: null, attachments: [], deletedAt: now })).toBe(
      'Message unsent',
    );
  });

  it('shortens a long message', () => {
    const line = previewLine({
      direction: 'INBOUND',
      text: 'a'.repeat(200),
      attachments: [],
      deletedAt: null,
    });
    expect(line.length).toBe(90);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('attachmentWord', () => {
  it('names the kinds people send most', () => {
    expect(attachmentWord([{ type: 'video' }])).toBe('Sent a video');
    expect(attachmentWord([{ type: 'audio' }])).toBe('Sent a voice message');
    expect(attachmentWord([{ type: 'story_mention' }])).toBe('Mentioned you in a story');
    expect(attachmentWord([{ type: 'something-new' }])).toBe('Sent an attachment');
    expect(attachmentWord(null)).toBe('Sent a message');
  });
});

describe('participantLabel', () => {
  it('prefers the name, then the username', () => {
    expect(participantLabel({ participantName: 'Lan Phạm', participantUsername: 'lan' })).toBe(
      'Lan Phạm',
    );
    expect(participantLabel({ participantName: null, participantUsername: 'lan' })).toBe('@lan');
  });

  /** The platform id is meaningless to a person and is never shown. */
  it('falls back to a neutral label rather than an id', () => {
    expect(participantLabel({ participantName: ' ', participantUsername: null })).toBe(
      'Instagram or Facebook user',
    );
  });
});

describe('attachmentsOf', () => {
  it('keeps well-formed entries and drops the rest', () => {
    expect(
      attachmentsOf([
        { type: 'image', url: 'https://x' },
        { url: 'no type' },
        null,
        { type: 'file' },
      ]),
    ).toEqual([
      { type: 'image', url: 'https://x' },
      { type: 'file', url: null },
    ]);
    expect(attachmentsOf('not an array')).toEqual([]);
  });
});
