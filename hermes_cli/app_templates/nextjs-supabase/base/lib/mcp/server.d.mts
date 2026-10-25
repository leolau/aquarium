export declare const PROTOCOL_VERSIONS: string[];

export interface McpContext {
  /** Chat user forwarded by Aquarium (`_meta.aquarium_principal_user_id`), if any. */
  principal: string | null;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: McpContext) => unknown;
}

export declare function createMcpHandler(options: {
  name: string;
  version: string;
  token: () => string | undefined;
  tools: McpTool[];
}): (request: Request) => Promise<Response>;
