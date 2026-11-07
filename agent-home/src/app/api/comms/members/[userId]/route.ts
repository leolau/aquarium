/**
 * DELETE /api/comms/members/{userId} — remove an enrolment (owner/admin of the
 * named profile, their own enrolment included; Python refuses the profile
 * owner and the last live admin).
 *
 * `strategy=transfer|purge` is required rather than defaulted, because nothing
 * cascades from `principals` to memories, files or GTS items: without an answer
 * those rows survive with an `owner_user_id` no principal resolves — invisible
 * under C2 and unreachable from any surface. `transfer` also needs
 * `transfer_to`, the principal who inherits them.
 *
 * The box-wide GoTrue account is deliberately **not** deleted: it may serve
 * other profiles on the same Supabase, which is not this console's call.
 */
import { NextResponse } from "next/server";

import { forwardMemberError, requireMemberAdmin } from "@/lib/api/member-bff";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
): Promise<NextResponse> {
  const gate = await requireMemberAdmin(request);
  if ("response" in gate) return gate.response;
  const { userId } = await params;
  const search = new URL(request.url).searchParams;
  const strategy = (search.get("strategy") ?? "").trim();
  const transferTo = (search.get("transfer_to") ?? "").trim();
  if (strategy !== "transfer" && strategy !== "purge") {
    return NextResponse.json(
      {
        error: "invalid_input",
        detail:
          "strategy must be transfer or purge — say what happens to the rows " +
          "this user owns.",
      },
      { status: 400 },
    );
  }
  if (strategy === "transfer" && !transferTo) {
    return NextResponse.json(
      {
        error: "invalid_input",
        detail: "transfer_to is required — name who inherits this user's rows.",
      },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(
      await gate.client.deleteMember(userId, {
        strategy,
        transferTo: transferTo || undefined,
      }),
    );
  } catch (err) {
    return forwardMemberError(err);
  }
}
