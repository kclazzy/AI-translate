import { describe, expect, it } from 'vitest';
import { inWorkShown } from './busy';

describe('«N в работе» in the popup', () => {
  it('goes by what the page itself still waits for', () => {
    expect(inWorkShown(3, { inWork: 2 })).toEqual({ shown: 2, stale: false });
  });
  it('a page with everything translated shows no work, and the leftover count is stale', () => {
    expect(inWorkShown(1, { inWork: 0 })).toEqual({ shown: 0, stale: true });
  });
  it('without an answer from the page (no content script there) the badge is all there is', () => {
    expect(inWorkShown(2, null)).toEqual({ shown: 2, stale: false });
  });
  it('nothing counted, nothing waiting', () => {
    expect(inWorkShown(0, { inWork: 0 })).toEqual({ shown: 0, stale: false });
  });
});
