// Dependency-free MCP server over Streamable HTTP (JSON responses, no SSE),
// served by the app's own Next.js process at /api/mcp. Plain ESM so
// `node --test` can exercise it without a build.
import { createHash, timingSafeEqual } from "node:crypto";

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

function reply(body, status = 200, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? headers : { ...JSON_HEADERS, ...headers },
  });
}

function rpcError(id, code, message, status = 200) {
  return reply({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function bearerMatches(header, expected) {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match) return false;
  return timingSafeEqual(digest(match[1].trim()), digest(expected));
}

function textResult(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

/**
 * @param {{
 *   name: string,
 *   version: string,
 *   token: () => string | undefined,
 *   tools: Array<{ name: string, description: string, inputSchema: object,
 *     annotations?: object, handler: (args: object, ctx: object) => unknown }>,
 * }} options
 * @returns {(request: Request) => Promise<Response>}
 */
export function createMcpHandler({ name, version, token, tools }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  return async function handle(request) {
    const expected = token();
    if (!expected) return reply({ error: "mcp token not configured" }, 503);
    if (!bearerMatches(request.headers.get("authorization"), expected)) {
      return reply({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
    }
    // The agent's MCP client sends no Origin; a browser page always does.
    if (request.headers.get("origin")) return reply({ error: "forbidden origin" }, 403);
    if (request.method !== "POST") return reply(null, 405, { allow: "POST" });

    let message;
    try {
      message = await request.json();
    } catch {
      return rpcError(null, -32700, "Parse error", 400);
    }
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
      return rpcError(null, -32600, "Invalid Request", 400);
    }
    const { id, method, params } = message;
    if (id === undefined || id === null) return reply(null, 202);

    if (method === "initialize") {
      const requested = params && params.protocolVersion;
      return reply({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
        },
      });
    }
    if (method === "ping") return reply({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") {
      const list = tools.map(({ name: toolName, description, inputSchema, annotations }) => ({
        name: toolName,
        description,
        inputSchema,
        ...(annotations ? { annotations } : {}),
      }));
      return reply({ jsonrpc: "2.0", id, result: { tools: list } });
    }
    if (method === "tools/call") {
      const tool = byName.get(params && params.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params && params.name}`);
      const meta = (params && params._meta) || {};
      const ctx = { principal: typeof meta.aquarium_principal_user_id === "string" ? meta.aquarium_principal_user_id : null };
      try {
        const value = await tool.handler((params && params.arguments) || {}, ctx);
        return reply({ jsonrpc: "2.0", id, result: textResult(value) });
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        return reply({ jsonrpc: "2.0", id, result: { ...textResult(text), isError: true } });
      }
    }
    return rpcError(id, -32601, `Unknown method: ${method}`);
  };
}
