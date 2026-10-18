# dsh-mcp 0.1.4 architecture (bridge state v3)

## Pinned upstream contract

The only supported DSH release is [dsh-v0.2.1-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2), source commit `687f282e8625c6b8d11ff58211a90524be2e4317`. The adaptation was compared with `dsh-v0.2.0-rc.2`, commit `639ed015397290b3745d163aafe02ffee4aa3f84`, in a separate reference checkout. Updating the bridge does not overwrite an older DSH checkout, follow master, edit the Desktop profile, change provider, or configure Search/Fetch.

DSH remains a Cordis plugin composition. Reasoning effort, user approval, Auto review and structured questions were not all introduced by this upstream release. Relevant changes and integration choices are:

| Upstream area | Bridge consequence |
| --- | --- |
| New working-directory service and replayable projection | Header cwd identifies the original project; effective cwd is read from the service/projection and independently compared with SDK output. Existing processes keep their own cwd and native sandbox grants. |
| SDK resume, wait and event interfaces | Restore an exact session without another prompt; wait and observe native turns. A late answer enters the native answer service, not a fabricated human message. |
| Headless versus SDK composition | SDK inherits interactive credentials/account rows from base. Disable those rows explicitly to retain the old headless launch-environment strategy. |
| Native permission lifecycle | Select the official Auto preset, retain native one-time escalation, guard PTC inner tools and refuse new execution if Auto disappears. Do not treat sandbox strings as a permission rank. |
| SDK shutdown and persistence barriers | Close admission, drain native events/control delivery, flush sessions, shut down the SDK and require independent empty-Job/transport-close evidence. |

Reference implementation areas: [working directory](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/working-directory), [SDK server](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sdk/server), [Auto review](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/packages/experimental/auto-review).

## Execution and ownership

Trusted local MCP client → stdio MCP server → namespace catalog → native-session scope → scheduler → per-task guardian worker → Windows Job Object → private Desktop CLI → official SDK JSON-RPC runtime.

There is one supervised DSH process tree per task, no shared resident service and no listener. The bridge implements the official NDJSON protocol on guardian-owned pipes; it does not use an SDK client path that starts an unmanaged process. Profile composition is base + sdk-app + official Auto review + timed question tool + bridge plugin. Profile configuration is immutable and launch-only. No paid model, profile bootstrap or task execution occurs in read-only capability queries.

Namespace directories use a hash of a case-sensitive configured name. Client metadata never selects ownership. A private random storage scope exists before the native session is captured; it is never exposed as a session ID. State v3 adds requested/resolved/effective configuration and interaction references without rewriting historical records. Existing report/guidance protocol v2 owner fields remain neutral scope identities, not human or chat credentials.

A task records its workspace and deadline before queueing. Session selection checks ownership, the original canonical project and quarantine before task registration, then rechecks before native launch. The scope execution lock serializes a native session; overlapping real workspaces use cross-process write locks. Auto is a write-capable mode for lock purposes. A separate workspace quarantine blocks even new read-only work after unknown exit.

Before explicit continuation, the installed native persistence SDK reads an isolated copy of the session data, checks root-session identity/original project and validates the current working-directory projection. Original storage is not changed by verification. The new runtime then uses `session/resume` and revalidates its live policy/cwd. No automatic replay or inference of historical task configuration is allowed.

## Guardian and completion

Guardian protocol 2 negotiates capabilities before accepting launch data. Duplex stdin is byte-oriented, bounded to 1 MiB queued credit and 32 KiB frames, and uses actual pipe-write acknowledgements. Cancellation/control is separate from the native pipe writer, so blocked stdin cannot stall Job termination. A pipe ACK is never a tool approval or questionnaire ACK. Old protocol peers fail closed before SDK input.

The helper creates the child suspended, atomically assigns it to a kill-on-close Job Object, persists attempt ownership and proves state-write capability before resuming it. Cooperative cancel/deadline requests precede forced Job cleanup. Helper, worker, child and known descendants remain tracked until empty-Job proof and complete stdio/IPC drain. Unconfirmed exit becomes interrupted with durable scope/workspace quarantine, not cancelled or failed-with-released-locks.

