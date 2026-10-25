import { APP_NAME } from "@/app.config.mjs";
import pkg from "@/package.json";
import { secret } from "@/lib/env";
import { createMcpHandler } from "@/lib/mcp/server.mjs";
import { appTools } from "@/lib/mcp/tools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handler = createMcpHandler({
  name: APP_NAME,
  version: pkg.version,
  token: () => secret("APP_MCP_TOKEN"),
  tools: appTools,
});

export const POST = handler;
export const GET = handler;
export const DELETE = handler;
