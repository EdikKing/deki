import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "deki-test-server",
  version: "0.0.0",
});

server.registerTool(
  "echo",
  {
    description: "Echo test input",
    inputSchema: {
      text: z.string(),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ text }) => ({
    content: [{ type: "text", text }],
  }),
);

server.registerTool(
  "fail",
  {
    description: "Return a controlled error",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text", text: "controlled failure" }],
    isError: true,
  }),
);

server.registerTool(
  "slow",
  {
    description: "Wait before responding",
    inputSchema: {
      milliseconds: z.number().int().min(1).max(10_000),
    },
  },
  async ({ milliseconds }, { signal }) => {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, milliseconds);
      signal?.addEventListener("abort", () => {
        clearTimeout(timeout);
        reject(new Error("aborted"));
      }, { once: true });
    });
    return { content: [{ type: "text", text: "done" }] };
  },
);

server.registerTool(
  "crash",
  {
    description: "Exit the fixture process immediately",
    inputSchema: {},
  },
  async () => {
    process.exit(23);
  },
);

await server.connect(new StdioServerTransport());
