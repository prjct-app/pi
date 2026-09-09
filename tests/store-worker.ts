import { publishRecord } from '../src/workspace/store.ts';

const path = process.argv[2];
if (!path) throw new Error('store worker requires a path');
const payload = process.argv[3] ?? 'a';
try {
  const published = await publishRecord(path, { expectedRevision: 0, payload });
  process.stdout.write(JSON.stringify({ ok: true, published }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: (error as { code?: string }).code }));
  process.exitCode = 1;
}
