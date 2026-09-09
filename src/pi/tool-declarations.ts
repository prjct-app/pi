import { ArtifactParameters } from '../knowledge/artifact-contract.ts';
import { KnowledgeParameters } from '../knowledge/claim-contract.ts';
import { SearchParameters } from '../knowledge/search-contract.ts';
import { RefreshParameters } from '../representation/refresh-contract.ts';
import { StructureParameters } from '../representation/structure-contract.ts';
import { CheckpointParameters } from '../work/checkpoint-contract.ts';
import { PlanParameters } from '../work/plan-contract.ts';
import { ReconcileParameters } from '../work/reconcile-contract.ts';
import { TaskParameters } from '../work/task-contract.ts';
import { WorkParameters } from '../work/work-contract.ts';
import { ContextToolContract } from './context-tool-contract.ts';

// Native declaration data only. No dispatch, validation loop, registration,
// automatic activation, source scan, model call or filesystem effect occurs here.
// Working process owners provide execute when integration is implemented.
export const processToolDeclarations = [
  ContextToolContract,
  { name: 'prjct_search', label: 'Find applicable references', parameters: SearchParameters,
    description: 'Find bounded source, claim and artifact references for an explicit query. Never refreshes implicitly.' },
  { name: 'prjct_structure', label: 'Inspect relationships', parameters: StructureParameters,
    description: 'Inspect supported relationships or advisory impact with explicit coverage limits. Never scans implicitly.' },
  { name: 'prjct_refresh', label: 'Refresh source representation', parameters: RefreshParameters,
    description: 'Inspect changes read-only or explicitly apply mechanical refresh. Index freshness is not semantic understanding.' },
  { name: 'prjct_work', label: 'Maintain work', parameters: WorkParameters,
    description: 'Maintain an objective, originating request references and deliberate work selection. Does not execute work.' },
  { name: 'prjct_plan', label: 'Maintain scope and plan', parameters: PlanParameters,
    description: 'Draft, inspect or request adoption of exact spec/plan revisions. Does not execute a plan or grant approval.' },
  { name: 'prjct_task', label: 'Maintain task discipline', parameters: TaskParameters,
    description: 'Maintain stable tasks, explicit relationships, claims and evidence-bound transitions. Does not start agents.' },
  { name: 'prjct_checkpoint', label: 'Preserve process progress', parameters: CheckpointParameters,
    description: 'Record scoped method progress or a reuse assessment. Reports do not become native evidence or completion.' },
  { name: 'prjct_reconcile', label: 'Reconcile interrupted work', parameters: ReconcileParameters,
    description: 'Inspect interruption or request deliberate continuation. Never treats absence as consent or replays effects.' },
  { name: 'prjct_knowledge', label: 'Maintain project understanding', parameters: KnowledgeParameters,
    description: 'Propose, inspect and resolve attributable knowledge claims. Link supports to source ids from prjct_search so claims surface next to the files they describe. replan records a pivot and flags stale claims; consolidate is deterministic maintenance. The agent reasons; prjct retains support and uncertainty.' },
  { name: 'prjct_artifact', label: 'Maintain internal artifacts', parameters: ArtifactParameters,
    description: 'Stage, publish and inspect internal artifact revisions or prepare export intent. Never writes client or tracker destinations.' },
] as const;
