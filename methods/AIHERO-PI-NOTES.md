# AI Hero skills — Pi compatibility notes

Installed from `mattpocock/skills` at upstream commit `3cca18b368ae95cdbdebbff572ccafa662551015`.

## Installed profile

This is a curated planning profile:

- Planning orchestration: `ask-matt`, `setup-matt-pocock-skills`, `grill-with-docs`, `grilling`, `wayfinder`
- Design and discovery: `domain-modeling`, `codebase-design`, `research`, `prototype`, `improve-codebase-architecture`
- Planning artifacts: `to-spec`, `to-tickets`, `to-questionnaire`, `handoff`
- Existing engineering support retained and updated: `tdd`, `diagnosing-bugs`, `code-review`

## Pi adaptations

The installed copies are intentionally editable and differ from upstream:

- Pi command references use `/skill:<name>`.
- Internal skill composition loads sibling `SKILL.md` files with `read` instead of calling an unavailable `Skill` tool.
- Background-agent and sub-agent requirements fall back to current-session work, independent passes, and parallel tool calls.
- `ask-matt` only routes to skills in this curated profile.
- Branch and publication instructions remain subject to the user's global repository safety policy and require explicit authorization.

## Updating

`npx skills update -g` may overwrite these adaptations. Before updating, compare against this file and preserve or reapply the Pi-specific changes.

In pi-prjct these skills ship under `skills/mattpocock/<name>/` and are loaded through the `skills` installer module; a standalone copy under `~/.pi/agent/skills/<name>/` must be disabled first so a skill does not load twice.
