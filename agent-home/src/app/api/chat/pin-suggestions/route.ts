/**
 * GET /api/chat/pin-suggestions?profile= — the agent's "worth pinning"
 * review of the caller's recent chats (`PinSuggestionsResponse`). Served from
 * a per-user cache upstream; `pending: true` means a fresh review is running
 * and a re-read shortly will have it.
 */
import { NextResponse } from "next/server";

import { withPinClient, unauthenticated } from "@/app/api/chat/pin-bff";
import { getPrincipal } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  return withPinClient(profileFromUrl(req.url), (client) => client.pinSuggestions());
}
