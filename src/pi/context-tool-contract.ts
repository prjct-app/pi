import { ContextParameters } from './context-contract.ts';

// Definition fragment only. A working owner must provide execute; this does not
// register a tool, load context, or replace native Pi execution.
export const ContextToolContract = {
  name: 'prjct_context',
  label: 'Project context',
  description: 'Call this BEFORE answering about prior work, project purpose, findings, or next actions in this directory — retained context lives here. Also serves on-demand method guidance (query methods / method:<id> / method:<id>/<doc>) and prjct capability discovery.',
  parameters: ContextParameters,
};
