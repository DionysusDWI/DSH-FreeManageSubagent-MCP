/** Read-only ASAR metadata access. No installed archive is ever modified. */
import fs from 'node:fs';
export function readAsarFile(archive, inner) {
  const fd = fs.openSync(archive, 'r');
  try {
    const first = Buffer.alloc(16); if (fs.readSync(fd, first, 0, 16, 0) !== 16) throw new Error('Invalid ASAR header');
    const size = first.readUInt32LE(12); if (size > 32 * 1024 * 1024) throw new Error('ASAR header too large');
    const header = Buffer.alloc(size); fs.readSync(fd, header, 0, size, 16); let entry = JSON.parse(header.toString('utf8'));
    for (const name of inner.replaceAll('\\', '/').split('/')) { entry = entry.files?.[name]; if (!entry) throw new Error('Missing ASAR entry: ' + inner); }
    if (entry.unpacked) return fs.readFileSync(archive + '.unpacked/' + inner);
    if (!Number.isSafeInteger(Number(entry.size)) || Number(entry.size) > 64 * 1024 * 1024) throw new Error('Invalid ASAR entry size');
    const bytes = Buffer.alloc(Number(entry.size)); fs.readSync(fd, bytes, 0, bytes.length, 8 + first.readUInt32LE(4) + Number(entry.offset)); return bytes;
  } finally { fs.closeSync(fd); }
}
