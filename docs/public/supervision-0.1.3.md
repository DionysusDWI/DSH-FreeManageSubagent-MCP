# Supervision evidence in v0.1.3

Each execution has a random attempt ID and unique Windows Job name. The bridge saves an unauthorized intent, forks a worker, persists the worker PID and creation time, and then authorizes launch. The worker registers the helper before writing its launch request. The helper atomically creates a suspended child in a kill-on-close Job and persists the child creation time and Job identity before resuming its thread.

Files under the task's `supervision/ATTEMPT_ID` directory describe bridge, worker and helper stages independently of IPC. They contain identities, phases, first failures and exit proofs. They do not contain the prompt, launcher arguments, full environment or credentials. Separate Guardian/helper stderr files retain early native diagnostics. These files are local evidence and are excluded from public release assets.

A missing `started` message is not proof of non-launch. A bridge authorization gap is safe only when its durable intent says authorization was never issued. After authorization, an explicit matching worker refusal or a helper proof is required. An empty-Job proof must match the registered worker and helper identities, attempt and Job. A raw PID list never proves tree exit.

Both normal and exceptional helper completion terminate managed descendants and query the Job until the active process count reaches zero. Killing the helper enforces kill-on-close but loses this verification; it must not become a false cancelled/success outcome. The bridge preserves the first failure code (for example `GUARDIAN_STARTUP_TIMEOUT`) and records `TREE_EXIT_UNCONFIRMED` as an additional exit status. Uncertain exit remains interrupted and quarantined.

Startup handshake defaults to 15 seconds and is bounded by the task's total deadline. Cancellation, EOF and IPC loss stop the managed tree. A failed state write before authorization refuses launch. Quarantine is checked before allocating a new scope and again under the registry lock immediately before final authorization.

Read-only execution also carries a durable registry claim so an abandoned launch cannot escape workspace protection. Active read-only claims retain concurrent execution semantics. Unresolved claims/quarantines block overlapping work in every mode and all full-access work under the same state root, across namespaces.
