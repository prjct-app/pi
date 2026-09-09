import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMethodProgress } from '../src/work/method-progress.ts';

test('a TDD cycle cannot treat an unrun test as red', () => {
  assert.throws(() => assertMethodProgress({
    methodId: 'tdd', from: 'test_authored', to: 'red_observed',
    evidence: [{ id: 'unrun', provenance: 'agent_report' }],
  }), { code: 'INVALID_STAGE' });
});

test('green cannot be claimed by relabelling a later pass when red was never observed', () => {
  assert.throws(() => assertMethodProgress({
    methodId: 'tdd', from: 'test_authored', to: 'green_observed',
    evidence: [{ id: 'pass', provenance: 'native_observation' }],
  }), { code: 'INVALID_STAGE' });
});

test('an interrupted green_pending TDD task can continue without a handoff artifact', () => {
  assert.doesNotThrow(() => assertMethodProgress({
    methodId: 'tdd', from: 'green_pending', to: 'green_pending', handoffArtifact: false,
    evidence: [{ id: 'red_observation', provenance: 'native_observation' }],
  }));
});

test('one review pass cannot stand in for both standards and spec axes', () => {
  assert.throws(() => assertMethodProgress({
    methodId: 'code-review', from: 'standards_pass', to: 'complete',
    evidence: [{ id: 'same_pass', provenance: 'agent_report' }],
  }), { code: 'INVALID_STAGE' });
});

test('grilling cannot record a settled decision without a current user observation', () => {
  assert.throws(() => assertMethodProgress({
    methodId: 'grilling', from: 'round_prepared', to: 'decision_recorded',
    evidence: [{ id: 'guess', provenance: 'agent_report' }],
  }), { code: 'INVALID_STAGE' });
});

test('research cannot close from unattributed search hits', () => {
  assert.throws(() => assertMethodProgress({
    methodId: 'research', from: 'query', to: 'complete',
    evidence: [{ id: 'hit', provenance: 'agent_report' }],
  }), { code: 'INVALID_STAGE' });
});

test('diagnosis without a reproduction loop stays blocked', () => {
  assert.throws(() => assertMethodProgress({
    methodId: 'diagnosing-bugs', from: 'symptom', to: 'fixed',
    evidence: [{ id: 'guess', provenance: 'agent_report' }],
  }), { code: 'INVALID_STAGE' });
});
