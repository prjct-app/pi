import { createHash, randomBytes } from 'node:crypto';

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
export const newId = (prefix: string): string => `${prefix}_${randomBytes(4).toString('hex')}`;
export const contentRef = (id: string, revision: number, payload: unknown) => ({
  id, revision, contentHash: sha256(JSON.stringify(payload)),
});
