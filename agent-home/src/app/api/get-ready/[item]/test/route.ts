/**
 * /api/get-ready/[item]/test — run one checklist item's live check. The
 * Python side 403s install-wide items for members and viewers.
 */
import type { NextResponse } from "next/server";

import { apiClientForRequest } from "@/lib/auth/principal";

import { forward } from "../../_forward";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ item: string }> },
): Promise<NextResponse> {
  const { item } = await params;
  return forward(async () => (await apiClientForRequest()).getReadyTest(item));
}
