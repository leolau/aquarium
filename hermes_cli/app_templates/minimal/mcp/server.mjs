#!/usr/bin/env node
// Thin MCP server for the "{{name}}" in-house tool.
// Line-delimited JSON-RPC 2.0 over stdio — no npm dependencies.
"use strict";

const TOOL_NAME = "{{name}}";

const TOOLS = [
  {
    name: "ping",
    description: "Health check for the " + TOOL_NAME + " in-house tool.",
    inputSchema: { type: "object", properties: {} },
  },
];

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function fail(id, code, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"
  );
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    respond(id, {
      protocolVersion: "2024-11-05",
      serverInfo: { name: TOOL_NAME, version: "0.1.0" },
      capabilities: { tools: {} },
    });
  } else if (method === "tools/list") {
    respond(id, { tools: TOOLS });
  } else if (method === "tools/call") {
    const name = params && params.name;
    if (name === "ping") {
      respond(id, {
        content: [{ type: "text", text: TOOL_NAME + " ok" }],
      });
    } else {
      fail(id, -32601, "Unknown tool: " + name);
    }
  } else if (method === "notifications/initialized") {
    // notification — no response
  } else if (id !== undefined) {
    fail(id, -32601, "Unknown method: " + method);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (err) {
      fail(null, -32700, "Parse error: " + err.message);
    }
  }
});
