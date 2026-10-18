# Release and model acceptance boundaries

## Current: v0.1.4 SDK candidate

The release target is Windows x64 with Node 24.19.0 and DSH Desktop 0.2.1-rc.2. The source reference is `687f282e8625c6b8d11ff58211a90524be2e4317`; profile generation is `profile-v3-sdk-687f282e`, guardian protocol 2 and SDK wire 0.0.1. Old headless profile fingerprints and v0.1.3 acceptance receipts do not qualify.

Source, lockfile, bridge plugin, CLI/server identity, manifest, candidate metadata and public notes must agree on 0.1.4. Builds require clean committed source, matching official Node license, a current verified helper, public allowlists/secret scan and same-source/runtime zero-model test attestation. Local raw logs, credentials, real chat history, old candidates and host paths are excluded from public assets. No npm publication occurs.

### Prepare, validate, promote identical bytes

1. Explicitly dispatch the Windows workflow operation=prepare at a fixed clean source commit. It runs pinned Actions, lockfile install, native build, zero-model tests, package checks, license collection and release packaging. It uploads `v0.1.4-candidate` and immutable candidate.json; collisions refuse rather than overwrite.
2. Record the run ID, artifact ID/service SHA-256, package fingerprint and runtime ZIP SHA-256. Download by exact artifact ID and verify identities, checksums and all manifest files. Do not rebuild locally and call it the same candidate.
3. Audit existing quarantine recovery; run zero-model installed-runtime/guardian checks. Explicitly authorize bootstrap if the new immutable profile is missing. Verify the default provider/model and credential source without changing the Desktop profile or silently enabling other network tools.
4. Separately authorize actual model work and its budget, including Auto reviewer and late-answer costs. Keep failed attempts and their exit evidence. The minimal marker is `DSH_V014_SMOKE_OK`; the marker alone does not prove feature, persistence or supervision success.
5. Produce a sanitized independent schema-v2 host receipt for this exact candidate. A zero-model test summary is not a substitute.
6. Dispatch operation=publish at the same source commit with the exact prepare run/artifact IDs, ZIP SHA-256 and base64 receipt. The publisher checks workflow provenance and acceptance, downloads exact bytes and creates a draft. It uploads ZIP/manifest/checksums/summary/receipt, verifies GitHub server-side SHA-256 and then publishes as prerelease. It never rebuilds. Existing tag/release/asset identities stop promotion; no force-push or overwrite is permitted. Investigate a draft left by failure before any new attempt.

### Host acceptance schema v2

The validator requires these public fields:

- schemaVersion=2; bridgeVersion=0.1.4; dshVersion=0.2.1-rc.2; upstreamCommit, profileGeneration, guardianProtocol and sdkWireVersion matching the candidate;
- sourceCommit, packageFingerprint and zipSha256 exactly matching candidate.json; candidateRunId, candidateArtifactId and sha256-prefixed candidateArtifactDigest;
- a fresh 64-hex profileFingerprint; result=passed and the exact smoke marker;
- permissionVerified, treeExited, reportsDrained and legacyRecoveryAudited all true, newQuarantines=0;
- submittedTasks with unique taskIds of the same length, and unique continuationTaskIds that are a subset of taskIds;
- featureChecks with all nine checks true: sdkInitializeResumeWait, nativePresetsAndAuto, reasoningResolution, effectiveWorkingDirectory, launchCredentialSource, approvalPersistence, questionnaireLifecycles, lateAnswerResume and duplexSupervisionAndQuarantine;
- modelRequests with an explicit accounting source, and checkedAt as a valid UTC timestamp. Optional provider/model/usage can remain null when not observed.

Feature checks need independent validation of their stated scope; they are not inferred from one marker answer. Zero-model native evidence can cover isolated interfaces, but must not be presented as live reviewer decisions or complete packaged-profile execution. Record limitations and raw evidence outside the public receipt.

`submittedTasks` is a ledger count, **not** a model-request count. With no provider-dispatch observer, modelRequests is `{ "source": "unavailable", "agent": null, "autoReview": null, "other": null, "total": null }`. Observed counts use source=observed-provider-dispatch, nonnegative integer agent/autoReview/other and total equal to their sum. A continuation is a new task; one task can make many agent or reviewer requests. Never infer these counts from task submissions, tool calls, synthetic adapter calls or assumed Auto behavior.

The receipt validator limits the public JSON and rejects extra top-level fields, private paths and credential-like values. No receipt generated before the candidate/profile change can certify it. Read [verification boundaries](public/v0.1.4-verification.md) before recording a pass.

## Historical releases (unchanged evidence)

0.1.1, 0.1.2 and 0.1.3 are distinct prereleases with their own tags, source commits and asset identities. The original four-attempt paid ledger remains **0/4**, untouched. Old smoke/joint acceptance is not renewed authorization or a certificate for a new package. Historical documents under public/releases remain as recorded, including their older baselines and completion protocols.

v0.1.3 introduced separate prepare/publish promotion, independent candidate-bound host acceptance, immutable ZIP identity and explicit quarantine recovery. Its one-task acceptance format and headless completion proof are historical, not a v0.1.4 template. All real model tasks, user-home provisioning, provider changes and release operations still require separately scoped authorization.
