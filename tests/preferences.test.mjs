import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultPreferences, parsePreferences, relockAfterMs, shouldRelock } from '../src/preferences-core.ts';

test('reads saved preferences and falls back for missing, corrupt or wrong-typed values', () => {
  assert.deepEqual(parsePreferences(null), defaultPreferences);
  assert.deepEqual(parsePreferences('not json'), defaultPreferences);
  assert.deepEqual(parsePreferences('null'), defaultPreferences);
  assert.deepEqual(
    parsePreferences(JSON.stringify({ appLock: true, hideBalance: 'yes', haptics: false, extra: true })),
    { ...defaultPreferences, appLock: true, haptics: false },
  );
});

test('re-locks only when enabled and after the background grace period', () => {
  assert.equal(shouldRelock(false, 0, relockAfterMs * 10), false);
  assert.equal(shouldRelock(true, null, relockAfterMs * 10), false);
  assert.equal(shouldRelock(true, 1_000, 1_000 + relockAfterMs - 1), false);
  assert.equal(shouldRelock(true, 1_000, 1_000 + relockAfterMs), true);
});
