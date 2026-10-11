# dsh-mcp v3 architecture

Trusted local MCP client → generic stdio SDK server → configured namespace catalog → native session scope → TaskScheduler → per-task guardian worker → Windows Job Object → DSH Desktop headless. DSH is the only execution engine. Client metadata never routes ownership.

The v3 namespace directory is a SHA-256 of its case-sensitive name. catalog.json stores true native IDs, verified status, canonical workspaces and task references. A random private storage key exists before DSH yields an ID; it is never returned as session_id. Each scope has a v3 owner/task index, native sessions, append-only reports and task control artifacts. Namespace indexes and task records use fsync/atomic rename and cross-process locks. Existing channel/report version 2 owner fields are an internal neutral scope protocol, not a Codex chat identity.

Task acceptance records queued, deadline and explicit workspace. Selecting a session validates the catalog, scope ownership, canonical workspace and quarantine before task creation; runtime rechecks before launch. Same scope uses an in-process chain and cross-process execution lock. Workspace write claims serialize overlapping real filesystem boundaries. A durable separate workspace quarantine also refuses new read-only work after unknown exit. No quarantine is automatically removed by v3 execution.

Before continuation, the installed DSH persistence SDK opens a temporary copy of native storage in read mode, proving native ID/main-session/workspace metadata without model access or changes to original history. The DSH-side plugin applies sandbox and approval settings at agent creation, flushes permission proof before a model step, and clamps child permissions. Actual captured session IDs require persisted policy proof.

The Windows guardian creates a supervised Job Object with kill-on-close and proves state-write capability before DSH creation. EOF/cancel/deadline cooperate through task control and session flushing, then terminate the job. cancelled is reported only after all monitored processes exit. Failure to establish exit yields interrupted and durable scope/workspace quarantine; crashed tasks are not replayed.

Reports and guidance use separate append-only files, stable IDs and independently paged cursors. Guidance is marked delivered only after a successful receiving tool result is persisted and its complete message batch is verified. Response text plus structured content is capped at 64 KiB; full task output remains in owned managed files.

Independent explicit bootstrap creates a new immutable content/launcher fingerprinted profile; normal startup, diagnosis and config output never provision. Explicit migration copies bridge-managed data and records an irreversible import receipt, retaining source bytes and old profiles. Namespace configuration is not authentication against an OS user.
