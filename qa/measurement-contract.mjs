const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SHA512 = /^sha512:[A-Za-z0-9+/]+={0,2}$/;

export const REQUIRED_SYSTEM_IDS = Object.freeze([
  'bare_pi_0_85_1',
  'legacy_prjct_cli_4_25_1',
  'native_prjct_0_2_0_baseline',
  'gentle_pi_0_14_0_package',
  'gentle_pi_2_5_0_full_runtime',
]);

export const REQUIRED_MEASUREMENTS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'wallTimeMs',
  'contextBytes',
  'exitStatus',
]);

export const REQUIRED_FAILURE_CLASSES = Object.freeze([
  'success',
  'timeout',
  'crash',
  'refusal',
  'invalid_output',
  'grader_failure',
]);

const PINNED_RUNTIME = { node: '22.22.2', npm: '11.12.1', pi: '0.85.1', bun: '1.3.11' };
const PINNED_OS = {
  platform: 'darwin', release: '25.6.0', architecture: 'arm64', version: 'macOS 26.6.2', build: '25G83',
};
const PINNED_PACKAGES = {
  bare_pi_0_85_1: [
    ['@earendil-works/pi-coding-agent', '0.85.1', 'https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.85.1.tgz', 'sha512:FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ=='],
  ],
  legacy_prjct_cli_4_25_1: [
    ['prjct-cli', '4.25.1', '/Users/jj/Apps/prjct/prjct-cli#v4.25.1', '4a0db36713d7af7ae78d123df5a303f1d3d954cd'],
  ],
  native_prjct_0_2_0_baseline: [
    ['@earendil-works/pi-coding-agent', '0.85.1', 'https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.85.1.tgz', 'sha512:FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ=='],
    ['prjct', '0.2.0', '/Users/jj/Apps/prjct/pi', '6926e93e21549b2994a745520b6746d0070fbc1e'],
  ],
  gentle_pi_0_14_0_package: [
    ['@earendil-works/pi-coding-agent', '0.85.1', 'https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.85.1.tgz', 'sha512:FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ=='],
    ['gentle-pi', '0.14.0', 'https://registry.npmjs.org/gentle-pi/-/gentle-pi-0.14.0.tgz', 'sha512:azS1EpfRb3UaM9FR3tyxSzZOYs9BA94+d1Lcbit+Qm5aMvl4R7/rWLzHb6BIYv61H/sfxrFwSQCVGO47vfh88A=='],
  ],
  gentle_pi_2_5_0_full_runtime: [
    ['@earendil-works/pi-coding-agent', '0.85.1', 'https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.85.1.tgz', 'sha512:FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ=='],
    ['gentle-pi', '2.5.0', 'https://registry.npmjs.org/gentle-pi/-/gentle-pi-2.5.0.tgz', 'sha512:DJlSutLl1Nz9REx4BvNdI6iT66TElBlEmuD5qUDlCSpuhU5qhGhvNHlwRxiAkqFNZPLl+FcDQKvM3su89R4eMg=='],
  ],
};

const fail = message => { throw new Error(`Invalid measurement contract: ${message}`); };
const requireString = (value, path) => {
  if (typeof value !== 'string' || value.length === 0) fail(`${path} must be a non-empty string`);
};
const requirePositiveInteger = (value, path) => {
  if (!Number.isInteger(value) || value < 1) fail(`${path} must be a positive integer`);
};
const requireUniqueStrings = (values, path) => {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string') || new Set(values).size !== values.length) {
    fail(`${path} must contain unique strings`);
  }
};
const sameMembers = (actual, required) =>
  actual.length === required.length && required.every(value => actual.includes(value));

const validateReference = (reference, path) => {
  requireString(reference?.id, `${path}.id`);
  requirePositiveInteger(reference?.revision, `${path}.revision`);
  if (typeof reference?.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(reference.contentHash)) {
    fail(`${path}.contentHash must be a 64-character SHA-256`);
  }
};

