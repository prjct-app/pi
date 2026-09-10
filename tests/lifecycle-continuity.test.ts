import assert from 'node:assert/strict';
import test from 'node:test';
import { LifecycleContinuity } from '../src/work/lifecycle-continuity.ts';

test('each lifecycle invalidation emits exactly one bounded stale re-anchor and warm turns emit none', () => {
  const continuity = new LifecycleContinuity();
  assert.equal(continuity.consume('warm'), undefined);
  continuity.mark('resume');
  const first = continuity.consume('x'.repeat(5000));
  assert.ok(first);
  assert.ok(Buffer.byteLength(first!, 'utf8') <= 2048);
  assert.match(first!, /stale re-anchor after resume/);
  assert.match(first!, /No task or writer grant was restored/);
  assert.equal(continuity.consume('warm'), undefined);
  continuity.mark('compact');
  assert.match(continuity.consume('selected work')!, /after compact/);
  assert.equal(continuity.consume('warm'), undefined);
});

test('a later lifecycle event replaces an undelivered stale anchor without duplication', () => {
  const continuity = new LifecycleContinuity();
  continuity.mark('startup');
  continuity.mark('tree');
  assert.match(continuity.consume('selected work')!, /after tree/);
  assert.equal(continuity.consume('warm'), undefined);
});
