export default function ToolHome() {
  return (
    <main data-component="ToolHome" style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>{{name}}</h1>
      <p>In-house Hermes tool. Web UI on port {{port}}.</p>
      <p>The agent talks to this tool through its thin MCP server (mcp/server.mjs).</p>
    </main>
  );
}