const validatePackage = (pkg, path) => {
  requireString(pkg?.name, `${path}.name`);
  requireString(pkg?.version, `${path}.version`);
  requireString(pkg?.source, `${path}.source`);
  const checksumValid = typeof pkg?.checksum === 'string' && (SHA256.test(pkg.checksum) || SHA512.test(pkg.checksum));
  const shaValid = typeof pkg?.gitSha === 'string' && SHA40.test(pkg.gitSha);
  if (!checksumValid && !shaValid) fail(`${path} requires a valid checksum or gitSha`);
};

export function validateMeasurementContract(contract) {
  if (!contract || typeof contract !== 'object') fail('document must be an object');
  if (contract.schemaVersion !== 1) fail('schemaVersion must equal 1');
  requireString(contract.contractId, 'contractId');
  validateReference(contract.authority?.specification, 'authority.specification');
  validateReference(contract.authority?.plan, 'authority.plan');
  validateReference(contract.authority?.comparisonIdentities, 'authority.comparisonIdentities');
  requireString(contract.baseGitSha, 'baseGitSha');
  if (!SHA40.test(contract.baseGitSha)) fail('baseGitSha must be a full git SHA');

  if (!Array.isArray(contract.systems)) fail('systems must contain every comparison system');
  const systemIds = contract.systems.map(system => system?.id);
  requireUniqueStrings(systemIds, 'systems[].id');
  if (!sameMembers(systemIds, REQUIRED_SYSTEM_IDS)) {
    const missing = REQUIRED_SYSTEM_IDS.filter(id => !systemIds.includes(id));
    fail(`systems missing authoritative identities: ${missing.join(', ')}`);
  }
  const sharedConfigurationKeys = [
    'isolatedHome', 'network', 'provider', 'modelPolicy', 'caseOrder', 'environmentBudgets', 'optionalCompanionPackages',
  ];
  const sharedConfiguration = contract.systems[0]?.configuration;
  for (const [index, system] of contract.systems.entries()) {
    const path = `systems[${index}]`;
    requireString(system.id, `${path}.id`);
    if (!Array.isArray(system.packages) || system.packages.length === 0) fail(`${path}.packages must not be empty`);
    system.packages.forEach((pkg, packageIndex) => validatePackage(pkg, `${path}.packages[${packageIndex}]`));
    const expectedPackages = PINNED_PACKAGES[system.id];
    const actualPackages = system.packages.map(pkg => [pkg.name, pkg.version, pkg.source, pkg.checksum ?? pkg.gitSha]);
    if (JSON.stringify(actualPackages) !== JSON.stringify(expectedPackages)) fail(`${path}.packages differ from authoritative pins`);
    if (JSON.stringify(system.runtime) !== JSON.stringify(PINNED_RUNTIME)) fail(`${path}.runtime differs from the pinned host baseline`);
    if (JSON.stringify(system.os) !== JSON.stringify(PINNED_OS)) fail(`${path}.os differs from the pinned host baseline`);
    if (!system.configuration || typeof system.configuration !== 'object' || Array.isArray(system.configuration)
      || Object.keys(system.configuration).length === 0) fail(`${path}.configuration must be a non-empty object`);
    for (const key of sharedConfigurationKeys) {
      if (JSON.stringify(system.configuration[key]) !== JSON.stringify(sharedConfiguration?.[key])) {
        fail(`${path}.configuration.${key} must match the shared comparison policy`);
      }
    }
    if (system.command?.executable !== 'node') fail(`${path}.command.executable must be node`);
    const expectedArgv = ['qa/run-paired-benchmark.mjs', '--contract', 'qa/measurement-contract.json', '--system', system.id,
      '--cases', 'qa/fixtures/cases.json', '--output', 'evidence/runs'];
    if (JSON.stringify(system.command?.argv) !== JSON.stringify(expectedArgv)) fail(`${path}.command.argv differs from the exact pinned command`);
  }

  const measurements = contract.resultSchema?.measurements;
  requireUniqueStrings(measurements, 'resultSchema.measurements');
  if (!sameMembers(measurements, REQUIRED_MEASUREMENTS)) {
    const missing = REQUIRED_MEASUREMENTS.filter(field => !measurements.includes(field));
    fail(`resultSchema.measurements missing required fields: ${missing.join(', ')}`);
  }
  if (contract.resultSchema?.availabilityEncoding?.available !== 'available'
    || contract.resultSchema?.availabilityEncoding?.unavailable !== 'unavailable') {
    fail('resultSchema.availabilityEncoding must distinguish available from unavailable values');
  }
  requireUniqueStrings(contract.resultSchema?.unavailableReasons, 'resultSchema.unavailableReasons');
  if (contract.resultSchema.unavailableReasons.length === 0) fail('resultSchema.unavailableReasons must not be empty');

  const failureClasses = contract.failureTaxonomy?.map(entry => entry?.id);
  requireUniqueStrings(failureClasses, 'failureTaxonomy[].id');
  if (!sameMembers(failureClasses, REQUIRED_FAILURE_CLASSES)) {
    const missing = REQUIRED_FAILURE_CLASSES.filter(value => !failureClasses.includes(value));
    fail(`failureTaxonomy missing required classes: ${missing.join(', ')}`);
  }
  for (const [index, entry] of contract.failureTaxonomy.entries()) {
    requireString(entry.definition, `failureTaxonomy[${index}].definition`);
    if (entry.inDenominator !== true) fail(`failureTaxonomy[${index}].inDenominator must be true`);
  }
  if (JSON.stringify(contract.failureClassificationPrecedence) !== JSON.stringify([
    'timeout', 'crash', 'invalid_output', 'grader_failure', 'refusal', 'success',
  ])) fail('failureClassificationPrecedence must be deterministic');
  requireString(contract.resultSchema?.graderVerdict?.rule, 'resultSchema.graderVerdict.rule');

  if (contract.accounting?.denominator !== 'all_attempted_records') fail('accounting.denominator must retain all attempted records');
  if (contract.accounting?.appendBeforeExecution !== true) fail('accounting.appendBeforeExecution must be true');
  if (contract.accounting?.dropFailures !== false) fail('accounting.dropFailures must be false');
  if (contract.accounting?.maxAttemptsPerSystemCase !== 1) fail('accounting.maxAttemptsPerSystemCase must be 1');
  if (contract.stopRules?.retainCurrentAttempt !== true || contract.stopRules?.listEveryUnattemptedPair !== true) {
    fail('stopRules must retain the current attempt and list every unattempted pair');
  }
  requirePositiveInteger(contract.stopRules?.perAttemptTimeoutMs, 'stopRules.perAttemptTimeoutMs');
  requirePositiveInteger(contract.stopRules?.terminationGraceMs, 'stopRules.terminationGraceMs');
  requirePositiveInteger(contract.stopRules?.minimumFreeDiskBytes, 'stopRules.minimumFreeDiskBytes');
  requireUniqueStrings(contract.stopRules?.allowedRunStopReasons, 'stopRules.allowedRunStopReasons');
  if (contract.stopRules.allowedRunStopReasons.length === 0) fail('stopRules.allowedRunStopReasons must not be empty');

  requireUniqueStrings(contract.perRunIdentitySchema?.requiredFields, 'perRunIdentitySchema.requiredFields');
  for (const required of ['contractSha256', 'caseCorpusSha256', 'graderSha256', 'packageArtifactChecksums',
    'installedRuntimeExecutableSha256', 'providerContractSha256', 'configuration', 'exactCommand']) {
    if (!contract.perRunIdentitySchema.requiredFields.includes(required)) fail(`perRunIdentitySchema.requiredFields missing ${required}`);
  }
  requireString(contract.perRunIdentitySchema?.rule, 'perRunIdentitySchema.rule');

  if (contract.statistics?.referenceSystemId !== 'bare_pi_0_85_1') fail('statistics.referenceSystemId must be bare_pi_0_85_1');
  if (!systemIds.includes(contract.statistics.referenceSystemId)) fail('statistics reference system must exist');
  requireString(contract.statistics?.pairingKey, 'statistics.pairingKey');
  if (contract.statistics?.failureOutcomeDenominator !== 'all_attempted_pairs') {
    fail('statistics.failureOutcomeDenominator must include all attempted pairs');
  }
  if (contract.statistics?.unavailableMetricPolicy !== 'no_imputation_report_counts') {
    fail('statistics.unavailableMetricPolicy must prohibit imputation and report counts');
  }

  return { systemIds, measurements: [...measurements], failureClasses: [...failureClasses] };
}

