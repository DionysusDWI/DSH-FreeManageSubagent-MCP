# Generic local deployment

DSH Desktop is the only backend, tested extension baseline 0.2.0-rc.2. Windows x64 is the only qualified platform. Trusted local clients use stdio MCP; no authentication server or network transport is provided.

| Configuration | Meaning |
| --- | --- |
| DSH_MCP_NAMESPACE | Case-sensitive deployment namespace, default local. Shared by all trusted clients using this configuration; not derived from chat metadata |
| DSH_MCP_STATE | Absolute state root, default LOCALAPPDATA/dsh-mcp/state on Windows. Cooperating deployments use the same root so workspace locks coordinate |
| DSH_MCP_DSH | Explicit Desktop installation, executable or supported CLI path. Invalid overrides refuse; no silent fallback |
| DSH_HOME | Native DSH home; unchanged. Holds manual and immutable bridge profiles |
| DSH_MCP_CSC | Explicit Windows C# compiler path for source builds |
| DSH_MCP_BUILD_STAGE / DSH_MCP_RELEASE_STAGE | Explicit safe stage directories on the binary destination volume; builds never alter ACLs or integrity labels |

The following old variables are whitelist aliases: CODEX_DSH_MCP_STATE, CODEX_DSH_MCP_DSH, CODEX_DSH_MCP_WORKSPACE, CODEX_DSH_CSC, CODEX_DSH_MCP_BUILD_STAGE and CODEX_DSH_MCP_RELEASE_STAGE. Different new/old values reject. The workspace alias is retained as configuration compatibility only; dsh_task still requires its own absolute workspace. No other old CODEX_DSH flags drive runtime routing, profile initialization or acceptance. PLUGIN_ROOT, PLUGIN_DATA and old multiplex flags have no deployment meaning.

config --format server-json, mcp-json or toml prints a server entry using actual absolute paths, without editing any client. --namespace, --state, --dsh and --dsh-home override generated fields. Source checkout falls back to the actual Node executable; release uses its bundled runtime. Never copy one machine's generated paths to another machine.

Default sandbox remains workspace-write. read-only is appropriate for analysis. danger-full-access is retained but requires separate explicit authorization; this release does not test it with a paid agent. provider/model are paired optional task overrides; the bridge never selects a fallback. Report/guidance/permission DSH plugins remain necessary and are packaged with neutral names.

Self-check does not execute token/state probes, install dependencies or touch a missing state directory. A ready profile means its content matches; guardian launch-time token/state preflight and actual policy persistence are still mandatory. An absent ready profile requires a separately authorized explicit bootstrap. Updates create new fingerprinted profiles; old profiles are not edited.

Namespaces prevent accidental state crossover through the MCP tools, not arbitrary access by the same OS user. Keep different trust domains in different OS environments. No promise is made of auto-isolation of chats in a single harness.
