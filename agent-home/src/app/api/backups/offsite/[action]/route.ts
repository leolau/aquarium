/**
 * POST /api/backups/offsite/{test|run|restore-test} — owner only. `run` and
 * `restore-test` start a job on the server and return at once; the page polls
 * GET /api/backups/offsite for progress.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { requireMemberOwner } from "@/lib/api/member-bff";

const ACTIONS = new Set(["test", "run", "restore-test"]);

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ action: string }> },
): Promise<NextResponse> {
  const gate = await requireMemberOwner("Only the owner can manage backups.");
  if ("response" in gate) return gate.response;
  const { action } = await params;
  if (!ACTIONS.has(action)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  try {
    const result = await gate.client.offsiteBackupAction(
      action as "test" | "run" | "restore-test",
    );
    return NextResponse.json(result, { status: action === "test" ? 200 : 202 });
  } catch (err) {
    if (err instanceof HermesApiError) {
      return NextResponse.json(
        { error: "api_error", detail: err.message },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { error: "api_unreachable", detail: "The AI layer could not be reached." },
      { status: 502 },
    );
  }
}
