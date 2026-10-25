/** /api/tools/apps/[name]/egress — PUT {hosts}: the hosts the app may call out to. */
import { NextResponse } from "next/server";

import { withPrincipal } from "@/app/api/projects/hermes-bridge";
import { appCall, badRequest, toolPath, type AppCtx } from "@/app/api/tools/apps/bridge";

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const EGRESS_MAX_HOSTS = 20;

export async function PUT(request: Request, ctx: AppCtx): Promise<NextResponse> {
  const call = await appCall(request, ctx);
  if (call instanceof NextResponse) return call;
  const { hosts } = call.body;
  if (
    !Array.isArray(hosts) ||
    hosts.length > EGRESS_MAX_HOSTS ||
    !hosts.every((h) => typeof h === "string" && HOST_RE.test(h))
  ) {
    return badRequest(
      "bad_hosts",
      `hosts must be up to ${EGRESS_MAX_HOSTS} lower-case host names (no IPs, ports or paths)`,
    );
  }
  return withPrincipal((client) =>
    client.request(toolPath(call.name, "/egress"), {
      method: "PUT",
      json: { hosts: [...new Set(hosts as string[])], mode: call.mode },
    }),
  );
}
