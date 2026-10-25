import { readFileSync } from "node:fs";
import { join } from "node:path";

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Read a secret by name: the process environment first, then the systemd
 * credential file `$CREDENTIALS_DIRECTORY/<NAME>` that the Aquarium runtime
 * delivers with `LoadCredential=<NAME>:…`. Server-only; never log the value.
 */
export function secret(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
  if (!SECRET_NAME.test(name)) throw new Error(`invalid secret name: ${name}`);
  const direct = env[name];
  if (direct) return direct;
  const dir = env.CREDENTIALS_DIRECTORY;
  if (!dir) return undefined;
  try {
    const value = readFileSync(join(dir, name), "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}
