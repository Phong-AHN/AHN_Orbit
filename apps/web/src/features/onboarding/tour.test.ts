import { describe, expect, it } from 'vitest';
import { EDGE, GAP, TOUR_STEPS, placeTooltip, spotlightRect } from './tour';

const viewport = { width: 1280, height: 800 };
const card = { width: 320, height: 180 };

describe('placeTooltip', () => {
  it('centres the card when a step has no target', () => {
    expect(placeTooltip(null, card, viewport)).toEqual({
      top: 310,
      left: 480,
      placement: 'center',
    });
  });

  it('puts it below a small target, centred on it', () => {
    const position = placeTooltip({ top: 40, left: 600, width: 80, height: 32 }, card, viewport);
    expect(position.placement).toBe('bottom');
    expect(position.top).toBe(40 + 32 + GAP);
    expect(position.left).toBe(600 + 40 - 160);
  });

  it('puts it above a target near the bottom of the window', () => {
    const position = placeTooltip({ top: 740, left: 1100, width: 120, height: 48 }, card, viewport);
    expect(position.placement).toBe('top');
    expect(position.top).toBe(740 - GAP - 180);
    // Kept inside the window on the right.
    expect(position.left + card.width).toBeLessThanOrEqual(viewport.width - EDGE);
  });

  it('puts it beside a tall target such as the navigation rail', () => {
    const position = placeTooltip({ top: 0, left: 0, width: 240, height: 800 }, card, viewport);
    expect(position.placement).toBe('right');
    expect(position.left).toBe(240 + GAP);
  });

  it('never leaves the window on a small phone', () => {
    const phone = { width: 360, height: 640 };
    const position = placeTooltip({ top: 8, left: 8, width: 344, height: 600 }, card, phone);
    expect(position.left).toBeGreaterThanOrEqual(EDGE);
    expect(position.top + card.height).toBeLessThanOrEqual(phone.height - EDGE);
  });
});

describe('spotlightRect', () => {
  it('pads the target and stays inside the window', () => {
    expect(spotlightRect({ top: 2, left: 2, width: 100, height: 20 }, viewport)).toEqual({
      top: 0,
      left: 0,
      width: 108,
      height: 28,
    });
  });
});

describe('TOUR_STEPS', () => {
  it('opens and closes with a centred card, and every other step points somewhere', () => {
    expect(TOUR_STEPS[0]!.targets).toBeUndefined();
    expect(TOUR_STEPS.at(-1)!.targets).toBeUndefined();
    for (const step of TOUR_STEPS.slice(1, -1))
      expect(step.targets?.length, step.id).toBeGreaterThan(0);
    expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(TOUR_STEPS.length);
  });
});
