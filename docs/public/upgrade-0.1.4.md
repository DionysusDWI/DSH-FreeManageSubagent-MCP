# Upgrade to dsh-mcp 0.1.4

## Before replacement

1. Pin DSH Desktop to 0.2.1-rc.2. The bridge source reference is tag dsh-v0.2.1-rc.2, commit `687f282e8625c6b8d11ff58211a90524be2e4317`, not master. Keep any previous source checkout unchanged; a separate checkout is for reference only.
2. Inventory all bridges sharing the state root, namespace and workspace locks. Drain tasks and pending approvals. Save configuration, original task/incident records and state fingerprints. Stop the old bridges before replacing files; do not hot-replace an active installation.
3. Inspect quarantine and pending recovery transactions using the existing read-only incident commands. Resolve them explicitly with matching exit evidence. A new version does not clear locks or certify old process exits. See [0.1.3 recovery](upgrade-0.1.3.md).
4. Install the verified Windows x64 self-contained candidate in a new fixed directory. Verify checksums, source commit, package fingerprint and ZIP identity. Do not treat a test checkout or a previous host receipt as a released 0.1.4 candidate.

## New profile, unchanged data ownership

Keep the existing DSH_HOME, DSH_MCP_STATE and case-sensitive namespace unless deliberately migrating. Bridge state remains v3 with additive fields; old task records are not rewritten. Old report/guidance owner formats remain valid. No automatic import, quarantine release, replay or selection of a recent native session occurs.

Profile generation changes to `profile-v3-sdk-687f282e`; the immutable marker file format itself remains v2. Old headless fingerprints are not reused. After separately authorizing network/home writes, run the new candidate's explicit bootstrap. It creates a new base + sdk-app + official Auto + question + bridge profile, never edits the previous profile or Desktop profile. Do not modify an existing immutable snapshot to make ready=true.

Generate the new MCP configuration with its bundled Node 24.19.0, apply it and reconnect. Confirm version 0.1.4 and **eleven tools**, including dsh_capabilities, dsh_interactions and dsh_respond. Read-only diagnose/capabilities separate content readiness, installed package availability, live verification requirements and named credential presence. They do not initialize profiles or call models.

Explicit session continuation revalidates native history with the new installed persistence SDK before execution. Header cwd is the original project; current working-directory changes are replayed from the projection. An older managed task lacking new configuration is still readable, but its configuration is not invented for a late-question continuation. Never rename native IDs, rewrite old outcomes or turn a truncated answer into completion.

## Client changes

- Change direct Full access requests to an explicitly selected **auto** only when native per-call review is intended. A legacy sandbox_mode=danger-full-access now errors; it is not silently translated. read-only/workspace-write legacy inputs remain valid. New permission_mode and old sandbox_mode cannot coexist.
- Inherit requires upstream_permission_mode. Full-access maps to native Auto; no declaration alone changes the workspace-write default. This declaration is context, not authentication or a ceiling.
- Use reasoning_effort off/low/high/max; log is not accepted. Omit it for the native model default, and read effective_configuration. Provider/model overrides remain paired.
- Decide question_policy at submission. Pause is default and can keep the task waiting; continue defaults to 120 seconds. Continue does not make native plan review nonblocking or allow a tool to override the policy.
- Persist task_id, request_id and request_digest. Read all detail pages before approving. Treat queued/submitted separately from acknowledged; use only native single-use decisions.
- A late dsh_respond may explicitly create a new continuation task and model cost. Track its returned ID, drain its reports, and retain separate submitted-task and model-request accounting. Repeating the same response must not create another task.

## Credentials and verification

The default official/flash route is unchanged. SDK base normally includes interactive credentials, unlike headless; the bridge explicitly disables credentials/authorization/deepseek-account to retain launch-environment resolution. It does not read GUI stored keys to repair a missing environment. Keep the original process-only or explicitly configured Windows User inheritance strategy, and reconnect after changes. See [configuration](configuration.md#credentials-and-default-routing).

Run the zero-model guardian and installed-rc.2 contract checks from the candidate. The contract uses deterministic adapters in temporary storage and does not certify full packaged-profile startup, live provider authorization or persistent PTC kernel enforcement. Then obtain separate permission for any real model acceptance. Use a new profile fingerprint and a new schema-v2 host receipt bound to the exact candidate. **Never reuse 0.1.3 evidence or model-task counts.**

Promotion remains prepare → separate acceptance → publish identical ZIP bytes. No npm publication, provider switch, Search/Fetch setup, bootstrap or paid task is authorized merely by upgrading. Original paid-test ledgers remain unchanged.
