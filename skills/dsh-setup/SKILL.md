---
name: dsh-setup
description: Configure and diagnose this local Codex–DSH plugin, including authorized immutable profile provisioning, upgrades and rollback. Use for DSH bridge setup or health issues, not to delegate model work.
---

# DSH local setup

This plugin runs a local stdio MCP bridge and supervised DSH headless tasks. See ../../README.md and ../../docs/release-and-acceptance.md. A downloaded or built package is a candidate, not evidence of actual Codex or paid-model acceptance.

- Resolve the installed plugin root from the host, never a machine-specific checkout. The self-contained Windows package uses runtime/node.exe and bin/codex-dsh-mcp.js. The source checkout needs Node and npm dependencies.
- Read-only diagnosis: use dsh_self_check if available, or the package runtime to run bin/codex-dsh-mcp.js --diagnose. Show the actual launcher, DSH version, DSH_HOME, state root and profile fingerprint. A present guardian is not proof that its token can write task state. Silence does not imply a permission prompt.
- Supported candidate baseline is DSH 0.2.0-rc.2. An explicit CODEX_DSH_MCP_DSH override must point to the intended installation, executable or CLI. An invalid override is an error; do not swap installations or edit app.asar. Keep one DSH_HOME/environment for diagnosis, install and execution.
- Before creating a profile, explain that --bootstrap installs DSH plugin dependencies into a new managed snapshot under DSH_HOME/profiles and may need network access. Obtain explicit user authorization for this provisioning mutation; then run the package runtime with bin/codex-dsh-mcp.js --bootstrap. This is not authorization for model charges. Do not set CODEX_DSH_MCP_ALLOW_PROVISION=1 without separate, informed approval.
- Preserve manual profiles/configuration. Updates create new fingerprinted snapshots; stop active tasks before switching plugin installations. Do not delete unknown old state, replace an active plugin, copy projects or create worktrees automatically.
- Require an explicit project workspace on delegated calls; the portable MCP config starts in plugin data, not necessarily the user's repository. Use the same state root and DSH_HOME for cooperating bridge instances so write locks coordinate.
- If Windows reports GUARDIAN_STATE_NOT_WRITABLE, no DSH process was launched. Explain the token/integrity-label or filesystem-permission issue. Never relabel binaries, alter ACLs, elevate, switch to full access, or launch DSH without the guardian automatically. Ask the user to choose an authorized deployment/remediation.
- True chat isolation/concurrency needs actual host thread metadata. Strict binding rejects identity changes; optional CODEX_DSH_MCP_MULTIPLEX=1 requires a nonempty threadId on every tool call. Do not fabricate metadata or call second-chat rejection successful concurrent support.
- For upgrade/rollback and interrupted/quarantined tasks, follow the manual checklist. Recovery never replays a prompt automatically. Model smoke requires separate explicit approval and its --authorize-model-cost flag.
