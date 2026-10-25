/**
 * /api/settings/apps/github — Settings -> GitHub token (FG-33 decision 14).
 * PUT {owner?, use_box_git?, token?}; DELETE forgets the token. The token is
 * write-only: responses carry only whether it is set and its last 4.
 */
import type { NextResponse } from "next/server";

import { canAdminister } from "@/lib/auth/roles";

import { badBody, forward, gate, readObject } from "../forward";

const PATH = "/api/quotas/github";

type GithubView = {
  owner?: string | null;
  use_box_git?: boolean;
  mode?: string;
  change_ref?: string;
  token?: { set?: boolean; last4?: string | null };
};

/** Rebuild the view field by field so nothing secret can ride along. */
export function safeGithubView(data: GithubView) {
  const set = data.token?.set === true;
  const last4 = set && typeof data.token?.last4 === "string" ? data.token.last4.slice(-4) : null;
  return {
    owner: typeof data.owner === "string" ? data.owner : null,
    use_box_git: data.use_box_git === true,
    mode: typeof data.mode === "string" ? data.mode : "local-only",
    token: { set, last4 },
    ...(typeof data.change_ref === "string" ? { change_ref: data.change_ref } : {}),
  };
}

export async function GET(): Promise<NextResponse> {
  const denied = await gate((p) => canAdminister(p));
  return denied ?? forward<GithubView>(PATH, "GET", undefined, safeGithubView);
}

export async function PUT(request: Request): Promise<NextResponse> {
  const denied = await gate((p) => canAdminister(p));
  if (denied) return denied;
  const body = await readObject(request);
  if (body instanceof Response) return body;
  const change: { owner?: string; use_box_git?: boolean; token?: string } = {};
  if (body.owner !== undefined) {
    if (typeof body.owner !== "string") return badBody("The GitHub account must be text.");
    change.owner = body.owner.trim();
  }
  if (body.use_box_git !== undefined) {
    if (typeof body.use_box_git !== "boolean") return badBody("use_box_git must be true or false.");
    change.use_box_git = body.use_box_git;
  }
  if (body.token !== undefined && body.token !== "") {
    if (typeof body.token !== "string") return badBody("The token must be text.");
    change.token = body.token.trim();
  }
  if (!Object.keys(change).length) return badBody("Nothing to change.");
  return forward<GithubView>(PATH, "PUT", change, safeGithubView);
}

export async function DELETE(): Promise<NextResponse> {
  const denied = await gate((p) => canAdminister(p));
  return denied ?? forward<GithubView>(PATH, "DELETE", undefined, safeGithubView);
}
