# Measurement contract

Use `qa/measurement-contract.json` as the sole comparison and accounting contract for S0 benchmark work. Validate it before preparing fixtures or starting a run:

```sh
npm run qa:measurement-contract
```

## Execution invariants

1. Execute systems and case IDs in the contract order. Use each system's exact `command.executable` and `command.argv`; do not route through a shell.
2. Create and persist an attempt record before spawning Pi. One system/case pair permits exactly one attempt; do not retry failures.
3. Finalize every started record as exactly one of `success`, `timeout`, `crash`, `refusal`, `invalid_output`, or `grader_failure`.
4. Record the hidden grader pass verdict and finite score for each valid completed attempt; otherwise record why the grader result is unavailable.
5. Record every required measurement as `{ "status": "available", "value": number }` or `{ "status": "unavailable", "reason": declaredReason }`. Omission, `null`, and implicit zero are invalid.
6. On a run-level stop, finalize the current attempt and enumerate every scheduled but unattempted system/case pair with a reason.
7. Include every attempted pair in outcome denominators. Never impute unavailable continuous measurements; report used and excluded pair counts by reason.

## Result bundle shape

```json
{
  "schemaVersion": 1,
  "contractId": "prjct-s0-measurement-v1",
  "runId": "run-<nonce>",
  "scheduledCaseIds": ["case-id"],
  "attemptedCount": 5,
  "attempts": [
    {
      "attemptId": "run-<nonce>:bare_pi_0_85_1:case-id:1",
      "systemId": "bare_pi_0_85_1",
      "caseId": "case-id",
      "attemptNumber": 1,
      "startedAt": "RFC3339 timestamp",
      "finishedAt": "RFC3339 timestamp",
      "outcome": { "class": "success", "detail": "completed" },
      "grader": { "status": "available", "passed": true, "score": 1 },
      "measurements": {
        "inputTokens": { "status": "available", "value": 10 },
        "outputTokens": { "status": "available", "value": 5 },
        "cacheReadTokens": { "status": "unavailable", "reason": "provider_not_reported" },
        "cacheWriteTokens": { "status": "unavailable", "reason": "provider_not_reported" },
        "wallTimeMs": { "status": "available", "value": 1000 },
        "contextBytes": { "status": "available", "value": 2048 },
        "exitStatus": { "status": "available", "value": 0 }
      }
    }
  ],
  "stopped": { "value": false, "reason": null, "unattempted": [] }
}
```

Call `validateResultBundle` from `qa/measurement-contract.mjs` before accepting or aggregating a retained bundle.
