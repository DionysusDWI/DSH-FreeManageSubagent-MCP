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
