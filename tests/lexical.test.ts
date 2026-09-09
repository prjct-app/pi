import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLexicalIndex, scoreLexical, tokenizeFile } from '../src/representation/lexical.ts';

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
