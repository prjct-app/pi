import { realpathSync } from 'node:fs';
import { tmpdir as systemTmpdir } from 'node:os';
// Match production canonical identity, including macOS /var -> /private/var.
export const tmpdir = (): string => realpathSync(systemTmpdir());
