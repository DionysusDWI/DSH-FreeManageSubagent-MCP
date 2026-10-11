/**
 * Shared test helpers.
 * @module test/helpers
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Create a temporary directory for one test file.
 * @param {string} label - directory label.
 * @returns {{dir: string, cleanup: () => void}} temporary directory and its remover.
 */
export function tempDir(label) {
  const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.tmp');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, `codex-dsh-mcp-${label}-`));
  return {
    dir,
    cleanup: () => {
      try {
        const target = path.resolve(dir);
        if (!target.startsWith(base + path.sep) || path.dirname(target) !== base) throw new Error('Unsafe test cleanup path');
        fs.rmSync(target, { recursive: true, force: true });
      } catch {
        // A leftover temp directory must not fail a test run.
      }
    },
  };
}

/**
 * Build an environment whose bridge state root is inside a temp directory.
 * @param {string} dir - temp directory.
 * @param {Record<string, string>} [extra] - extra variables.
 * @returns {NodeJS.ProcessEnv} environment.
 */
export function isolatedEnv(dir, extra = {}) {
  return {
    ...process.env,
    CODEX_DSH_MCP_STATE: path.join(dir, 'state'),
    ...extra,
  };
}
