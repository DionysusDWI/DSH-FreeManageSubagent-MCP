# Codex–DSH MCP 0.1.1

Historical Windows x64 prerelease. This version uses the Codex plugin distribution entry and DSH Desktop 0.2.0-rc.2 as its execution backend. It is not a stable release or a certification of every Codex installation.

The five stdio MCP tools provide authorized task delegation, persistent status and report pagination, durable guidance, supervised cancellation, and read-only health diagnosis. Foreground calls detach after at most 30 seconds. Task deadlines include queueing and preparation. Session recovery never automatically replays work.

Download the Windows x64 ZIP from the corresponding GitHub prerelease. It includes Node 24.19.0, locked production dependencies, the Windows Job Object guardian, upstream licenses and a file manifest. Use the bundled runtime; DSH Desktop must already be installed. Profile provisioning is a separate explicit operation. No model task is run during installation or health diagnosis.

Source development: install locked dependencies with npm ci, run npm test, npm run build:native, npm run validate:package, npm run check:guardian and npm run check:dsh-contract. The last check needs an installed DSH Desktop; it probes isolated API preparation without a model request. Building requires Windows x64, Node 24.19.0 and its official LICENSE in docs/.doc-cache/node-v24.19.0-LICENSE.

See [the sanitized verification summary](docs/public/v0.1.1-verification.md), [architecture](docs/architecture.md) and [release boundaries](docs/release-and-acceptance.md). Machine-specific evidence, historical candidates and paid-test controls remain local and are deliberately absent from Git and release assets.

The historical four-attempt model acceptance remains at **0/4 consumed**. Paid model, actual multi-chat host, child-agent, full-access, frontend cancellation and large real-report gates are not certified by this prerelease.

MIT licensed; upstream and contributor notices are preserved.
