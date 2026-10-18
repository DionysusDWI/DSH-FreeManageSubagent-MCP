/** Select the native physical encoding on an isolated copy; never decode or rewrite history. */
import fs from 'node:fs';
import path from 'node:path';
export function detectSessionCompression(root) {
  const encodings = new Set();
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Native session storage links are refused.');
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.jsonl(?:\.zstd)?$/.test(entry.name)) {
        encodings.add(entry.name.endsWith('.zstd') ? 'zstd' : 'none');
        if (encodings.size > 1) throw Object.assign(new Error('Native session root contains mixed physical encodings; use a separate root. No conversion or fallback was attempted.'), {code:'SESSION_ENCODING_MIXED'});
      }
    }
  }
  visit(root);
  // Match the pinned native backend default for an empty root; it still verifies IDs.
  return encodings.values().next().value ?? 'zstd';
}
