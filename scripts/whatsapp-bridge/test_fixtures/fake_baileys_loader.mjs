const FAKE = new URL('./fake_baileys.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === '@whiskeysockets/baileys') {
    return { url: FAKE, shortCircuit: true };
  }
  return next(specifier, context);
}
