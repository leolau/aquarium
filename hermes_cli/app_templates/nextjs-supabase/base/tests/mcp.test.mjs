// MCP handshake against the app's /api/mcp handler (mirrors the Python
// FG-07 handshake test). Runs with plain `node --test`, no build needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMcpHandler } from "../lib/mcp/server.mjs";

const TOKEN = "test-token";
const handler = createMcpHandler({
  name: "demo",
  version: "0.1.0",
  token: () => TOKEN,
  tools: [
    {
      name: "app_info",
      description: "info",
      inputSchema: { type: "object", properties: {} },
      handler: (_args, ctx) => ({ name: "demo", principal: ctx.principal }),
    },
  ],
});

function call(body, { token = TOKEN, method = "POST", headers = {} } = {}) {
  return handler(
    new Request("http://127.0.0.1/api/mcp", {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    }),
  );
}

test("initialize -> tools/list -> tools/call", async () => {
  const init = await (await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).json();
  assert.equal(init.result.serverInfo.name, "demo");
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.ok(init.result.capabilities.tools);

  const note = await call({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(note.status, 202);

  const list = await (await call({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  assert.deepEqual(list.result.tools.map((t) => t.name), ["app_info"]);

  const result = await (
    await call({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "app_info", arguments: {}, _meta: { aquarium_principal_user_id: "u_1" } },
    })
  ).json();
  assert.deepEqual(JSON.parse(result.result.content[0].text), { name: "demo", principal: "u_1" });
});

test("refuses callers without the bearer token", async () => {
  const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  assert.equal((await call(body, { token: null })).status, 401);
  assert.equal((await call(body, { token: "wrong" })).status, 401);
});

test("refuses browser requests even with the token", async () => {
  const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { headers: { origin: "https://example.com" } });
  assert.equal(res.status, 403);
});

test("fails closed when no token is configured", async () => {
  const open = createMcpHandler({ name: "x", version: "0", token: () => undefined, tools: [] });
  const res = await open(new Request("http://127.0.0.1/api/mcp", { method: "POST", body: "{}" }));
  assert.equal(res.status, 503);
});

test("only POST carries messages", async () => {
  assert.equal((await call(null, { method: "GET" })).status, 405);
});