const validateMeasurement = (field, measurement, unavailableReasons, attemptPath) => {
  if (!measurement || typeof measurement !== 'object') fail(`${attemptPath}.measurements.${field} must be explicit`);
  if (measurement.status === 'available') {
    if (typeof measurement.value !== 'number' || !Number.isFinite(measurement.value)) {
      fail(`${attemptPath}.measurements.${field}.value must be finite when available`);
    }
    if (field !== 'exitStatus' && measurement.value < 0) fail(`${attemptPath}.measurements.${field}.value must be non-negative`);
    if (field === 'exitStatus' && !Number.isInteger(measurement.value)) fail(`${attemptPath}.measurements.exitStatus.value must be an integer`);
    if ('reason' in measurement) fail(`${attemptPath}.measurements.${field} cannot include an unavailable reason when available`);
    return;
  }
  if (measurement.status === 'unavailable') {
    if (typeof measurement.reason !== 'string' || !unavailableReasons.includes(measurement.reason)) {
      fail(`${attemptPath}.measurements.${field} requires an explicit allowed unavailable reason`);
    }
    if ('value' in measurement) fail(`${attemptPath}.measurements.${field} cannot include a value when unavailable`);
    return;
  }
  fail(`${attemptPath}.measurements.${field}.status must be available or unavailable`);
};

