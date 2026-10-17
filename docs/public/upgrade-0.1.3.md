# Upgrade and quarantine recovery for v0.1.3

Use the Windows x64 self-contained candidate with Node 24.19.0 and DSH Desktop 0.2.0-rc.2. Keep the existing state root and namespace. Before changing the client launch command, save configuration and state fingerprints, inventory all bridge processes sharing that state root, drain their tasks, and stop the old bridges. Preserve archived quarantine files and original task outcomes.

Install the verified candidate to a new fixed directory. Use its bundled runtime for `diagnose`, `config`, and explicit `bootstrap`. A plugin change requires a new immutable profile; old profiles are retained. Reconnect the MCP client and verify version 0.1.3, eight tools, and historical records.

`diagnose` and `dsh_self_check` report both the configured state root and a physical path obtained from the operating system. An unavailable physical path is reported as unknown. No MSIX package name is guessed. Machine timestamps use UTC; local evidence reports must include their UTC offset.

Inspect one incident without writes:

```powershell
.\runtime\node.exe .\bin\dsh-mcp.js quarantine inspect --task-id TASK_ID
```

Save the returned `expected_digest`. MCP `dsh_quarantine_release` requires that digest, a reason, and a verified not-authorized/not-started or empty-Job proof for the matching attempt. Dead legacy PIDs are not a complete tree-exit proof. A reused PID is distinguished with its creation time. Live or unknown related identities block release.

For legacy evidence, an operator must separately verify termination and explicitly attest it through the CLI. Inspect and review the reason before applying:

```powershell
.\runtime\node.exe .\bin\dsh-mcp.js quarantine release --task-id TASK_ID --expected-digest SHA256 --reason "Operator verification record reference" --operator-verified
.\runtime\node.exe .\bin\dsh-mcp.js quarantine release --task-id TASK_ID --expected-digest SHA256 --reason "Operator verification record reference" --operator-verified --apply
```

Release defaults to dry-run. The operator path also requires a successful OS process inventory and refuses related live processes. An attestation is recorded as `operator-attested`; it never changes historical `treeExited` into true. Terminal state and original error remain. Prior external releases are recognized without regenerating their quarantine.

Recovery acquires the scope execution lock before the global supervision registry lock. It saves original bytes, SHA-256 fingerprints and a pending receipt under `_locks/recoveries`. Pending recovery remains an execution barrier. Retry with the original expected digest and the same recovery method to finish an interrupted transaction. Conflicting edits fail closed. Other incidents, including new incidents at the same workspace, remain blocked.

Read-only queries never recover abandoned tasks or refresh quarantine timestamps. `recovery_required` identifies a task that needs explicit operator action. A terminal `dsh_cancel` does not certify historical tree exit; inspect the quarantine instead. Never delete registry files as a routine recovery procedure.

## Credential inheritance correction within v0.1.3

The corrected candidate remains version 0.1.3; identify it by source commit, package fingerprint, and ZIP SHA-256, not the version string alone. Save the prior installation and receipt before replacing it. Keep the same state root, namespace, and DSH home. If plugin content is unchanged, the existing immutable profile is reused; do not bootstrap or edit a profile to fix missing environment variables.

When a task fails with `MISSING_CREDENTIAL`, compare the environment of the bridge process, not just a current terminal. Restarting a terminal cannot change an existing bridge's environment. Use `diagnose` or `dsh_self_check`; `ready=true` covers profile content only. The bridge default official route need not match the manual Desktop account route. Do not silently change that route to make a test pass.

For an explicitly configured Windows User credential, enable `DSH_MCP_CREDENTIAL_ENV_SOURCE=windows-user` and `DSH_MCP_CREDENTIAL_ENV_REFS=DEEPSEEK_API_KEY` in the MCP server configuration, without adding the key value. Drain old tasks, stop old bridges, then reconnect. Process values still win, including an intentionally empty value. Review the credential precedence and no-model resolver check in `configuration.md`. Confirm presence/resolution before any separately authorized model task. Preserve the failed task and its actual tree-exit evidence; never retry it automatically or record infrastructure failure as model accuracy.


## Completion-corrected same-version package

Version 0.1.3 alone does not identify the corrected package. Verify the source commit, package fingerprint and runtime ZIP SHA-256 against the new release manifest. Drain and stop every old bridge that uses the installation before replacing its files. Do not replace code under an active bridge. This correction does not change the DSH plugin, so an unchanged immutable profile can be retained after its content is verified.

Keep earlier failed task records and logs. Do not turn them into completed tasks from truncated progress text or synthesize a missing final event. New executions use the relay-close barrier described in `completion-0.1.3.md`. A prior smoke receipt applies only to its original candidate.
