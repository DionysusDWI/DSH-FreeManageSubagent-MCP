# Generic local deployment

DSH Desktop is the only backend, tested extension baseline 0.2.0-rc.2. Windows x64 is the only qualified platform. Trusted local clients use stdio MCP; no authentication server or network transport is provided.

| Configuration | Meaning |
| --- | --- |
| DSH_MCP_NAMESPACE | Case-sensitive deployment namespace, default local. Shared by all trusted clients using this configuration; not derived from chat metadata |
| DSH_MCP_STATE | Absolute state root, default LOCALAPPDATA/dsh-mcp/state on Windows. Cooperating deployments use the same root so workspace locks coordinate |
| DSH_MCP_DSH | Explicit Desktop installation, executable or supported CLI path. Invalid overrides refuse; no silent fallback |
| DSH_MCP_CREDENTIAL_ENV_SOURCE | `process` (default) or explicit Windows-only `windows-user`; never chooses a provider |
| DSH_MCP_CREDENTIAL_ENV_REFS | Comma-separated credential variable names; required explicit allowlist for `windows-user`, maximum 16 |
| DSH_HOME | Native DSH home; unchanged. Holds manual and immutable bridge profiles |
| DSH_MCP_CSC | Explicit Windows C# compiler path for source builds |
| DSH_MCP_BUILD_STAGE / DSH_MCP_RELEASE_STAGE | Explicit safe stage directories on the binary destination volume; builds never alter ACLs or integrity labels |

The following old variables are whitelist aliases: CODEX_DSH_MCP_STATE, CODEX_DSH_MCP_DSH, CODEX_DSH_MCP_WORKSPACE, CODEX_DSH_CSC, CODEX_DSH_MCP_BUILD_STAGE and CODEX_DSH_MCP_RELEASE_STAGE. Different new/old values reject. The workspace alias is retained as configuration compatibility only; dsh_task still requires its own absolute workspace. No other old CODEX_DSH flags drive runtime routing, profile initialization or acceptance. PLUGIN_ROOT, PLUGIN_DATA and old multiplex flags have no deployment meaning.

config --format server-json, mcp-json or toml prints a server entry using actual absolute paths, without editing any client. --namespace, --state, --dsh and --dsh-home override generated fields. --credential-env-source and --credential-env-refs set credential inheritance without copying credential values. Source checkout falls back to the actual Node executable; release uses its bundled runtime. Never copy one machine's generated paths to another machine.

Default sandbox remains workspace-write. read-only is appropriate for analysis. danger-full-access is retained but requires separate explicit authorization; this release does not test it with a paid agent. provider/model are paired optional task overrides; the bridge never selects a fallback. Report/guidance/permission DSH plugins remain necessary and are packaged with neutral names.

Self-check does not execute token/state probes, install dependencies or touch a missing state directory. A ready profile means its content matches; guardian launch-time token/state preflight and actual policy persistence are still mandatory. An absent ready profile requires a separately authorized explicit bootstrap. Updates create new fingerprinted profiles; old profiles are not edited.

Namespaces prevent accidental state crossover through the MCP tools, not arbitrary access by the same OS user. Keep different trust domains in different OS environments. No promise is made of auto-isolation of chats in a single harness.

## Credentials and default routing

The bridge base/headless profile defaults to `deepseek-official / deepseek-flash`. It is independent of the model selected in a manual Desktop profile. Provider/model task overrides must be paired and explicit. The bridge never falls back to an account route or another provider after a credential failure.

A ready immutable profile proves file integrity, not credential availability, API authorization, credit, or model readiness. A key in a new terminal or Windows User environment does not prove that an already running MCP bridge inherited it.

Default `process` mode passes the bridge process environment unchanged. On Windows, an operator can explicitly allow missing credential references to be read from Windows User environment values:

```powershell
.\runtime\node.exe .\bin\dsh-mcp.js config --format toml --credential-env-source windows-user --credential-env-refs DEEPSEEK_API_KEY
```

This prints only the source and reference name in the MCP environment configuration. Do not put a key value into the generated configuration. Reconnect the client after applying it. Names are case-insensitive on Windows; runtime/control variables and duplicate names are refused. The bridge reads only requested missing references, once per task; it does not enumerate the registry, cache keys, modify `process.env`, or write keys to profiles, overlays, state, or diagnostics. An explicitly present process value, including an empty string, is not replaced. Imported User values become process environment for DSH and therefore take precedence over stored credentials for the same reference. DSH Desktop 0.2.0-rc.2 then resolves process, credential store, project `.env`, and home `.env` in that order. Do not enable User inheritance if that precedence is unwanted.

`diagnose` and `dsh_self_check` report names, presence, and source only. They do not inspect the DSH credential store or test provider authorization. With explicit User inheritance, these read-only checks can start a hidden, bounded PowerShell reader; they still do not initialize state or submit tasks.

For an explicit zero-model check through Guardian, installed Electron, and the real DSH credentials resolver, use:

```powershell
.\runtime\node.exe .\scripts\check-dsh-contract.js --credentials
```

Set the source/ref configuration in that command environment as needed. The check uses an isolated temporary DSH home, loads no LLM adapter, and emits no credential values. It can confirm credential transit and resolution, not that a provider accepts a key. The normal SDK check without this flag uses synthetic credentials only.
