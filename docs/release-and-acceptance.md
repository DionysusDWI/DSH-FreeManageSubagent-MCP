# Release and model acceptance boundaries

Both 0.1.1 and 0.1.2 are prereleases. Each has a separate annotated tag, source commit and immutable asset set. Tag/version/asset collisions stop; no force-push, moved tag or overwritten asset is permitted.

Release automation uses Windows x64, Node 24.19.0, pinned Actions, lockfile installation, zero-model tests and public file allowlists. It creates a draft, uploads ZIP/manifest/checksums/sanitized summary, checks GitHub server-side SHA-256 against local SHA256SUMS, then publishes as prerelease. A draft retained after failure must be investigated; normal publish refuses an existing release.

All actual model tasks, native profile provisioning in a user's home, provider/model changes and full-access work require separately scoped authorization. No npm publication occurs. The old paid smoke and joint acceptance drivers are retained only in the historical v0.1.1 tag; they do not certify or authorize 0.1.2.

The original four-attempt real-host ledger remains 0/4, untouched. New 0.1.2 model acceptance requires a fresh candidate binding and fresh control, never reused historical controls. Test summaries omit local paths, host identities, process logs and native history. Raw local evidence remains outside Git and release assets.
