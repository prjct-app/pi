// One canonical QA entry point. The historical summary-only QA is preserved in
// the pre-repair backup; it no longer drifts from the adversarial acceptance run.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.argv[2] ??= await mkdtemp(join(tmpdir(), 'prjct-qa-evidence-'));
await import('./adversarial-audit.mjs');
