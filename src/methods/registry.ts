import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// On-demand delivery of the Matt Pocock methodology. The full documents ship
// inside this package (methods/, MIT licensed, see methods/LICENSE-MattPocock.txt
// and methods/AIHERO-PI-NOTES.md) and are served only when the agent asks.
// Nothing from this registry is injected into the prompt at startup.

export type MethodId =
  | 'ask-matt' | 'setup-matt-pocock-skills' | 'grilling' | 'grill-with-docs' | 'wayfinder'
  | 'domain-modeling' | 'codebase-design' | 'improve-codebase-architecture'
  | 'research' | 'prototype' | 'to-spec' | 'to-tickets' | 'to-questionnaire'
  | 'tdd' | 'diagnosing-bugs' | 'code-review' | 'handoff';

export type MethodEntry = Readonly<{
  id: MethodId;
  summary: string;
  /** Keywords that make a lookup query resolve to this method. */
  triggers: readonly string[];
  /** Entry document; linked documents are served on request. */
  entry: string;
}>;

export const METHODS: readonly MethodEntry[] = [
  { id: 'ask-matt', summary: 'Route a request to the right method; phase-boundary decisions (continue/clear/handoff/parallel/compact).', triggers: ['ask-matt', 'which method', 'route', 'phase boundary', 'compact or continue'], entry: 'ask-matt/SKILL.md' },
  { id: 'setup-matt-pocock-skills', summary: 'Per-repo configuration: tracker, triage labels, domain doc layout.', triggers: ['setup', 'onboarding', 'tracker config', 'triage labels'], entry: 'setup-matt-pocock-skills/SKILL.md' },
  { id: 'grilling', summary: 'Relentless frontier-based interview until shared understanding.', triggers: ['grill', 'interview', 'stress-test', 'decision tree'], entry: 'grilling/SKILL.md' },
  { id: 'grill-with-docs', summary: 'Grilling + inline glossary/ADR capture.', triggers: ['grill-with-docs', 'documented discovery'], entry: 'grill-with-docs/SKILL.md' },
  { id: 'wayfinder', summary: 'Multi-session map of decision tickets: destination, frontier, fog of war.', triggers: ['wayfinder', 'fog', 'multi-session', 'big initiative', 'decision tickets'], entry: 'wayfinder/SKILL.md' },
  { id: 'domain-modeling', summary: 'Sharpen terminology; CONTEXT.md glossary and ADR discipline.', triggers: ['domain', 'glossary', 'terminology', 'context.md', 'adr'], entry: 'domain-modeling/SKILL.md' },
  { id: 'codebase-design', summary: 'Deep modules: interface, depth, seam, adapter, leverage, locality; design-it-twice.', triggers: ['codebase-design', 'deep module', 'seam', 'depth', 'interface design'], entry: 'codebase-design/SKILL.md' },
  { id: 'improve-codebase-architecture', summary: 'Find deepening opportunities; visual report; then grill the chosen candidate.', triggers: ['improve architecture', 'deepening', 'architecture review'], entry: 'improve-codebase-architecture/SKILL.md' },
  { id: 'research', summary: 'Primary-source investigation captured as an attributed report.', triggers: ['research', 'primary sources', 'investigate topic'], entry: 'research/SKILL.md' },
  { id: 'prototype', summary: 'Throwaway logic/UI prototype that answers one design question.', triggers: ['prototype', 'throwaway', 'state model demo', 'ui variants'], entry: 'prototype/SKILL.md' },
  { id: 'to-spec', summary: 'Synthesize the settled conversation into a specification.', triggers: ['to-spec', 'spec', 'specification', 'user stories'], entry: 'to-spec/SKILL.md' },
  { id: 'to-tickets', summary: 'Tracer-bullet vertical slices with blocking edges.', triggers: ['to-tickets', 'tickets', 'vertical slices', 'tracer bullet'], entry: 'to-tickets/SKILL.md' },
  { id: 'to-questionnaire', summary: 'Questionnaire for knowledge someone else holds.', triggers: ['questionnaire', 'stakeholder', 'ask someone'], entry: 'to-questionnaire/SKILL.md' },
  { id: 'tdd', summary: 'Red-green loop; seams, good tests, mocking discipline.', triggers: ['tdd', 'test-driven', 'red green', 'test first'], entry: 'tdd/SKILL.md' },
  { id: 'diagnosing-bugs', summary: 'Feedback-loop-first diagnosis for hard bugs and regressions.', triggers: ['diagnose', 'debug', 'bug', 'regression', 'broken'], entry: 'diagnosing-bugs/SKILL.md' },
  { id: 'code-review', summary: 'Two independent axes: repository standards and originating spec.', triggers: ['code-review', 'review', 'standards pass', 'spec pass'], entry: 'code-review/SKILL.md' },
  { id: 'handoff', summary: 'Portable handoff document for another session or person.', triggers: ['handoff', 'hand over', 'transfer session'], entry: 'handoff/SKILL.md' },
];

