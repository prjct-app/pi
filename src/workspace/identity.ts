import { spawnSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { resolve, dirname, basename, join, relative, isAbsolute } from 'node:path';

export type IdentityRequest = Readonly<{ location: string; agentHome: string }>;
export type IdentityResolution = Readonly<{
  status: 'unmatched' | 'candidate' | 'confirmed' | 'ambiguous' | 'unavailable';
  location: string;
  projectId?: string;
  observations: Readonly<{ exists: boolean; kind?: 'directory' | 'file' | 'symlink' | 'other'; git?: GitObservation }>;
}>;
export type GitObservation = Readonly<{
  workTree: string; commonDir: string; remotes: readonly string[]; isWorktree: boolean;
}>;

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

const git = (cwd: string, args: string[]): string | undefined => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  return result.stdout.trim();
};

const observeGit = (location: string): GitObservation | undefined => {
  const workTree = git(location, ['rev-parse', '--show-toplevel']);
  const commonDir = git(location, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!workTree || !commonDir) return undefined;
  const gitDir = git(location, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const remotes = (git(location, ['remote', '-v']) ?? '').split('\n').flatMap(line => {
    const match = line.match(/\t(\S+)\s/);
    return match?.[1] ? [match[1]] : [];
  });
  return { workTree, commonDir, remotes: [...new Set(remotes)], isWorktree: Boolean(gitDir && gitDir !== commonDir) };
};

// Read-only identity observation. Does not create agent-home stores, bind
// projects, or write into the inspected checkout. Remotes and paths are evidence.
export const resolveIdentity = async (request: IdentityRequest): Promise<IdentityResolution> => {
  let location = resolve(request.location);
  const agentHome = resolve(request.agentHome);
  if (location === agentHome || location.replaceAll('\\', '/').startsWith(`${agentHome.replaceAll('\\', '/')}/`)) {
    fail('PROHIBITED_PATH', 'A store home cannot be resolved as a source checkout.');
  }
  try {
    const stat = await lstat(location);
    const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
    if (kind === 'symlink') fail('UNSAFE_SYMLINK', 'Refusing to follow a source path that is a symlink.');
    if (kind !== 'directory') fail('UNSUPPORTED_LOCATION', 'Source identity requires a directory.');
    location = await realpath(location);
    const canonicalHome = await realpath(agentHome).catch(() => agentHome);
    if (location === canonicalHome || location.replaceAll('\\', '/').startsWith(`${canonicalHome.replaceAll('\\', '/')}/`)) fail('PROHIBITED_PATH', 'Source is inside the agent home.');
    const gitObservation = observeGit(location);
    return { status: 'unmatched', location, observations: gitObservation
      ? { exists: true, kind, git: gitObservation } : { exists: true, kind } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      fail('CHECKOUT_MISSING', 'Source location does not exist.');
    }
    throw error;
  }
};

export type BindRequest = Readonly<{
  location: string; projectId: string; checkoutId: string;
  resolutionStatus: IdentityResolution['status']; expectedRevision: number; confirmation: boolean;
}>;

// Host supplies confirmation. A model cannot mark confirmation true as authority.
export const bindIdentity = (request: BindRequest): { projectId: string; checkoutId: string } => {
  if (request.resolutionStatus === 'ambiguous' && !request.confirmation) {
    fail('IDENTITY_AMBIGUITY', 'Ambiguous identity requires a current user choice.');
  }
  if (request.expectedRevision !== 0 && request.resolutionStatus === 'unmatched') {
    fail('STALE_RESOLUTION', 'Unmatched identity cannot reuse a prior revision.');
  }
  return { projectId: request.projectId, checkoutId: request.checkoutId };
};

export type StoreClass = 'identity' | 'artifacts' | 'knowledge' | 'work' | 'representation';

// Day-grouped project key: "20260908/p_a1b2c3d4e5f6". The day is the creation
// date of the binding (local), stable for the life of the project.
export const projectKeyPattern = /^[0-9]{8}\/p_[A-Za-z0-9_-]+$/;
export const projectKey = (day: string, projectId: string): string => `${day}/${projectId}`;

export const scopeStore = (prjctHome: string, key: string, storeClass: StoreClass): string => {
  if (!projectKeyPattern.test(key)) fail('PROHIBITED_PATH', 'Store scope requires a day-grouped project key.');
  const home = resolve(prjctHome);
  const scoped = resolve(home, key, storeClass);
  if (!scoped.replaceAll('\\', '/').startsWith(`${home.replaceAll('\\', '/')}/`)) fail('PROHIBITED_PATH', 'Store scope escaped the prjct home.');
  return scoped;
};

// Resolve an uncreated store through its nearest existing ancestor without mkdir.
// This also prevents an override/symlink from turning runtime writes into client edits.
export const assertStoreOutsideSource = async (source: string, home: string): Promise<void> => {
  let ancestor = resolve(home); const tail: string[] = [];
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      tail.unshift(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
  const canonicalHome = join(ancestor, ...tail);
  const inside = (parent: string, child: string) => { const path = relative(parent, child); return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`); };
  if (inside(source, canonicalHome) || inside(canonicalHome, source)) fail('PROHIBITED_PATH', 'Runtime store and source checkout must not contain one another.');
};
