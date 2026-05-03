import { describe, expect, it } from "vitest";
import { defaultInboundIdempotencyKey } from "./inbound.js";

describe("defaultInboundIdempotencyKey", () => {
  it("hashes the envelope when external id is missing", () => {
    const key = defaultInboundIdempotencyKey({
      agentName: "default",
      conversationId: "conv-1",
      envelope: {
        name: "text",
        content: [{ type: "text", text: "y".repeat(1000) }],
        properties: {},
        source: {
          connector: "programmatic",
          connectionName: "programmatic",
          receivedAt: "2026-05-03T00:00:00.000Z",
        },
      },
      source: {
        kind: "direct",
        connectionName: "programmatic",
        receivedAt: "2026-05-03T00:00:00.000Z",
      },
    });

    expect(key).toMatch(/^direct:programmatic:default:conv-1:text:[a-f0-9]{64}$/);
    expect(key).not.toContain("yyyy");
    expect(key.length).toBeLessThan(128);
  });
});
