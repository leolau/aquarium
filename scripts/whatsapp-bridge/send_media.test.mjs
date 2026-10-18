/**
 * End-to-end test of POST /send-media on the real bridge.js HTTP server,
 * with Baileys replaced by test_fixtures/fake_baileys.mjs (no WhatsApp
 * account, nothing is sent) and a fake `ffmpeg` on PATH. Security review F8.
 *
 * Needs `npm ci` in scripts/whatsapp-bridge (express etc.); skipped otherwise.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HAS_DEPS = existsSync(path.join(HERE, 'node_modules', 'express'));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitConnected(base, child) {
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(`bridge exited with ${child.exitCode}`);
    try {
      const res = await fetch(`${base}/health`);
      const body = await res.json();
      if (body.status === 'connected') return body;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('bridge did not connect');
}

test('/send-media only sends files from the bridge media folder', { skip: !HAS_DEPS && 'run npm ci first' }, async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'wa-bridge-e2e-'));
  const sessionDir = path.join(base, 'whatsapp', 'session-test');
  mkdirSync(sessionDir, { recursive: true });
  const creds = path.join(sessionDir, 'creds.json');
  writeFileSync(creds, '{"noiseKey":"secret"}');
  const sendLog = path.join(base, 'sent.jsonl');
  writeFileSync(sendLog, '');

  const bin = path.join(base, 'bin');
  mkdirSync(bin);
  const ffmpegArgs = path.join(base, 'ffmpeg-args.txt');
  writeFileSync(path.join(bin, 'ffmpeg'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${ffmpegArgs}"\nfor last; do :; done\nprintf OggS > "$last"\n`);
  chmodSync(path.join(bin, 'ffmpeg'), 0o755);

  const port = await freePort();
  const child = spawn(
    process.execPath,
    ['--import', './test_fixtures/register_fake_baileys.mjs', 'bridge.js', '--port', String(port), '--session', sessionDir, '--mode', 'bot'],
    {
      cwd: HERE,
      env: { ...process.env, HOME: base, PATH: `${bin}:${process.env.PATH}`, FAKE_BAILEYS_LOG: sendLog, WHATSAPP_ALLOWED_USERS: '*' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  const url = `http://127.0.0.1:${port}`;
  const send = (body) => fetch(`${url}/send-media`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: '123@s.whatsapp.net', ...body }),
  });
  const sent = () => readFileSync(sendLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

  try {
    const health = await waitConnected(url, child);
    const mediaDir = path.join(base, 'whatsapp', 'outbound-media');
    assert.equal(health.outboundMediaDir, mediaDir, output);

    // 1. The WhatsApp login file is refused and nothing is sent.
    let res = await send({ filePath: creds, mediaType: 'document' });
    assert.equal(res.status, 403);
    res = await send({ filePath: path.join(mediaDir, '..', 'session-test', 'creds.json') });
    assert.equal(res.status, 403);
    symlinkSync(creds, path.join(mediaDir, 'sneaky.pdf'));
    res = await send({ filePath: path.join(mediaDir, 'sneaky.pdf') });
    assert.equal(res.status, 403);
    assert.deepEqual(sent(), []);

    // 2. A file the gateway staged in the media folder is sent.
    const report = path.join(mediaDir, 'out_ab12.pdf');
    writeFileSync(report, 'PDF');
    res = await send({ filePath: report, mediaType: 'document', fileName: 'report.pdf' });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(sent().at(-1), {
      chatId: '123@s.whatsapp.net', document: { bytes: 'PDF' }, fileName: 'report.pdf', mimetype: 'application/pdf',
    });

    // 3. Voice note conversion: a shell-looking file name stays a file name.
    // A shell would run `touch PWNED` in the bridge's working directory.
    const pwned = path.join(HERE, 'PWNED');
    rmSync(pwned, { force: true });
    const voice = path.join(mediaDir, 'v$(touch PWNED)`touch PWNED`.mp3');
    writeFileSync(voice, 'mp3');
    res = await send({ filePath: voice, mediaType: 'audio' });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(existsSync(pwned), false, 'file name was run as a shell command');
    assert.equal(readFileSync(ffmpegArgs, 'utf8').split('\n')[2], voice);
    const last = sent().at(-1);
    assert.equal(last.ptt, true);
    assert.deepEqual(last.audio, { bytes: 'OggS' });
  } finally {
    child.kill('SIGTERM');
    rmSync(path.join(HERE, 'PWNED'), { force: true });
    rmSync(base, { recursive: true, force: true });
  }
});
