import assert from 'node:assert/strict';
import test from 'node:test';
import { LexicalBuilder, buildLexicalIndex, reviveLexicalIndex, scoreLexical, tokenizeFile } from '../src/representation/lexical.ts';

test('tokenizeFile splits camelCase exports and path segments', () => {
  const tokens = tokenizeFile('export function getUserById() { return 1 }\n', 'src/users/user-service.ts');
  assert.equal(tokens.includes('user'), true);
  assert.equal(tokens.includes('get'), true);
  assert.equal(tokens.includes('id'), true);
  assert.equal(tokens.includes('service'), true);
});

test('BM25 ranks the file that declares the queried symbol first', () => {
  const index = buildLexicalIndex([
    { path: 'src/auth.ts', content: 'export function login() { return true }\n' },
    { path: 'src/users.ts', content: 'export function getUserById(id: string) { return id }\n' },
  ]);
  const ranked = scoreLexical('getUserById', index);
  assert.equal(ranked[0]?.path, 'src/users.ts');
  assert.equal(ranked.some(item => item.path === 'src/auth.ts' && item.score > ranked[0]!.score), false);
});

test('the compact index interns paths, survives a JSON round trip, and updates incrementally without renumbering', () => {
  const files = [
    { path: 'src/auth.ts', content: 'export function login() { return true }\n' },
    { path: 'src/users.ts', content: 'export function getUserById(id: string) { return id }\n' },
    { path: 'src/orders.ts', content: 'export function listOrders() { return [] }\n' },
  ];
  const full = buildLexicalIndex(files);
  assert.equal(full.v, 2);
  assert.deepEqual(full.paths, files.map(file => file.path));
  assert.equal(full.totalDocs, 3);
  for (const list of Object.values(full.postings)) assert.equal(list.length % 2, 0);
  const revived = reviveLexicalIndex(JSON.parse(JSON.stringify(full)));
  assert.deepEqual(scoreLexical('getUserById', revived), scoreLexical('getUserById', full));
  assert.throws(() => reviveLexicalIndex({ documents: {}, invertedIndex: {} } as never), { code: 'UNSUPPORTED_SCHEMA' });

  // Incremental: modify users.ts, delete auth.ts, add payments.ts. Survivors keep their docIds.
  const builder = new LexicalBuilder(full);
  builder.remove('src/auth.ts');
  builder.add('src/users.ts', 'export function findUserByEmail(email: string) { return email }\n');
  builder.add('src/payments.ts', 'export function chargeCard() { return 1 }\n');
  const updated = builder.finish();
  assert.equal(updated.paths[0], '', 'deleted document leaves a tombstone');
  assert.equal(updated.paths[2], 'src/orders.ts', 'survivor keeps its id');
  assert.equal(updated.totalDocs, 3);
  const fresh = buildLexicalIndex([
    { path: 'src/users.ts', content: 'export function findUserByEmail(email: string) { return email }\n' },
    files[2]!,
    { path: 'src/payments.ts', content: 'export function chargeCard() { return 1 }\n' },
  ]);
  for (const query of ['findUserByEmail', 'chargeCard', 'listOrders', 'login', 'getUserById']) {
    const a = scoreLexical(query, updated).map(hit => [hit.path, hit.score.toFixed(9)]);
    const b = scoreLexical(query, fresh).map(hit => [hit.path, hit.score.toFixed(9)]);
    assert.deepEqual(a, b, query);
  }
});
