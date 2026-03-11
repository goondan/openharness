import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { runTurnMock } = vi.hoisted(() => ({
  runTurnMock: vi.fn(),
}));

vi.mock("../../engine/run-turn.js", () => ({
  runTurn: runTurnMock,
}));

import { createHarnessRuntimeFromYaml, createRunnerFromHarnessYaml } from "./runner.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function readWorkspaceRuntimeEvents(stateRoot: string): Promise<Array<Record<string, unknown>>> {
  const workspacesRoot = path.join(stateRoot, "workspaces");
  const workspaceIds = await fs.readdir(workspacesRoot);
  const workspaceId = workspaceIds[0];
  if (!workspaceId) {
    return [];
  }

  const eventsPath = path.join(workspacesRoot, workspaceId, "runtime-events.jsonl");
  const raw = await fs.readFile(eventsPath, "utf8");

  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForAssertion(assertion: () => void | Promise<void>, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function createHarnessYaml(input: {
  agentExtensions?: string[];
  agentTools?: string[];
  availableExtensions?: string[];
  availableTools?: Array<{
    name: string;
    entry: string;
    exportName?: string;
    labels?: Record<string, string>;
  }>;
  connectionExtensions?: string[];
  includeEmptyAgentExtensions?: boolean;
  includeEmptyAgentTools?: boolean;
  connectorEntry: string;
  connectionIngress: string[];
  promptSystem?: string;
}): string {
  const extensionNames = [
    ...new Set([...(input.availableExtensions ?? []), ...(input.agentExtensions ?? []), ...(input.connectionExtensions ?? [])]),
  ];
  const extensionDocs = extensionNames
    .map((name) =>
      [
        "---",
        "apiVersion: goondan.ai/v1",
        "kind: Extension",
        "metadata:",
        `  name: ${name}`,
        "spec:",
        `  entry: ./${name}.js`,
      ].join("\n"),
    )
    .join("\n");
  const toolDocs = (input.availableTools ?? [])
    .map((tool) => {
      const labelLines = Object.entries(tool.labels ?? {}).map(([key, value]) => `    ${key}: ${value}`);
      return [
        "---",
        "apiVersion: goondan.ai/v1",
        "kind: Tool",
        "metadata:",
        `  name: ${tool.name}`,
        ...(labelLines.length > 0 ? ["  labels:", ...labelLines] : []),
        "spec:",
        `  entry: ./${tool.entry}`,
        "  exports:",
        `    - name: ${tool.exportName ?? "run"}`,
        "      description: test tool",
        "      parameters:",
        "        type: object",
        "        properties: {}",
        "        additionalProperties: false",
      ].join("\n");
    })
    .join("\n");

  const agentExtensionBlock =
    input.includeEmptyAgentExtensions
      ? "  extensions: []"
      : input.agentExtensions && input.agentExtensions.length > 0
      ? ["  extensions:", ...input.agentExtensions.map((name) => `    - Extension/${name}`)].join("\n")
      : "";
  const agentToolBlock =
    input.includeEmptyAgentTools
      ? "  tools: []"
      : input.agentTools && input.agentTools.length > 0
        ? ["  tools:", ...input.agentTools.map((name) => `    - Tool/${name}`)].join("\n")
        : "";
  const connectionExtensionBlock =
    input.connectionExtensions && input.connectionExtensions.length > 0
      ? ["  extensions:", ...input.connectionExtensions.map((name) => `    - Extension/${name}`)].join("\n")
      : "";
  const promptBlock =
    typeof input.promptSystem === "string" && input.promptSystem.length > 0
      ? ["  prompt:", `    system: ${JSON.stringify(input.promptSystem)}`].join("\n")
      : "";

  return [
    "apiVersion: goondan.ai/v1",
    "kind: Model",
    "metadata:",
    "  name: test-model",
    "spec:",
    "  provider: openai",
    "  model: gpt-4.1-mini",
    "  apiKey:",
    "    valueFrom:",
    "      env: OPENAI_API_KEY",
    "---",
    "apiVersion: goondan.ai/v1",
    "kind: Agent",
    "metadata:",
    "  name: assistant",
    "spec:",
    "  modelConfig:",
    "    modelRef: Model/test-model",
    agentToolBlock,
    agentExtensionBlock,
    promptBlock,
    toolDocs,
    "---",
    "apiVersion: goondan.ai/v1",
    "kind: Connector",
    "metadata:",
    "  name: slack",
    "spec:",
    `  entry: ./${input.connectorEntry}`,
    "  events:",
    "    - name: slack.message",
    extensionDocs,
    "---",
    "apiVersion: goondan.ai/v1",
    "kind: Connection",
    "metadata:",
    "  name: slack-main",
    "spec:",
    "  connectorRef: Connector/slack",
    connectionExtensionBlock,
    "  ingress:",
    "    rules:",
    ...input.connectionIngress.map((line) => `      ${line}`),
    "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

describe("createHarnessRuntimeFromYaml ingress", () => {
  let tempDir: string;
  let stateRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openharness-runner-test-"));
    stateRoot = path.join(tempDir, ".state");
    runTurnMock.mockReset();
  });

  it("fan-out ingress를 accepted handle로 즉시 반환하고 route/dispatch 훅을 적용한다", async () => {
    await writeText(
      path.join(tempDir, "connector.js"),
      [
        "export default {",
        "  async normalize(ctx) {",
        "    return [",
        "      {",
        "        name: 'slack.message',",
        "        content: [{ type: 'text', text: 'hello from slack' }],",
        "        properties: { route: 'primary', threadTs: 't-1', channelId: 'C1' },",
        "        source: { kind: 'connector', name: 'slack' },",
        "        rawPayload: ctx.payload,",
        "      },",
        "      {",
        "        name: 'slack.message',",
        "        content: [{ type: 'file', url: 'https://example.com/report.pdf', name: 'report.pdf', mimeType: 'application/pdf' }],",
        "        properties: { route: 'secondary', threadTs: 't-2', channelId: 'C2' },",
        "        source: { kind: 'connector', name: 'slack' },",
        "        rawPayload: ctx.payload,",
        "      },",
        "    ];",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    await writeText(
      path.join(tempDir, "connection-hooks.js"),
      [
        "export async function register(api) {",
        "  api.ingress.register('verify', async (ctx) => {",
        "    if (!ctx.payload || typeof ctx.payload !== 'object' || !('deliveryId' in ctx.payload)) {",
        "      throw new Error('missing deliveryId');",
        "    }",
        "    await ctx.next();",
        "  });",
        "  api.ingress.register('normalize', async (ctx) => {",
        "    const next = await ctx.next();",
        "    return next.map((event) => ({",
        "      ...event,",
        "      properties: {",
        "        ...event.properties,",
        "        connectionHook: 'normalized',",
        "      },",
        "    }));",
        "  });",
        "}",
        "",
      ].join("\n"),
    );

    await writeText(
      path.join(tempDir, "agent-hooks.js"),
      [
        "export async function register(api) {",
        "  api.ingress.register('route', async (ctx) => {",
        "    const next = await ctx.next();",
        "    return { ...next, conversationId: `${next.conversationId}:hooked` };",
        "  });",
        "  api.ingress.register('dispatch', async (ctx) => {",
        "    ctx.plan.runtime.inbound.properties.dispatchHook = 'enabled';",
        "    return ctx.next();",
        "  });",
        "}",
        "",
      ].join("\n"),
    );

    await writeText(
      path.join(tempDir, "harness.yaml"),
      createHarnessYaml({
        agentExtensions: ["agent-hooks"],
        connectionExtensions: ["connection-hooks"],
        connectorEntry: "connector.js",
        connectionIngress: [
          "- match:",
          "    event: slack.message",
          "    properties:",
          "      route: primary",
          "  route:",
          "    agentRef: Agent/assistant",
          "    conversationIdProperty: threadTs",
          "    conversationIdPrefix: \"slack:\"",
          "- match:",
          "    event: slack.message",
          "  route:",
          "    agentRef: Agent/assistant",
          "    conversationId: fallback",
        ],
      }),
    );

    const gate = createDeferred<void>();
    runTurnMock.mockImplementation(async (input) => {
      await gate.promise;
      return {
        turnResult: {
          turnId: input.turnId,
          finishReason: "text_response",
        },
        finalResponseText: `ok:${input.conversationId}`,
        stepCount: 1,
      };
    });

    const runtime = await createHarnessRuntimeFromYaml({
      workdir: tempDir,
      stateRoot,
      env: {
        OPENAI_API_KEY: "test-key",
      },
    });

    try {
      expect(runtime.ingress.listConnections()).toEqual([
        {
          connectionName: "slack-main",
          connectorName: "slack",
          ruleCount: 2,
        },
      ]);

      const accepted = await runtime.ingress.receive({
        connectionName: "slack-main",
        payload: {
          deliveryId: "raw-1",
        },
        receivedAt: "2026-03-10T12:00:00.000Z",
      });

      expect(accepted).toHaveLength(2);
      expect(accepted.map((item) => item.accepted)).toEqual([true, true]);
      expect(accepted.map((item) => item.conversationId)).toEqual(["slack:t-1:hooked", "fallback:hooked"]);
      expect(accepted.map((item) => item.agentName)).toEqual(["assistant", "assistant"]);
      expect(new Set(accepted.map((item) => item.eventId)).size).toBe(2);

      await waitForAssertion(() => {
        expect(runTurnMock).toHaveBeenCalledTimes(2);
      });

      const calls = runTurnMock.mock.calls.map((args) => args[0] as Record<string, any>);
      const primaryCall = calls.find((input) => input.inputEvent.properties?.route === "primary");
      const fallbackCall = calls.find((input) => input.inputEvent.properties?.route === "secondary");

      expect(primaryCall?.conversationId).toBe("slack:t-1:hooked");
      expect(primaryCall?.inputEvent.input).toBe("hello from slack");
      expect(primaryCall?.runtime.inbound.properties).toMatchObject({
        route: "primary",
        threadTs: "t-1",
        channelId: "C1",
        connectionHook: "normalized",
        dispatchHook: "enabled",
      });
      expect(primaryCall?.runtime.inbound.rawPayload).toEqual({
        deliveryId: "raw-1",
      });

      expect(fallbackCall?.conversationId).toBe("fallback:hooked");
      expect(fallbackCall?.inputEvent.input).toBeUndefined();
      expect(fallbackCall?.runtime.inbound.properties).toMatchObject({
        connectionHook: "normalized",
        dispatchHook: "enabled",
      });
      expect(fallbackCall?.runtime.inbound.content).toEqual([
        {
          type: "file",
          url: "https://example.com/report.pdf",
          name: "report.pdf",
          mimeType: "application/pdf",
        },
      ]);

      await waitForAssertion(async () => {
        const events = await readWorkspaceRuntimeEvents(stateRoot);
        const types = events.map((event) => event.type);
        expect(types.filter((type) => type === "ingress.received")).toHaveLength(3);
        expect(types.filter((type) => type === "ingress.accepted")).toHaveLength(2);
      });
    } finally {
      gate.resolve();
      await runtime.close();
    }
  });

  it("verify 실패 시 turn을 만들지 않고 ingress.rejected만 남긴다", async () => {
    await writeText(
      path.join(tempDir, "connector.js"),
      [
        "export default {",
        "  async verify() {",
        "    const error = new Error('invalid signature');",
        "    error.code = 'E_BAD_SIGNATURE';",
        "    throw error;",
        "  },",
        "  async normalize() {",
        "    return {",
        "      name: 'slack.message',",
        "      content: [{ type: 'text', text: 'hello' }],",
        "      properties: {},",
        "      source: { kind: 'connector', name: 'slack' },",
        "    };",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    await writeText(
      path.join(tempDir, "harness.yaml"),
      createHarnessYaml({
        connectorEntry: "connector.js",
        connectionIngress: [
          "- match:",
          "    event: slack.message",
          "  route:",
          "    agentRef: Agent/assistant",
          "    conversationId: verify-failed",
        ],
      }),
    );

    const runtime = await createHarnessRuntimeFromYaml({
      workdir: tempDir,
      stateRoot,
      env: {
        OPENAI_API_KEY: "test-key",
      },
    });

    try {
      await expect(
        runtime.ingress.receive({
          connectionName: "slack-main",
          payload: { deliveryId: "raw-verify" },
        }),
      ).rejects.toThrow("invalid signature");

      expect(runTurnMock).not.toHaveBeenCalled();

      await waitForAssertion(async () => {
        const events = await readWorkspaceRuntimeEvents(stateRoot);
        const received = events.filter((event) => event.type === "ingress.received");
        const rejected = events.filter((event) => event.type === "ingress.rejected");
        const accepted = events.filter((event) => event.type === "ingress.accepted");

        expect(received).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(accepted).toHaveLength(0);
        expect(rejected[0]?.errorMessage).toBe("invalid signature");
        expect(rejected[0]?.errorCode).toBe("E_BAD_SIGNATURE");
      });
    } finally {
      await runtime.close();
    }
  });

  it("dispatch route 단계에서 conversationId를 못 찾으면 ingress.rejected를 남긴다", async () => {
    await writeText(
      path.join(tempDir, "connector.js"),
      [
        "export default {",
        "  async normalize() {",
        "    return {",
        "      name: 'slack.message',",
        "      content: [{ type: 'text', text: 'hello' }],",
        "      properties: {},",
        "      source: { kind: 'connector', name: 'slack' },",
        "    };",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    await writeText(
      path.join(tempDir, "harness.yaml"),
      createHarnessYaml({
        connectorEntry: "connector.js",
        connectionIngress: [
          "- match:",
          "    event: slack.message",
          "  route:",
          "    agentRef: Agent/assistant",
        ],
      }),
    );

    const runtime = await createHarnessRuntimeFromYaml({
      workdir: tempDir,
      stateRoot,
      env: {
        OPENAI_API_KEY: "test-key",
      },
    });

    try {
      await expect(
        runtime.ingress.dispatch({
          connectionName: "slack-main",
          event: {
            name: "slack.message",
            content: [{ type: "text", text: "hello" }],
            properties: {},
            source: { kind: "connector", name: "slack" },
          },
        }),
      ).rejects.toThrow(/conversationId/);

      expect(runTurnMock).not.toHaveBeenCalled();

      await waitForAssertion(async () => {
        const events = await readWorkspaceRuntimeEvents(stateRoot);
        const received = events.filter((event) => event.type === "ingress.received");
        const rejected = events.filter((event) => event.type === "ingress.rejected");

        expect(received).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]?.eventName).toBe("slack.message");
      });
    } finally {
      await runtime.close();
    }
  });

  it("agent tools/extensions를 생략하면 로드된 리소스를 자동 활성화하지 않는다", async () => {
    await writeText(
      path.join(tempDir, "connector.js"),
      [
        "export default {",
        "  async normalize() {",
        "    return {",
        "      name: 'slack.message',",
        "      content: [{ type: 'text', text: 'hello' }],",
        "      properties: {},",
        "      source: { kind: 'connector', name: 'slack' },",
        "    };",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await writeText(
      path.join(tempDir, "implicit-extension.js"),
      [
        "export async function register(api) {",
        "  api.pipeline.register('turn', async (ctx) => {",
        "    ctx.metadata.autoLoaded = true;",
        "    return ctx.next();",
        "  });",
        "}",
        "",
      ].join("\n"),
    );
    await writeText(
      path.join(tempDir, "implicit-tool.js"),
      [
        "export async function run() {",
        "  return 'implicit';",
        "}",
        "",
      ].join("\n"),
    );
    await writeText(
      path.join(tempDir, "harness.yaml"),
      createHarnessYaml({
        availableExtensions: ["implicit-extension"],
        availableTools: [
          {
            name: "implicit-tool",
            entry: "implicit-tool.js",
            labels: { tier: "base" },
          },
        ],
        connectorEntry: "connector.js",
        connectionIngress: [
          "- match:",
          "    event: slack.message",
          "  route:",
          "    agentRef: Agent/assistant",
          "    conversationId: assistant",
        ],
        promptSystem: "system prompt",
      }),
    );

    let observed: {
      metadata: Record<string, unknown>;
      messages: unknown[];
      promptSystem?: string;
    } | null = null;

    runTurnMock.mockImplementation(async (input: Record<string, any>) => {
      const turnResult = await input.pipelineRegistry.runTurn(
        {
          agentName: input.agentName,
          conversationId: input.conversationId,
          turnId: input.turnId,
          traceId: input.traceId,
          inputEvent: input.inputEvent,
          conversationState: input.conversationState,
          runtime: input.runtime,
          emitMessageEvent(event: Record<string, unknown>) {
            input.conversationState.emitMessageEvent(event);
          },
          metadata: {},
          abortSignal: input.abortSignal,
        },
        async (ctx: Record<string, any>) => {
          observed = {
            metadata: { ...ctx.metadata },
            messages: [...input.conversationState.nextMessages],
            promptSystem: ctx.runtime.agent.prompt?.system,
          };
          return {
            turnId: input.turnId,
            finishReason: "text_response",
          };
        },
      );

      return {
        turnResult,
        finalResponseText: "",
        stepCount: 0,
      };
    });

    const runtime = await createHarnessRuntimeFromYaml({
      workdir: tempDir,
      stateRoot,
      env: {
        OPENAI_API_KEY: "test-key",
      },
    });

    try {
      await runtime.processTurn("명시적 선택만 사용");

      expect(runTurnMock).toHaveBeenCalledTimes(1);
      const runTurnInput = runTurnMock.mock.calls[0]?.[0] as Record<string, any>;
      expect(runTurnInput.baseToolCatalog).toEqual([]);
      expect(runTurnInput.extensionToolRegistry.getCatalog()).toEqual([]);
      expect(observed).toEqual({
        metadata: {},
        messages: [],
        promptSystem: "system prompt",
      });
    } finally {
      await runtime.close();
    }
  });

  it("agent tools/extensions가 빈 배열이면 자동 기본값을 주입하지 않는다", async () => {
    await writeText(
      path.join(tempDir, "connector.js"),
      [
        "export default {",
        "  async normalize() {",
        "    return {",
        "      name: 'slack.message',",
        "      content: [{ type: 'text', text: 'hello' }],",
        "      properties: {},",
        "      source: { kind: 'connector', name: 'slack' },",
        "    };",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await writeText(
      path.join(tempDir, "implicit-extension.js"),
      [
        "export async function register(api) {",
        "  api.pipeline.register('turn', async (ctx) => {",
        "    ctx.metadata.autoLoaded = true;",
        "    return ctx.next();",
        "  });",
        "}",
        "",
      ].join("\n"),
    );
    await writeText(
      path.join(tempDir, "implicit-tool.js"),
      [
        "export async function run() {",
        "  return 'implicit';",
        "}",
        "",
      ].join("\n"),
    );
    await writeText(
      path.join(tempDir, "harness.yaml"),
      createHarnessYaml({
        availableExtensions: ["implicit-extension"],
        availableTools: [
          {
            name: "implicit-tool",
            entry: "implicit-tool.js",
            labels: { tier: "base" },
          },
        ],
        includeEmptyAgentExtensions: true,
        includeEmptyAgentTools: true,
        connectorEntry: "connector.js",
        connectionIngress: [
          "- match:",
          "    event: slack.message",
          "  route:",
          "    agentRef: Agent/assistant",
          "    conversationId: assistant",
        ],
        promptSystem: "system prompt",
      }),
    );

    let observedMetadata: Record<string, unknown> | null = null;

    runTurnMock.mockImplementation(async (input: Record<string, any>) => {
      const turnResult = await input.pipelineRegistry.runTurn(
        {
          agentName: input.agentName,
          conversationId: input.conversationId,
          turnId: input.turnId,
          traceId: input.traceId,
          inputEvent: input.inputEvent,
          conversationState: input.conversationState,
          runtime: input.runtime,
          emitMessageEvent(event: Record<string, unknown>) {
            input.conversationState.emitMessageEvent(event);
          },
          metadata: {},
          abortSignal: input.abortSignal,
        },
        async (ctx: Record<string, any>) => {
          observedMetadata = { ...ctx.metadata };
          return {
            turnId: input.turnId,
            finishReason: "text_response",
          };
        },
      );

      return {
        turnResult,
        finalResponseText: "",
        stepCount: 0,
      };
    });

    const runtime = await createHarnessRuntimeFromYaml({
      workdir: tempDir,
      stateRoot,
      env: {
        OPENAI_API_KEY: "test-key",
      },
    });

    try {
      await runtime.processTurn("빈 배열도 자동 주입 금지");

      expect(runTurnMock).toHaveBeenCalledTimes(1);
      const runTurnInput = runTurnMock.mock.calls[0]?.[0] as Record<string, any>;
      expect(runTurnInput.baseToolCatalog).toEqual([]);
      expect(runTurnInput.extensionToolRegistry.getCatalog()).toEqual([]);
      expect(observedMetadata).toEqual({});
    } finally {
      await runtime.close();
    }
  });
});

describe("createRunnerFromHarnessYaml", () => {
  let tempDir: string;
  let stateRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openharness-runner-wrapper-test-"));
    stateRoot = path.join(tempDir, ".state");
    runTurnMock.mockReset();
  });

  it("agentName 없이 conversationId만 노출한다", async () => {
    await writeText(
      path.join(tempDir, "connector.js"),
      [
        "export default {",
        "  async normalize() {",
        "    return {",
        "      name: 'slack.message',",
        "      content: [{ type: 'text', text: 'hello' }],",
        "      properties: {},",
        "      source: { kind: 'connector', name: 'slack' },",
        "    };",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    await writeText(
      path.join(tempDir, "harness.yaml"),
      createHarnessYaml({
        connectorEntry: "connector.js",
        connectionIngress: [
          "- match:",
          "    event: slack.message",
          "  route:",
          "    agentRef: Agent/assistant",
          "    conversationId: default",
        ],
      }),
    );

    const runner = await createRunnerFromHarnessYaml({
      workdir: tempDir,
      stateRoot,
      env: {
        OPENAI_API_KEY: "test-key",
      },
    });

    try {
      expect("agentName" in runner).toBe(false);
      expect(runner.conversationId).toBe("assistant");
    } finally {
      await runner.close();
    }
  });

  it("control.abortConversation이 실행 중인 turn을 중단한다", async () => {
    await writeText(
      path.join(tempDir, "connector.js"),
      [
        "export default {",
        "  async normalize() {",
        "    return {",
        "      name: 'slack.message',",
        "      content: [{ type: 'text', text: 'hello' }],",
        "      properties: {},",
        "      source: { kind: 'connector', name: 'slack' },",
        "    };",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    await writeText(
      path.join(tempDir, "harness.yaml"),
      createHarnessYaml({
        connectorEntry: "connector.js",
        connectionIngress: [
          "- match:",
          "    event: slack.message",
          "  route:",
          "    agentRef: Agent/assistant",
          "    conversationId: assistant",
        ],
      }),
    );

    const started = createDeferred<void>();
    runTurnMock.mockImplementation(async (input: { abortSignal: AbortSignal; turnId: string }) => {
      started.resolve();

      if (!input.abortSignal.aborted) {
        await new Promise<void>((resolve) => {
          input.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      }

      const message =
        input.abortSignal.reason instanceof Error
          ? input.abortSignal.reason.message
          : typeof input.abortSignal.reason === "string"
            ? input.abortSignal.reason
            : "OpenHarness turn aborted";

      return {
        turnResult: {
          turnId: input.turnId,
          finishReason: "aborted",
          error: {
            code: "E_OPENHARNESS_ABORTED",
            message,
          },
        },
        finalResponseText: "",
        stepCount: 0,
      };
    });

    const runtime = await createHarnessRuntimeFromYaml({
      workdir: tempDir,
      stateRoot,
      env: {
        OPENAI_API_KEY: "test-key",
      },
    });

    try {
      const turnPromise = runtime.processTurn("중단 테스트");
      await started.promise;

      const abortResult = await runtime.control.abortConversation({
        conversationId: "assistant",
        reason: "stop requested",
      });

      expect(abortResult).toEqual({
        conversationId: "assistant",
        agentNames: ["assistant"],
        matchedSessions: 1,
        abortedTurns: 1,
        reason: "stop requested",
      });

      await expect(turnPromise).resolves.toMatchObject({
        turnResult: {
          finishReason: "aborted",
          error: {
            code: "E_OPENHARNESS_ABORTED",
            message: "stop requested",
          },
        },
      });
    } finally {
      await runtime.close();
    }
  });
});
