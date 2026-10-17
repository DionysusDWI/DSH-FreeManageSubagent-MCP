# Completion-event relay correction in v0.1.3

## Fault

A worker process exit is not the end of its output stream. Node can emit the child process `exit` event before it delivers queued IPC messages to the parent. The bridge used that event to settle supervision. The task runner then flushed its parser, derived an outcome and closed its log descriptors. Later IPC callbacks could no longer write the terminal events and recorded `EBADF`.

This race can affect both short answers and long answers. A local synthetic child reproduced the ordering without DSH, credentials, a provider or a model request. A DSH `text` event with `truncated: true` is only bounded progress. It cannot replace the lossless `final` event.

## Correction

The parent keeps the IPC channel referenced and waits for the complete relay-close barrier before it settles supervision. Normally this is the ChildProcess `close` event, after stdio and IPC have drained. For an explicit parent-side disconnect, Node 24 can omit that event; the bridge also recognizes its full equivalent: worker process exit, IPC disconnect and stderr close. The worker's other stdio streams are ignored, not separate output relays.

`worker-exited` and `relay-closed` are separate diagnostic stages. Callback failures received during drain reject supervision with the first error. They cannot arrive after an already successful task promise. Disconnect watchdogs are not restarted after settlement.

The change does not relax completion or permission checks. Success still requires a zero DSH exit code, a terminal `final`, no error or unsuccessful turn end, a verified main-session permission proof and confirmed process-tree exit. An empty Windows Job proves process-tree exit only; it does not prove output drain or task completion.

## Zero-model coverage

- Controlled lifecycle events: worker exit before stdout, stderr, diagnostics and terminal exit IPC.
- Original stdout/stderr callback errors during tail delivery.
- Explicit disconnect without a ChildProcess `close` event.
- Real Guardian and task-runner traversal for short output, lossless UTF-8 output above 128 KiB and exit zero with no `final`.
- A standalone supervisor process with no unrelated timer or server handle.

The long-output fixture checks byte-complete final output despite bounded progress. It is not a Russian semantic accuracy test. Historical failed tasks and their incomplete logs remain unchanged. A new candidate needs a new explicitly authorized host acceptance task; an older receipt cannot qualify different package bytes.