export function validateResultBundle(contract, bundle) {
  const contractSummary = validateMeasurementContract(contract);
  if (!bundle || typeof bundle !== 'object') fail('result bundle must be an object');
  if (bundle.schemaVersion !== 1) fail('result bundle schemaVersion must equal 1');
  if (bundle.contractId !== contract.contractId) fail('result bundle contractId does not match');
  requireString(bundle.runId, 'resultBundle.runId');
  requireUniqueStrings(bundle.scheduledCaseIds, 'resultBundle.scheduledCaseIds');
  if (bundle.scheduledCaseIds.length === 0) fail('resultBundle.scheduledCaseIds must not be empty');
  if (!Array.isArray(bundle.attempts)) fail('resultBundle.attempts must be an array');
  if (bundle.attemptedCount !== bundle.attempts.length) fail('resultBundle.attemptedCount must equal retained attempt records');

  const failureSet = new Set(contractSummary.failureClasses);
  const caseSet = new Set(bundle.scheduledCaseIds);
  const systemSet = new Set(contractSummary.systemIds);
  const attemptIds = new Set();
  const pairKeys = new Set();
  const failures = Object.fromEntries(REQUIRED_FAILURE_CLASSES.filter(value => value !== 'success').map(value => [value, 0]));
  let successes = 0;

  for (const [index, record] of bundle.attempts.entries()) {
    const path = `resultBundle.attempts[${index}]`;
    requireString(record?.attemptId, `${path}.attemptId`);
    if (attemptIds.has(record.attemptId)) fail(`${path}.attemptId must be unique`);
    attemptIds.add(record.attemptId);
    if (!systemSet.has(record.systemId)) fail(`${path}.systemId is not in the comparison matrix`);
    if (!caseSet.has(record.caseId)) fail(`${path}.caseId is not scheduled`);
    if (record.attemptNumber !== 1) fail(`${path}.attemptNumber must be 1; hidden retries are forbidden`);
    const pairKey = `${record.systemId}\u0000${record.caseId}`;
    if (pairKeys.has(pairKey)) fail(`${path} duplicates a system/case pair`);
    pairKeys.add(pairKey);
    requireString(record.startedAt, `${path}.startedAt`);
    requireString(record.finishedAt, `${path}.finishedAt`);
    if (!failureSet.has(record.outcome?.class)) fail(`${path}.outcome.class is not declared`);
    requireString(record.outcome?.detail, `${path}.outcome.detail`);
    if (record.outcome.class === 'success') {
      successes += 1;
      if (record.grader?.status !== 'available' || typeof record.grader.passed !== 'boolean'
        || typeof record.grader.score !== 'number' || !Number.isFinite(record.grader.score)) {
        fail(`${path}.grader must retain a finite score and boolean pass verdict for a successful attempt`);
      }
    } else {
      failures[record.outcome.class] += 1;
      if (record.grader?.status !== 'unavailable'
        || !contract.resultSchema.unavailableReasons.includes(record.grader.reason)) {
        fail(`${path}.grader must record an explicit unavailable reason for a failed attempt`);
      }
    }

    const measurementKeys = Object.keys(record.measurements ?? {});
    if (!sameMembers(measurementKeys, REQUIRED_MEASUREMENTS)) fail(`${path}.measurements must contain every required field exactly once`);
    for (const field of REQUIRED_MEASUREMENTS) {
      validateMeasurement(field, record.measurements[field], contract.resultSchema.unavailableReasons, path);
    }
  }

  if (typeof bundle.stopped?.value !== 'boolean' || !Array.isArray(bundle.stopped?.unattempted)) {
    fail('resultBundle.stopped must explicitly report value, reason, and unattempted pairs');
  }
  const expectedPairs = contractSummary.systemIds.flatMap(systemId =>
    bundle.scheduledCaseIds.map(caseId => `${systemId}\u0000${caseId}`));
  if (!bundle.stopped.value) {
    if (bundle.stopped.reason !== null || bundle.stopped.unattempted.length !== 0) {
      fail('an unstopped run cannot report a stop reason or unattempted pairs');
    }
    const missing = expectedPairs.filter(pair => !pairKeys.has(pair));
    if (missing.length > 0) fail(`unstopped result bundle omitted ${missing.length} scheduled system/case pairs`);
  } else {
    requireString(bundle.stopped.reason, 'resultBundle.stopped.reason');
    if (!contract.stopRules.allowedRunStopReasons.includes(bundle.stopped.reason)) {
      fail('resultBundle.stopped.reason is not declared by the contract');
    }
    const unattempted = new Set();
    for (const [index, pair] of bundle.stopped.unattempted.entries()) {
      if (!systemSet.has(pair?.systemId) || !caseSet.has(pair?.caseId)) fail(`resultBundle.stopped.unattempted[${index}] is not scheduled`);
      requireString(pair.reason, `resultBundle.stopped.unattempted[${index}].reason`);
      if (!contract.stopRules.allowedRunStopReasons.includes(pair.reason)) {
        fail(`resultBundle.stopped.unattempted[${index}].reason is not declared by the contract`);
      }
      const key = `${pair.systemId}\u0000${pair.caseId}`;
      if (unattempted.has(key) || pairKeys.has(key)) fail(`resultBundle.stopped.unattempted[${index}] duplicates an accounted pair`);
      unattempted.add(key);
    }
    const missing = expectedPairs.filter(pair => !pairKeys.has(pair) && !unattempted.has(pair));
    if (missing.length > 0) fail(`stopped result bundle failed to account for ${missing.length} scheduled pairs`);
  }

  return { denominator: bundle.attempts.length, successes, failures };
}
