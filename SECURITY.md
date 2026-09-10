# Security and authority boundaries

prjct coordinates process authority inside Pi. It is not an operating-system sandbox.

## Enforced boundaries

When an open prjct work item is selected, Pi-mediated `edit` and `write` calls are blocked unless exactly one task has current write authority. The task grant, writer grant, attempt, checkout, and canonical target path must all agree. Paths outside the bound checkout and paths that escape through symbolic links are rejected. Process tools execute sequentially relative to sibling tool calls, and completed native mutations are revalidated before becoming evidence.

Write claims, plan adoption, reconciliation, method decisions, and exports that require human authority use the current host confirmation UI. Print and JSON modes fail closed because they cannot obtain that confirmation. Conversational text is evidence, not reusable permission.

Lifecycle changes invalidate authority conservatively. Graceful shutdown, compaction, and tree navigation mark grants uncertain. Resume, new-session, reload, and fork create a new attempt. Session entries retain only branch-local context pointers; they never mint or restore grants.

Process records use revision checks, atomic publication, immutable history, and serialized owner-aware stale-lock recovery. A stranded recovery marker fails closed and requires explicit operator recovery rather than risking removal of a new owner's lock. Identical orphaned immutable bodies can be reused after interrupted metadata publication; conflicting bytes are preserved for explicit recovery. Operation receipts make prjct state mutations replayable; they never authorize automatic replay of native filesystem or shell effects.

## Explicitly outside the boundary

A native-tool preflight is a point-in-time authorization check. It does not make filesystem effects and the external process-state store one atomic transaction; another process can change authority after preflight, and a later Pi extension handler can alter mutable tool input. Post-execution revalidation prevents state races from becoming successful evidence, but cannot undo a write that already occurred. This is Pi-mediated interception, not a transactional filesystem authority boundary.

The extension does not isolate:

- arbitrary shell commands or their child/background processes;
- network access;
- commands launched outside Pi;
- direct actions performed by the human through `!`/`!!`;
- filesystem changes outside the indexable source corpus;
- file modes, device nodes, binary contents, or all symbolic-link effects.

Bash observations therefore carry partial coverage. Verification pairs additionally pin indexed test/config substrate, but matching command identities and ordered RED/GREEN results still establish neither causality, unindexed environment equality, nor flake safety.

For stronger isolation, run Pi inside a container, VM, or OS sandbox with an explicit filesystem and network policy. prjct's gates should be treated as process controls layered inside that boundary.
