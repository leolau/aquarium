/**
 * POST /api/comms/members/{userId}/channels — map an inbound channel handle
 * (`telegram:12345`) onto an enrolled user (owner/admin).
 *
 * This is what makes a message arriving from a messaging platform resolve to a
 * principal instead of an anonymous sender, so it is the difference between the
 * gateway attributing work to somebody and not. Body:
 * `{ platform, channel_user_id }`.
 *
 * DELETE …/channels?platform=&channel_user_id= — the inverse: the handle goes
 * back to resolving as an anonymous sender; the member is untouched.
 */
import { NextResponse } from "next/server";

import { forwardMemberError, requireMemberAdmin } from "@/lib/api/member-bff";

interface ChannelBody {
  platform?: unknown;
  channel_user_id?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
): Promise<NextResponse> {
  const gate = await requireMemberAdmin(request);
  if ("response" in gate) return gate.response;
  const { userId } = await params;
  let body: ChannelBody;
  try {
    body = (await request.json()) as ChannelBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const platform = typeof body.platform === "string" ? body.platform.trim() : "";
  const channelUserId =
    typeof body.channel_user_id === "string" ? body.channel_user_id.trim() : "";
  if (!platform || !channelUserId) {
    return NextResponse.json(
      {
        error: "invalid_input",
        detail: "Both a platform and a channel user id are required.",
      },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(
      await gate.client.linkMemberChannel(userId, {
        platform,
        channel_user_id: channelUserId,
      }),
    );
  } catch (err) {
    return forwardMemberError(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
): Promise<NextResponse> {
  const gate = await requireMemberAdmin(request);
  if ("response" in gate) return gate.response;
  const { userId } = await params;
  const query = new URL(request.url).searchParams;
  const platform = (query.get("platform") ?? "").trim();
  const channelUserId = (query.get("channel_user_id") ?? "").trim();
  if (!platform || !channelUserId) {
    return NextResponse.json(
      {
        error: "invalid_input",
        detail: "Both a platform and a channel user id are required.",
      },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(
      await gate.client.unlinkMemberChannel(userId, {
        platform,
        channel_user_id: channelUserId,
      }),
    );
  } catch (err) {
    return forwardMemberError(err);
  }
}
