// Test-only: `node --import ./test_fixtures/register_fake_baileys.mjs bridge.js`
// swaps @whiskeysockets/baileys for a local fake so the real bridge HTTP
// server can be exercised without a WhatsApp account or network.
import { register } from 'node:module';

register('./fake_baileys_loader.mjs', import.meta.url);
