import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  REQUIRED_FAILURE_CLASSES,
  REQUIRED_MEASUREMENTS,
  REQUIRED_SYSTEM_IDS,
  validateMeasurementContract,
  validateResultBundle,
} from './measurement-contract.mjs';

const contract = JSON.parse(await readFile(new URL('./measurement-contract.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);

test('the pinned comparison matrix satisfies the measurement contract', () => {
  const summary = validateMeasurementContract(contract);
  assert.deepEqual(summary.systemIds, REQUIRED_SYSTEM_IDS);
  assert.deepEqual(summary.measurements, REQUIRED_MEASUREMENTS);
  assert.deepEqual(summary.failureClasses, REQUIRED_FAILURE_CLASSES);
});

test('every system pins packages, source identity, runtime, OS, configuration, and exact command', () => {
  for (const system of contract.systems) {
    assert.ok(system.packages.length > 0, system.id);
    assert.ok(system.packages.every(pkg => pkg.version && (pkg.gitSha || pkg.checksum)), system.id);
    assert.deepEqual(system.runtime, { node: '22.22.2', npm: '11.12.1', pi: '0.85.1', bun: '1.3.11' });
    assert.deepEqual(system.os, {
      platform: 'darwin', release: '25.6.0', architecture: 'arm64', version: 'macOS 26.6.2', build: '25G83',
    });
    assert.ok(system.configuration && Object.keys(system.configuration).length > 0, system.id);
    assert.ok(system.command.executable);
    assert.ok(Array.isArray(system.command.argv));
  }
});

test('missing pins, measurement fields, or failure classes fail closed', () => {
  const missingPin = clone(contract);
  delete missingPin.systems[0].packages[0].checksum;
  assert.throws(() => validateMeasurementContract(missingPin), /checksum or gitSha/);

  const wrongVersion = clone(contract);
  wrongVersion.systems[3].packages[1].version = 'latest';
  assert.throws(() => validateMeasurementContract(wrongVersion), /authoritative pins/);

  const wrongRuntime = clone(contract);
  wrongRuntime.systems[0].runtime.node = 'current';
  assert.throws(() => validateMeasurementContract(wrongRuntime), /pinned host baseline/);

  const mismatchedPolicy = clone(contract);
  mismatchedPolicy.systems[4].configuration.modelPolicy = 'different-model';
  assert.throws(() => validateMeasurementContract(mismatchedPolicy), /shared comparison policy/);

  const changedCommand = clone(contract);
  changedCommand.systems[0].command.argv.push('--verbose');
  assert.throws(() => validateMeasurementContract(changedCommand), /exact pinned command/);

  const missingMeasurement = clone(contract);
  missingMeasurement.resultSchema.measurements = missingMeasurement.resultSchema.measurements.filter(
    field => field !== 'cacheWriteTokens',
  );
  assert.throws(() => validateMeasurementContract(missingMeasurement), /cacheWriteTokens/);

  const missingFailure = clone(contract);
  missingFailure.failureTaxonomy = missingFailure.failureTaxonomy.filter(entry => entry.id !== 'grader_failure');
  assert.throws(() => validateMeasurementContract(missingFailure), /grader_failure/);
});

const available = value => ({ status: 'available', value });
const unavailable = reason => ({ status: 'unavailable', reason });
const attempt = (systemId, caseId, outcomeClass = 'success') => ({
  attemptId: `${systemId}:${caseId}:1`,
  systemId,
  caseId,
  attemptNumber: 1,
  startedAt: '2026-09-10T07:00:00.000Z',
  finishedAt: '2026-09-10T07:00:01.000Z',
  outcome: { class: outcomeClass, detail: outcomeClass === 'success' ? 'completed' : 'retained failure' },
  grader: outcomeClass === 'success'
    ? { status: 'available', passed: true, score: 1 }
    : { status: 'unavailable', reason: outcomeClass === 'grader_failure' ? 'grader_failed_before_measurement' : 'not_applicable' },
  measurements: {
    inputTokens: available(10),
    outputTokens: available(5),
    cacheReadTokens: unavailable('provider_not_reported'),
    cacheWriteTokens: unavailable('provider_not_reported'),
    wallTimeMs: available(1000),
    contextBytes: available(2048),
    exitStatus: available(outcomeClass === 'success' ? 0 : 1),
  },
});

test('result accounting retains every attempted failure class in the denominator', () => {
  const outcomes = ['success', 'timeout', 'crash', 'refusal', 'invalid_output', 'grader_failure'];
  const caseIds = outcomes.map((_, index) => `case-${index + 1}`);
  const attempts = contract.systems.flatMap((system, systemIndex) => caseIds.map((caseId, caseIndex) =>
    attempt(system.id, caseId, systemIndex === 0 ? outcomes[caseIndex] : 'success')));
  const bundle = {
    schemaVersion: 1,
    contractId: contract.contractId,
    runId: 'run-fixture-001',
    scheduledCaseIds: caseIds,
    attemptedCount: attempts.length,
    attempts,
    stopped: { value: false, reason: null, unattempted: [] },
  };

  const summary = validateResultBundle(contract, bundle);
  assert.equal(summary.denominator, 30);
  assert.deepEqual(summary.failures, {
    timeout: 1,
    crash: 1,
    refusal: 1,
    invalid_output: 1,
    grader_failure: 1,
  });
  assert.equal(summary.successes, 25);

  const droppedFailure = clone(bundle);
  droppedFailure.attempts = droppedFailure.attempts.filter(record => record.outcome.class !== 'timeout');
  assert.throws(() => validateResultBundle(contract, droppedFailure), /attemptedCount/);
});

test('a stopped run accounts for every scheduled pair without inflating the denominator', () => {
  const scheduledCaseIds = ['case-a', 'case-b'];
  const retained = attempt('bare_pi_0_85_1', 'case-a', 'crash');
  const unattempted = contract.systems.flatMap(system => scheduledCaseIds
    .filter(caseId => system.id !== 'bare_pi_0_85_1' || caseId !== 'case-a')
    .map(caseId => ({ systemId: system.id, caseId, reason: 'operator_interrupt' })));
  const bundle = {
    schemaVersion: 1,
    contractId: contract.contractId,
    runId: 'run-fixture-stopped',
    scheduledCaseIds,
    attemptedCount: 1,
    attempts: [retained],
    stopped: { value: true, reason: 'operator_interrupt', unattempted },
  };

  const summary = validateResultBundle(contract, bundle);
  assert.equal(summary.denominator, 1);
  assert.equal(summary.failures.crash, 1);

  const missingPair = clone(bundle);
  missingPair.stopped.unattempted.pop();
  assert.throws(() => validateResultBundle(contract, missingPair), /failed to account/);
});

test('successful attempts require a retained grader verdict', () => {
  const record = attempt('bare_pi_0_85_1', 'case-a');
  delete record.grader;
  const attempts = contract.systems.map(system => system.id === record.systemId ? record : attempt(system.id, 'case-a'));
  assert.throws(() => validateResultBundle(contract, {
    schemaVersion: 1,
    contractId: contract.contractId,
    runId: 'run-fixture-missing-grader',
    scheduledCaseIds: ['case-a'],
    attemptedCount: attempts.length,
    attempts,
    stopped: { value: false, reason: null, unattempted: [] },
  }), /grader must retain/);
});

test('unavailable measurements require an explicit allowed reason', () => {
  const bundle = {
    schemaVersion: 1,
    contractId: contract.contractId,
    runId: 'run-fixture-002',
    scheduledCaseIds: ['case-a'],
    attemptedCount: contract.systems.length,
    attempts: contract.systems.map(system => attempt(system.id, 'case-a')),
    stopped: { value: false, reason: null, unattempted: [] },
  };
  delete bundle.attempts[0].measurements.cacheReadTokens.reason;
  assert.throws(() => validateResultBundle(contract, bundle), /unavailable reason/);
});
