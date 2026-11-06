import { describe, expect, it } from 'vitest';
import { workerBuild } from './build-info.js';

describe('workerBuild', () => {
  it('names the commit this process was built from', () => {
    expect(
      workerBuild({ RAILWAY_GIT_COMMIT_SHA: 'd0beb8f5c55b36df7d674d55965a23b8d54ad69b' }),
    ).toEqual({ workerCommit: 'd0beb8f' });
  });

  /** Railway sets it only for a deploy GitHub triggered, and never locally. */
  it('says nothing rather than guess when the commit is unknown', () => {
    expect(workerBuild({})).toEqual({});
  });
});
