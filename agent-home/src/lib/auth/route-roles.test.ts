/**
 * Every BFF route under `src/app/api/**\/route.ts` says who may call it
 * (security review F2). `route-roles.json` maps "<METHOD> <route>" to:
 *
 * - `public`    — no sign-in (login, invitations, service worker, survey)
 * - `internal`  — called by the Python side with a shared secret
 * - `signed-in` — any signed-in user; the Python API scopes data to them
 * - `admin`     — owner or admin only (checked here, before proxying)
 * - `owner`     — owner only
 *
 * A new route (or a new method on an existing route) that is not in the table
 * fails this test, and a route labelled admin/owner must call the matching
 * check in its own handler body.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import table from "./route-roles.json";

type Role = "public" | "internal" | "signed-in" | "admin" | "owner";

const ROLE_CHECKS: Record<Role, string[]> = {
  public: [],
  internal: ["verifyAppPushSecret("],
  "signed-in": [
    "getPrincipal(",
    "requirePrincipal(",
    "apiClientForRequest(",
    "withPrincipal(",
    "requireEnrolled(",
  ],
  admin: ["canAdminister(", "canManageTools(", "requireMemberAdmin("],
  owner: ["requireMemberOwner("],
};

const API_DIR = join(__dirname, "..", "..", "app", "api");
const METHOD_RE =
  /export (?:async )?function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;

/** "<METHOD> /api/..." -> that handler's source, for one route file. */
export function handlersIn(route: string, source: string): Map<string, string> {
  const found = [...source.matchAll(METHOD_RE)];
  const out = new Map<string, string>();
  found.forEach((m, i) => {
    const end = i + 1 < found.length ? found[i + 1].index : source.length;
    out.set(`${m[1]} ${route}`, source.slice(m.index, end));
  });
  if (/export const (GET|POST|PUT|PATCH|DELETE)\b/.test(source)) {
    out.set(`UNPARSEABLE ${route}`, source);
  }
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(join(dir, e.name))
      : e.name === "route.ts"
        ? [join(dir, e.name)]
        : [],
  );
}

function allHandlers(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of walk(API_DIR)) {
    const rel = relative(API_DIR, file).split(sep).slice(0, -1).join("/");
    const route = rel ? `/api/${rel}` : "/api";
    for (const [k, v] of handlersIn(route, readFileSync(file, "utf8"))) {
      out.set(k, v);
    }
  }
  return out;
}

/** Problems with ``handlers`` against ``roles``; empty when all is declared. */
export function routeRoleProblems(
  handlers: Map<string, string>,
  roles: Record<string, string>,
): string[] {
  const problems: string[] = [];
  for (const [key, body] of handlers) {
    const role = roles[key] as Role | undefined;
    if (!role || !(role in ROLE_CHECKS)) {
      problems.push(`${key}: no role in route-roles.json`);
      continue;
    }
    const checks = ROLE_CHECKS[role];
    if (checks.length && !checks.some((c) => body.includes(c))) {
      problems.push(`${key}: labelled ${role} but calls none of ${checks.join(", ")}`);
    }
  }
  for (const key of Object.keys(roles)) {
    if (!handlers.has(key)) problems.push(`${key}: in route-roles.json but no such route`);
  }
  return problems;
}

const roles = table as Record<string, string>;

describe("agent-home BFF route roles", () => {
  it("every route.ts handler declares who may call it", () => {
    expect(routeRoleProblems(allHandlers(), roles)).toEqual([]);
  });

  it("fails for a new route with no role (proof the check is fail-closed)", () => {
    const handlers = allHandlers();
    handlers.set(
      "POST /api/brand-new-setting",
      "export async function POST() { return client.setEnvVar('K', 'V'); }",
    );
    expect(routeRoleProblems(handlers, roles)).toEqual([
      "POST /api/brand-new-setting: no role in route-roles.json",
    ]);
  });

  it("fails when an admin route loses its role check", () => {
    const handlers = new Map([
      [
        "POST /api/models/provider-key",
        "export async function POST() { const p = await getPrincipal(); }",
      ],
    ]);
    expect(
      routeRoleProblems(handlers, { "POST /api/models/provider-key": "admin" }),
    ).toEqual([
      "POST /api/models/provider-key: labelled admin but calls none of canAdminister(, canManageTools(, requireMemberAdmin(",
    ]);
  });

  it("keeps the settings that change the whole profile owner/admin only", () => {
    for (const key of [
      "POST /api/models/provider-key",
      "DELETE /api/models/provider-key",
      "POST /api/models/set",
      "POST /api/models/test",
      "DELETE /api/tools/mcp/[name]",
      "PUT /api/access/roles/[role]",
    ]) {
      expect(roles[key], key).toBe("admin");
    }
  });
});
