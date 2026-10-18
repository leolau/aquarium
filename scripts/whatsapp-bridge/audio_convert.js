/**
 * Convert an audio file to ogg/opus with ffmpeg so WhatsApp shows a voice
 * bubble. ffmpeg is started directly with an argument list (no shell), so a
 * file name such as `a$(touch x).mp3` is just a file name.
 */

import { execFileSync } from 'node:child_process';

export function ffmpegOpusArgs(inputPath, outputPath) {
  return ['-y', '-i', inputPath, '-ar', '48000', '-ac', '1', '-c:a', 'libopus', outputPath];
}

export function convertToOpus(inputPath, outputPath, { execFile = execFileSync, timeout = 30000 } = {}) {
  execFile('ffmpeg', ffmpegOpusArgs(inputPath, outputPath), { timeout, stdio: 'pipe' });
}
