/**
 * Which local files POST /send-media may read and send.
 *
 * The bridge only sends files that sit inside an allowed folder (by default
 * the per-install "outbound-media" folder next to the session folders). The
 * Python gateway copies each outgoing attachment into that folder first, so
 * a caller can no longer ask the bridge to send e.g. the WhatsApp login
 * (session-x/creds.json) or ~/.git-credentials to any chat.
 *
 * Symlinks are resolved before the check, so a link inside the folder that
 * points outside it is refused.
 */

import path from 'node:path';
import { mkdirSync, realpathSync, statSync } from 'node:fs';

export function defaultOutboundMediaDir(sessionDir) {
  return path.join(path.dirname(path.resolve(sessionDir)), 'outbound-media');
}

export function ensureOutboundMediaDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return realpathSync(dir);
}

function isInside(child, root) {
  const rel = path.relative(root, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Return { ok: true, path } with the real path of an allowed regular file,
 * or { ok: false, status, error } explaining why it is refused.
 */
export function resolveAllowedMediaPath(filePath, allowedRoots) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) {
    return { ok: false, status: 400, error: 'filePath must be a non-empty string' };
  }
  if (!path.isAbsolute(filePath)) {
    return { ok: false, status: 400, error: 'filePath must be an absolute path' };
  }
  let real;
  try {
    real = realpathSync(filePath);
  } catch {
    return { ok: false, status: 404, error: `File not found: ${filePath}` };
  }
  let st;
  try {
    st = statSync(real);
  } catch {
    return { ok: false, status: 404, error: `File not found: ${filePath}` };
  }
  if (!st.isFile()) {
    return { ok: false, status: 400, error: 'filePath is not a regular file' };
  }
  for (const root of allowedRoots) {
    if (!root) continue;
    let realRoot;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    if (isInside(real, realRoot)) {
      return { ok: true, path: real };
    }
  }
  return {
    ok: false,
    status: 403,
    error: 'filePath is outside the bridge media folder; copy the file into outboundMediaDir (see GET /health) first',
  };
}
