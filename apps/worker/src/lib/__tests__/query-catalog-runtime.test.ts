import assert from "node:assert/strict";
import test from "node:test";
import { executeWorkerAgentTool } from "../agent-task-runtime.js";

test("executeWorkerAgentTool returns an error string for invalid query_performance args", async () => {
  const result = await executeWorkerAgentTool({
    tool: {
      status: "ready",
      tool: "query_performance",
      command: null,
      args: [],
      display: "performance query",
      why: "test",
      toolArgs: {
        accountId: "acc-1",
        level: "campaign",
        window: { preset: "last_7d" },
        metric: "cpa",
        limit: 99,
      },
    } as never,
    prisma: {} as never,
    workspaceId: "ws",
    boss: {} as never,
    webUrl: "http://127.0.0.1:3000",
  });
  assert.equal(result.status, "error");
  assert.match(result.message, /query_performance validation failed/);
  assert.match(result.message, /Number must be less than or equal to 20/);
});