Normal execution is initialize → optional resume → get effective cwd/policy proof → normal prompt (unless answering a restored question) → wait → durable settle command → wait → shutdown → exit/drain proof. The settle handshake closes interaction routing atomically, closes new model/tool admission, drains guidance and native receipts, flushes all sessions and binds the final persisted turn/end. Completion additionally needs a newly observed successful turn; SDK idle, exit 0 or an old terminal event alone cannot succeed.

## Native permission invariant

Public choices are read-only, workspace-write and auto; inherit only maps caller context into one of those choices. Default workspace-write does not depend on the upstream declaration. Explicit choices are not capped by that declaration, which is unverified context, not system authorization.

Auto is selected by `permissionPresets.set(session, 'auto')` after official registration. Its native Full access + ask execution state is expected and allowed; per-call reviewer success or native one-time approval can run a Full access body. The bridge does not duplicate the reviewer or block an allowed body by comparing sandbox strings. Narrow child policies and native never-as-rejection are preserved. Native tool guards also cover started PTC inner calls. Official Auto does not separately review the outer run_code transport.

Before model/tool admission, verify agent lineage, expected native preset/policy and the presence of Auto when selected. Upstream Auto disposal migrates sessions to direct Full access + never; the bridge refuses new execution rather than accepting that fallback. Normal shutdown closes entry before disposing plugins. No live permission/model/depth switching is exposed.

## Durable interactions

Each interaction source task owns immutable complete requests, normalized submissions, native receipts, lifecycle records and per-delivery-task admission records. IDs, task/scope/session/call identity, request digest, response digest, state and expiry are checked before application. The request captures the complete original tool arguments/schema, native reason and effective cwd, not a reconstruction from stdout. Requests above 8 MiB refuse interactive execution rather than silently dropping authorization facts.

Native approval/request exposes only allowed-once, rejected and cancelled. Native user-questions preserve question IDs, option labels, multi-select/custom answers and plan-review intent, with native validation at application. The task fixes the timed-tool policy: pause uses -1, continue defaults to 120 seconds; a model-supplied timeout cannot bypass it. Plan review is a native blocking flow even under continue.

A response first persists routing intent. Queueing is not native application. Only a matching native approval/decided, successful tool result (including tool/ptc-dispatch), or persisted user-question-reply plus session flush can produce an applied receipt. Disk or protocol failures close admission and cannot manufacture an ACK.

Timed questions can remain continued after normal task completion. Route to a live admitted agent first; otherwise an explicit dsh_respond can register a same-session continuation with the original configuration and a fresh task deadline. Restore the native projection, call the native answer service and wait for its persisted reply. The continuation contains no ordinary prompt. A missing task after persisted routing intent is recovery-required, not grounds for automatic resubmission. Failed/crashed/quarantined origins cannot be replayed through this mechanism.

## Read and recovery boundaries

Readers do not acquire mutation locks, recover abandoned tasks, create missing state or refresh quarantine timestamps. Requests have lossless base64 UTF-8 JSON byte pages of at most 16 KiB; the complete MCP result is bounded to 64 KiB. Reports and guidance retain independent append-only cursors and persisted native delivery confirmation.

The existing explicit quarantine recovery transaction is retained: scope lock before shared supervision-registry lock; multiple scopes in absolute-path order. Original incident bytes, hashes, terminal outcome and other incidents are preserved. Operator attestation remains CLI-only and does not retroactively turn historical treeExited into true. See [supervision](public/supervision-0.1.3.md) and [0.1.4 upgrade](public/upgrade-0.1.4.md).

Immutable profile marker format remains v2; its generation/fingerprint is new (`profile-v3-sdk-687f282e`). The marker format, managed state version, SDK wire version and guardian protocol are independent. Neither a ready profile nor a package inventory proves provider authorization, live SDK correctness, OS isolation or release qualification.
