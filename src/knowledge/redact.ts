// Conservative secret redaction for retained evidence. Applied before any tool
// output or user input is persisted. The goal is to keep the diagnostic signal
// while never storing credential material. Known limitations: high-entropy
// strings without a recognizable shape are not detectable.

const PATTERNS: Array<[RegExp, (m: string, ...groups: string[]) => string]> = [
  // Environment-style assignments: KEY=value where KEY names a secret.
  [/\b[A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE|CERT)[A-Z0-9_]*=(\S+)/g, (m: string) => `${m.split('=')[0]}=<REDACTED>`],
  // Well-known token shapes.
  [/\b(?:sk|pk|xox[bapors]?|ghp|gho|ghu|ghs|ghr|github_pat|glpat|sk-ant|sk-proj|AIza|ya29|AKIA|ASIA|dop_v1|npm_[A-Za-z0-9])[A-Za-z0-9_\-]{8,}\b/g, () => '<REDACTED>'],
  // Bearer / Basic auth material.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9_\-.~+/=]{8,}/g, (_m, scheme: string) => `${scheme} <REDACTED>`],
  // PEM blocks.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, () => '<REDACTED PRIVATE KEY>'],
  // JSON fields that name secrets.
  [/("(?:api_?key|access_?token|refresh_?token|id_?token|secret|password|private_?key|client_?secret)"\s*:\s*")[^"]+(")/gi, (_m, pre: string, post: string) => `${pre}<REDACTED>${post}`],
  // Credentials embedded in URLs.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, (_m, scheme: string) => `${scheme}<REDACTED>@`],
];

export const redactSecrets = (text: string): string => {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
};

export const containsSecretShape = (text: string): boolean => redactSecrets(text) !== text;
