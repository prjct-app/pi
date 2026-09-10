import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

export type NativeMutationAuthority = Readonly<{
  managed: boolean;
  checkoutId?: string;
  boundCheckoutId?: string;
  taskId?: string;
  taskCheckoutId?: string;
  taskAttemptId?: string | null;
  taskAccess?: 'read' | 'write';
  taskStanding?: 'none' | 'valid' | 'uncertain' | 'released' | 'revoked';
  taskGrantAttemptId?: string;
  taskGrantStanding?: 'valid' | 'uncertain' | 'released' | 'revoked';
  writerCheckoutId?: string;
  writerAttemptId?: string;
  writerStanding?: 'valid' | 'uncertain' | 'released' | 'revoked';
  currentAttemptId: string;
  candidateCount: number;
}>;

export type NativeMutationDecision = Readonly<{
  allowed: boolean;
  managed: boolean;
  code?: string;
  reason?: string;
  taskId?: string;
}>;

const deny = (code: string, reason: string): NativeMutationDecision => ({ allowed: false, managed: true, code, reason });

// This authorizes only Pi-mediated native mutations. It is deliberately not a
// filesystem sandbox and says nothing about child processes or external tools.
export const authorizeNativeMutation = (authority: NativeMutationAuthority): NativeMutationDecision => {
  if (!authority.managed) return { allowed: true, managed: false };
  if (!authority.checkoutId || authority.checkoutId !== authority.boundCheckoutId) {
    return deny('CHECKOUT_MISMATCH', 'The selected work belongs to a different checkout. Re-select it from this checkout.');
  }
  if (authority.candidateCount !== 1 || !authority.taskId) {
    return deny('TASK_GRANT_REQUIRED', 'Exactly one current write task must be claimed before editing files.');
  }
  if (authority.taskCheckoutId !== authority.checkoutId || authority.writerCheckoutId !== authority.checkoutId) {
    return deny('CHECKOUT_MISMATCH', 'The task or writer grant belongs to a different checkout.');
  }
  if (authority.taskAccess !== 'write') return deny('WRITE_GRANT_REQUIRED', 'The current task is read-only. Claim write access first.');
  if (authority.taskStanding !== 'valid' || authority.taskGrantStanding !== 'valid' || authority.writerStanding !== 'valid') {
    return deny('RECONCILE_REQUIRED', 'Mutation authority is missing, stale, or uncertain; reconcile and claim it again.');
  }
  if (authority.taskAttemptId !== authority.currentAttemptId
    || authority.taskGrantAttemptId !== authority.currentAttemptId
    || authority.writerAttemptId !== authority.currentAttemptId) {
    return deny('ATTEMPT_MISMATCH', 'Mutation authority belongs to another attempt; resume does not transfer it.');
  }
  return { allowed: true, managed: true, taskId: authority.taskId };
};

const isInside = (root: string, target: string): boolean => {
  const path = relative(root, target);
  return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
};

// Resolve through the nearest existing ancestor so an uncreated path cannot
// escape through a symlinked parent. Existing symlink targets are rejected even
// when they happen to point back inside the checkout: mutation identity must be
// expressed by the real checkout path, not an alias.
export const canonicalMutationPath = async (checkoutRoot: string, requestedPath: string): Promise<string> => {
  if (!requestedPath.trim()) throw Object.assign(new Error('Mutation path is empty.'), { code: 'PROHIBITED_PATH' });
  const root = await realpath(checkoutRoot);
  const requested = resolve(root, requestedPath);
  if (!isInside(root, requested)) throw Object.assign(new Error('Mutation path escapes the active checkout.'), { code: 'PROHIBITED_PATH' });

  try {
    const info = await lstat(requested);
    if (info.isSymbolicLink()) throw Object.assign(new Error('Mutation targets cannot be symbolic links.'), { code: 'UNSAFE_SYMLINK' });
    const canonical = await realpath(requested);
    if (!isInside(root, canonical)) throw Object.assign(new Error('Mutation path escapes the active checkout.'), { code: 'PROHIBITED_PATH' });
    return canonical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const tail: string[] = [];
  let ancestor = requested;
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      tail.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
  const canonical = resolve(ancestor, ...tail);
  if (!isInside(root, canonical)) throw Object.assign(new Error('Mutation path escapes the active checkout through a symbolic link.'), { code: 'PROHIBITED_PATH' });
  return canonical;
};
