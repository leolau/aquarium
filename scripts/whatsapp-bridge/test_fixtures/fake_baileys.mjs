// Minimal stand-in for @whiskeysockets/baileys used by send_media.test.mjs.
// It "connects" immediately and appends one JSON line per sendMessage() call
// to $FAKE_BAILEYS_LOG instead of talking to WhatsApp.
import { appendFileSync } from 'node:fs';

export const DisconnectReason = { loggedOut: 401 };

export async function useMultiFileAuthState() {
  return { state: {}, saveCreds() {} };
}

export async function fetchLatestBaileysVersion() {
  return { version: [2, 3000, 0] };
}

export async function downloadMediaMessage() {
  return Buffer.alloc(0);
}

export function toNumber(value) {
  return Number(value);
}

export function makeWASocket() {
  const handlers = {};
  let counter = 0;
  const sock = {
    user: { id: '10000000000:1@s.whatsapp.net' },
    ev: {
      on(name, fn) {
        (handlers[name] ||= []).push(fn);
      },
    },
    async sendMessage(chatId, payload) {
      const record = { chatId };
      for (const [key, value] of Object.entries(payload)) {
        record[key] = Buffer.isBuffer(value) ? { bytes: value.toString('utf8') } : value;
      }
      appendFileSync(process.env.FAKE_BAILEYS_LOG, `${JSON.stringify(record)}\n`);
      counter += 1;
      return { key: { id: `FAKE${counter}` } };
    },
    async sendPresenceUpdate() {},
    async groupMetadata() {
      throw new Error('not a group');
    },
    async updateMediaMessage() {},
  };
  setTimeout(() => {
    for (const fn of handlers['connection.update'] || []) fn({ connection: 'open' });
  }, 20);
  return sock;
}