const methodsRoot = join(dirname(fileURLToPath(import.meta.url)), '../../methods');

const STAGE_VOCAB: Record<string, string> = {
  tdd: 'seam_pending → seam_confirmed (user evidence) → test_authored → red_observed (failing verification) → green_pending → green_observed (passing verification) → review_pending',
  'diagnosing-bugs': 'symptom_recorded → loop_built → reproduced (failed command evidence) → minimized → hypotheses_ranked → instrumented → fixed (succeeding command evidence) → cleaned_up',
  research: 'question_recorded → sources_gathered → synthesized → complete (native observations)',
  'code-review': 'scope_pinned → standards_pass → spec_pass → reported (never a single pass)',
  grilling: 'tree_mapped → round_asked → decision_recorded (user-input evidence) → settled',
  handoff: 'context_gathered → artifact_staged → ready (published handoff artifact)',
  'to-spec': 'synthesized → seams_confirmed (user-input evidence) → adopted',
};

export const stageVocabulary = (id: string): string | undefined => STAGE_VOCAB[id];

const DELIVERY_NOTE = [
  '---',
  'Delivered by prjct on demand (method not loaded as a Pi skill).',
  '- Where this document says `/skill:<name>`, request method `<name>` from prjct_context instead.',
  '- Where it says to read a sibling document, request `method:<id>/<file>` from prjct_context.',
  '- Repository writes, tracker publication, and branch operations require explicit user authorization.',
  '---',
  '',
].join('\n');

export const matchMethods = (query: string): MethodEntry[] => {
  const q = query.toLowerCase();
  return METHODS.filter(m => m.id === q.replace(/^method:/, '').split('/')[0]
    || m.triggers.some(trigger => q.includes(trigger)));
};

export const methodCatalog = (): Array<{ id: string; summary: string }> =>
  METHODS.map(m => ({ id: m.id, summary: m.summary }));

export const loadMethodDocument = async (id: MethodId, document?: string): Promise<{ path: string; content: string } | undefined> => {
  const entry = METHODS.find(m => m.id === id);
  if (!entry) return undefined;
  const rel = document ?? entry.entry;
  // Confine to the bundled methods tree.
  const path = join(methodsRoot, id, rel.includes('/') ? rel.split('/').slice(1).join('/') : rel);
  if (!path.startsWith(join(methodsRoot, id))) return undefined;
  try {
    const content = await readFile(path, 'utf8');
    const stages = stageVocabulary(id);
    const stageNote = stages ? `Record progress via prjct_checkpoint kind=progress methodId=${id}; stages: ${stages}. Stages cannot be skipped; evidence gates are enforced.\n---\n\n` : '';
    return { path: rel, content: DELIVERY_NOTE + stageNote + content };
  } catch {
    return undefined;
  }
};

export const listMethodDocuments = async (id: MethodId): Promise<string[]> => {
  const dir = join(methodsRoot, id);
  const out: string[] = [];
  const walk = async (d: string, prefix = '') => {
    for (const item of await readdir(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(join(d, item.name), rel);
      else out.push(rel);
    }
  };
  await walk(dir);
  return out.sort();
};
