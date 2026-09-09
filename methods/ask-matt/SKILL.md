---
name: ask-matt
description: Ask which installed planning skill or workflow fits the current situation. A router over the Pi-adapted AI Hero skills.
disable-model-invocation: true
---

# Ask Matt — Pi Planning Router

Recommend a route through the installed skills. In Pi, user-invoked skills use `/skill:<name>`. When one skill needs another in the same session, load the sibling `SKILL.md` with `read`; do not look for a separate Skill tool.

Only recommend skills from this curated profile (the sibling folders next to this file).

## Before the first repository workflow

Run `/skill:setup-matt-pocock-skills` once per repository. It configures the issue tracker and domain-document layout used by the planning skills.

## Routes

### Feature or change that fits one planning session

1. `/skill:grill-with-docs` to resolve the design tree and capture domain terms or durable decisions.
2. `/skill:research` when a decision depends on external facts or primary documentation.
3. `/skill:prototype` when a runnable artifact is needed to answer a behavior, state-model, or UI question.
4. `/skill:to-spec` to synthesize the settled conversation into a specification.
5. `/skill:to-tickets` when the work needs multiple tracer-bullet implementation slices.

If there is no repository or no documentation should be written, use `/skill:grilling` instead of `grill-with-docs`.

### Large, foggy, multi-session initiative

Start with `/skill:wayfinder`. It creates a map of decision tickets and resolves the visible frontier without pretending the entire route is known. When the map is clear, continue with `/skill:to-spec` and `/skill:to-tickets`.

Do not use `wayfinder` for a well-scoped feature that fits one session.

### Architecture planning

- `/skill:improve-codebase-architecture`: survey a codebase and identify deepening opportunities.
- `/skill:codebase-design`: design a module's interface, seam, adapters, depth, leverage, and locality.
- `/skill:domain-modeling`: sharpen project terminology or record an ADR-worthy decision.

### Missing stakeholder knowledge

Use `/skill:to-questionnaire` when the required facts or decisions live with another person.

### Bugs and regressions

Use `/skill:diagnosing-bugs`. If the diagnosis exposes a poor seam, follow with `/skill:improve-codebase-architecture` or `/skill:codebase-design`.

### Implementation and review handoff

This profile does not install the upstream `implement` orchestrator. For direct test-first implementation use `/skill:tdd`; finish with `/skill:code-review`. For work larger than one session, stop planning at `/skill:to-tickets` and start each ticket in a fresh session.

### Context boundaries

Use `/skill:handoff` only when work must move to another session, directory, harness, or person. Otherwise continue in the current context or use Pi's `/compact` at a phase boundary.

See [PHASE-BOUNDARIES.md](PHASE-BOUNDARIES.md) for the decision tree.
