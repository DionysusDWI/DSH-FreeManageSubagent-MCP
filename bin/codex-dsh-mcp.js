#!/usr/bin/env node
// Compatibility entry only; stdout remains exclusively the MCP/config stream.
process.stderr.write('codex-dsh-mcp is deprecated; use dsh-mcp. Configuration is namespace-based, not per-chat.\n');
await import('./dsh-mcp.js');
