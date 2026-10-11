# Upgrade from 0.1.1

0.1.1 remains a historical Codex plugin prerelease. 0.1.2 removes that distribution entry and uses a generic stdio service named dsh-mcp. The physical source checkout and old frozen packages remain untouched.

Breaking changes: explicit absolute workspace is required; session_id selects a native DSH session and omission creates a new session. Deprecated new_session=false requires session_id, true forbids it. task_id is required for status, guidance and cancel. Ownership is a configured deployment namespace, not _meta.threadId, _meta.sessionId or clientInfo.name. The new dsh_sessions metadata query uses opaque cursors. No deletion, branch or rollback tool is introduced.

Old Codex data is never imported automatically. Select exactly one old v2 conversation directory and one destination namespace; stop all old bridge processes first. Every task must be terminal with treeExited=true, no monitored process may still be alive, and no execution lock/quarantine may remain. No automatic clearing is provided.

~~~powershell
.\runtime\node.exe .\bin\dsh-mcp.js migrate-state --source 'ABSOLUTE_OLD_V2_DIRECTORY' --namespace migrated --dry-run
.\runtime\node.exe .\bin\dsh-mcp.js migrate-state --source 'ABSOLUTE_OLD_V2_DIRECTORY' --namespace migrated --apply
~~~

Dry-run performs no source or destination rewrite. It validates the installed native SDK against an isolated temporary copy; this creates temporary managed probe data only and invokes no model. Apply uses cross-process migration/execution/store locks, reserves a durable one-time import, rechecks source fingerprints, and imports only bridge records, reports, native session storage and required task control artifacts. Projection caches are regenerated rather than copied because arbitrary project data could be embedded there. Projects, credentials, profiles and unmanaged files are excluded.

Native chat-history bytes are not rewritten. Bridge owner/path indexes are converted to v3. A failed/ambiguous reservation remains recorded and is not silently retried; repeat, source changes, target ID conflicts or SDK verification failure reject. Partial staged data is retained for investigation rather than cleared.

A migrated main session is selectable only after verified native ID/workspace checks. Each real continuation revalidates the SDK on an isolated copy before launching DSH, and the DSH plugin pins the requested main/child permission ceiling and flushes it before model entry. Do not treat the synthetic migration tests as validation of every historical Desktop session.

Generate a fresh client configuration and reconnect manually. A bootstrap may be required for the new immutable dsh-mcp profile and must be authorized separately; successful migration does not authorize provisioning, a model request or broader permissions.
