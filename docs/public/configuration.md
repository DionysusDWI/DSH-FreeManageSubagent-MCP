# Generic local deployment (0.1.4)

DSH Desktop is the only backend. The unique extension baseline is **0.2.1-rc.2**, source reference `687f282e8625c6b8d11ff58211a90524be2e4317`. Windows x64 with bundled Node 24.19.0 is the release target. Trusted local clients use stdio MCP; no authentication service or network listener is provided.

| Configuration | Meaning |
| --- | --- |
| `DSH_MCP_NAMESPACE` | Case-sensitive deployment namespace, default local. Shared by trusted clients using this configuration; not derived from chat metadata. |
| `DSH_MCP_STATE` | Absolute state root, default LOCALAPPDATA/dsh-mcp/state on Windows. Cooperating deployments share this root so workspace locks coordinate. |
| `DSH_MCP_DSH` | Explicit Desktop installation, executable or supported private CLI path. Invalid overrides refuse without fallback. |
| `DSH_MCP_CREDENTIAL_ENV_SOURCE` | process (default) or explicitly enabled Windows-only windows-user; never selects a provider. |
| `DSH_MCP_CREDENTIAL_ENV_REFS` | Comma-separated credential names; required allowlist for windows-user, maximum 16. |
| `DSH_HOME` | Native DSH home; holds manual and immutable bridge profiles. Not the MCP state root. |
| `DSH_MCP_CSC` | Explicit C# compiler path for source builds. |
| `DSH_MCP_BUILD_STAGE` / `DSH_MCP_RELEASE_STAGE` | Explicit safe stages on the binary destination volume. Builds never alter ACLs or integrity labels. |

Whitelisted compatibility aliases remain CODEX_DSH_MCP_STATE, CODEX_DSH_MCP_DSH, CODEX_DSH_MCP_WORKSPACE, CODEX_DSH_CSC, CODEX_DSH_MCP_BUILD_STAGE and CODEX_DSH_MCP_RELEASE_STAGE. Conflicting old/new values reject. A workspace alias does not remove the required absolute task workspace. PLUGIN_ROOT, PLUGIN_DATA and old multiplex flags have no routing meaning.

`config --format server-json|mcp-json|toml` prints a server entry using actual absolute paths, without editing a client. `--namespace`, `--state`, `--dsh` and `--dsh-home` override generated fields. `--credential-env-source` and `--credential-env-refs` configure named credential inheritance, never key values. Source checkouts use the invoking Node executable; self-contained packages use their bundled runtime. Reconnect after applying configuration, and regenerate it after moving the installation.

## Native execution configuration

Task configuration is fixed at launch or explicit continuation. `reasoning_effort` is off/low/high/max, with the native model default when omitted. Provider/model overrides must be paired. Full native model resolution is returned in effective_configuration; an unsupported effort fails, not downgrades.

`permission_mode` is read-only/workspace-write/auto/inherit, default workspace-write. Inherit requires an unverified caller upstream_permission_mode declaration; read-only and workspace-write map to themselves, full-access maps to auto. The declaration is not a ceiling for explicit choices. Merely declaring full-access does not choose auto.

Direct Full access is not a selectable MCP preset. **Native reviewed or one-time-approved Full access execution is allowed.** Auto uses the official plugin and native preset selection, not a handcrafted Full access override. A missing/unloaded Auto plugin closes new execution. The old sandbox_mode accepts read-only and workspace-write only, cannot coexist with permission_mode, and refuses its historical direct Full access value rather than silently mapping it to Auto.

Question policy is pause by default; continue defaults to 120 seconds and can explicitly set question_timeout_seconds (integer 1–2147483). Pause rejects that timeout field. The task total deadline still bounds all waiting. See [management API](management-0.1.4.md) for approval/question lifecycle, response digests, pagination and late-answer costs.

The bridge retains the base tool composition; it does not add a Search/Fetch option or change provider settings as an upgrade workaround. Native base tool availability is not permission to incur an auxiliary search request. Do not submit tasks without scoped workspace and model-cost authorization.

## Profile and diagnosis

Explicit bootstrap installs base + sdk-app + official Auto + question tool + bridge into a new fingerprinted profile. It may use network and writes DSH_HOME; normal startup/config/diagnosis/capabilities never do so. Old profiles are not edited or silently upgraded.

`dsh_capabilities`, `diagnose` and `dsh_self_check` distinguish:

- profile content integrity/readiness;
- required package presence at the installed baseline;
- active runtime/preset/guardian verification (still required on every launch);
- named credential environment presence;
- provider authorization (not tested by these readers).

Readers do not run token/state probes or touch a missing state directory. Feature availability is not a paid acceptance result. Namespace isolation prevents accidental crossover through the tools, not arbitrary access by the same OS user. Use separate OS trust domains when needed; there is no per-chat auto-isolation promise.

## Credentials and default routing

The default remains `deepseek-official / deepseek-flash`, independent of the model selected in a manual Desktop profile. No credential failure triggers an alternate account route or provider. The SDK base normally mounts interactive credential/account services, unlike headless. The immutable bridge patch explicitly disables credentials, authorization and deepseek-account to preserve the headless launch-environment strategy.

For the official adapter without the credentials service, rc.2 uses DSH's immutable launch-environment snapshot: inherited process values, then invoking-project `.env`, then DSH-home `.env`. An existing process value, including empty, masks lower layers. The bridge does not import GUI saved credentials. Changing the current working directory later does not reread credentials. Other explicit adapters retain their native contracts; they are not automatic fallback routes.

A key in a new terminal or the Windows User environment does not prove that an already running bridge inherited it. Default process mode passes that bridge environment. An operator can explicitly fill named *missing* references from Windows User values:

```powershell
.\runtime\node.exe .\bin\dsh-mcp.js config --format toml --credential-env-source windows-user --credential-env-refs DEEPSEEK_API_KEY
```

This prints source/name only; never paste a key into generated configuration. Reconnect afterwards. Names are case-insensitive on Windows; runtime/control variables and duplicate names are refused. The bridge reads only allowed missing names once per task, without registry enumeration, caching or process.env modification. An explicitly empty process value is not replaced. Imported User values enter DSH as process-layer values and therefore mask its lower `.env` layers.

No keys are copied into profiles, task configuration or diagnostic/acceptance records. Diagnostics show reference names, presence and source, not values. With explicit windows-user mode, a read-only check may start a hidden bounded PowerShell lookup; it still does not initialize state or call a model.

## Explicit zero-model checks

```powershell
.\runtime\node.exe .\scripts\check-guardian.js
.\runtime\node.exe .\scripts\check-dsh-contract.js
.\runtime\node.exe .\scripts\check-dsh-contract.js --credentials
```

The native contract runs inside an isolated temporary DSH home using installed rc.2 modules and deterministic local adapters. No provider stream/network request is made. The optional flag checks allowed credential-reference presence/transit through Guardian and installed Electron, emitting no values. It **does not** verify a real key, CLI `.env` loading, provider credit or the complete packaged immutable-profile launch. It is not the old interactive credential-store resolver probe. Real model and package acceptance require separate authorization and a fresh exact-candidate receipt.
