/**
 * Unit tests for the /send-media path allowlist and the ffmpeg call
 * (security review F8). Run: node --test scripts/whatsapp-bridge/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defaultOutboundMediaDir, ensureOutboundMediaDir, resolveAllowedMediaPath } from './media_paths.js';
import { convertToOpus, ffmpegOpusArgs } from './audio_convert.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function tmp() {
  return mkdtempSync(path.join(os.tmpdir(), 'wa-media-'));
}

test('outbound media folder sits next to the session folders', () => {
  assert.equal(
    defaultOutboundMediaDir('/opt/data/hermes-home-staging/whatsapp/session-connectar'),
    '/opt/data/hermes-home-staging/whatsapp/outbound-media',
  );
});

test('only files inside the allowed folder are accepted', () => {
  const base = tmp();
  try {
    const media = ensureOutboundMediaDir(path.join(base, 'outbound-media'));
    const inside = path.join(media, 'out_1.png');
    writeFileSync(inside, 'png');
    const session = path.join(base, 'session-x');
    mkdirSync(session);
    const creds = path.join(session, 'creds.json');
    writeFileSync(creds, '{"secret":1}');

    assert.deepEqual(resolveAllowedMediaPath(inside, [media]), { ok: true, path: inside });

    const outside = resolveAllowedMediaPath(creds, [media]);
    assert.equal(outside.ok, false);
    assert.equal(outside.status, 403);

    const traversal = resolveAllowedMediaPath(path.join(media, '..', 'session-x', 'creds.json'), [media]);
    assert.equal(traversal.status, 403);

    const link = path.join(media, 'link.png');
    symlinkSync(creds, link);
    assert.equal(resolveAllowedMediaPath(link, [media]).status, 403);

    assert.equal(resolveAllowedMediaPath(media, [media]).ok, false);
    assert.equal(resolveAllowedMediaPath('relative.png', [media]).status, 400);
    assert.equal(resolveAllowedMediaPath(path.join(media, 'missing.png'), [media]).status, 404);
    assert.equal(resolveAllowedMediaPath(inside, [path.join(base, 'does-not-exist')]).status, 403);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ffmpeg gets the file name as one argument, never through a shell', () => {
  const base = tmp();
  try {
    const bin = path.join(base, 'bin');
    mkdirSync(bin);
    const argsLog = path.join(base, 'ffmpeg-args.txt');
    const fake = path.join(bin, 'ffmpeg');
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsLog}"\nfor last; do :; done\nprintf OggS > "$last"\n`);
    chmodSync(fake, 0o755);

    // Relative `touch PWNED` lands in the working directory, set to base below.
    const pwned = path.join(base, 'PWNED');
    const input = path.join(base, 'voice$(touch PWNED)`touch PWNED`.mp3');
    writeFileSync(input, 'mp3');
    const output = path.join(base, 'out.ogg');

    const oldPath = process.env.PATH;
    const oldCwd = process.cwd();
    process.env.PATH = `${bin}:${oldPath}`;
    process.chdir(base);
    try {
      convertToOpus(input, output);
    } finally {
      process.env.PATH = oldPath;
      process.chdir(oldCwd);
    }

    assert.equal(existsSync(pwned), false, 'file name was run as a shell command');
    assert.deepEqual(readFileSync(argsLog, 'utf8').trimEnd().split('\n'), ffmpegOpusArgs(input, output));
    assert.equal(readFileSync(output, 'utf8'), 'OggS');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('no bridge module starts programs through a shell', () => {
  for (const name of readdirSync(HERE).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(path.join(HERE, name), 'utf8');
    assert.doesNotMatch(src, /\bexecSync\s*\(|\bexec\s*\(|shell\s*:\s*true/, `${name} uses a shell`);
    assert.doesNotMatch(src, /import\s*\{[^}]*\b(exec|execSync)\b[^}]*\}\s*from\s*['"](node:)?child_process['"]/, name);
  }
});
