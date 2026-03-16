import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Test 1 & 2: .env loading
// ---------------------------------------------------------------------------

describe("env-loader", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Clean up env vars set during tests
    delete process.env["OH_TEST_VAR"];
    delete process.env["OH_TEST_ONLY_DOT_ENV"];
  });

  it("process.env takes precedence over .env file values", async () => {
    // Write .env with a value
    fs.writeFileSync(path.join(tmpDir, ".env"), "OH_TEST_VAR=from_dotenv\n");
    // Set process.env to a different value BEFORE loading
    process.env["OH_TEST_VAR"] = "from_process_env";

    const { loadEnv } = await import("../env-loader.js");
    loadEnv(tmpDir);

    // process.env value should still win
    expect(process.env["OH_TEST_VAR"]).toBe("from_process_env");
  });

  it(".env values are loaded when process.env is empty", async () => {
    // Make sure the var is not set
    delete process.env["OH_TEST_ONLY_DOT_ENV"];
    fs.writeFileSync(path.join(tmpDir, ".env"), "OH_TEST_ONLY_DOT_ENV=hello_from_dotenv\n");

    const { loadEnv } = await import("../env-loader.js");
    loadEnv(tmpDir);

    expect(process.env["OH_TEST_ONLY_DOT_ENV"]).toBe("hello_from_dotenv");
  });
});

// ---------------------------------------------------------------------------
// Test 3: Config loading
// ---------------------------------------------------------------------------

describe("config-loader", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-config-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("valid harness.config returns HarnessConfig", async () => {
    // Write a minimal JS config file (use .mjs for ESM compatibility)
    const configContent = `
export default {
  agents: {
    myAgent: {
      model: {
        provider: "openai",
        model: "gpt-4o",
        apiKey: "test-key",
      },
    },
  },
};
`;
    const configPath = path.join(tmpDir, "harness.config.mjs");
    fs.writeFileSync(configPath, configContent);

    const { loadConfig } = await import("../config-loader.js");
    const config = await loadConfig(configPath);

    expect(config).toBeDefined();
    expect(config.agents).toBeDefined();
    expect(config.agents["myAgent"]).toBeDefined();
    expect(config.agents["myAgent"]!.model.provider).toBe("openai");
  });

  it("config missing agents property throws an error", async () => {
    const configContent = `export default { notAgents: {} };\n`;
    const configPath = path.join(tmpDir, "invalid.config.mjs");
    fs.writeFileSync(configPath, configContent);

    const { loadConfig } = await import("../config-loader.js");
    await expect(loadConfig(configPath)).rejects.toThrow(/agents/);
  });
});

// ---------------------------------------------------------------------------
// Tests 4-6: runCommand agent-selection logic (calls actual source code)
// ---------------------------------------------------------------------------

// Mock @goondan/openharness and the config/env loaders so runCommand can be
// exercised in isolation without real files or real LLM clients.
vi.mock("@goondan/openharness", () => ({
  createHarness: vi.fn(),
}));

vi.mock("../config-loader.js", async (importOriginal) => {
  // Preserve a reference to the real implementation so config-loader tests
  // (which run before this mock is configured) still use actual code.
  const real = await importOriginal<typeof import("../config-loader.js")>();
  return {
    loadConfig: vi.fn(real.loadConfig),
  };
});

vi.mock("../env-loader.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../env-loader.js")>();
  return {
    loadEnv: vi.fn(real.loadEnv),
  };
});

describe("runCommand agent-selection", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: any;

  beforeEach(async () => {
    // Make process.exit throw so runCommand stops executing after exit is called
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    }) as () => never);

    // Override loadConfig to return controlled configs (don't hit the filesystem)
    const { loadConfig } = await import("../config-loader.js");
    vi.mocked(loadConfig).mockReset();

    const { createHarness } = await import("@goondan/openharness");
    vi.mocked(createHarness).mockReset();
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("single agent is auto-selected and runCommand succeeds", async () => {
    const { loadConfig } = await import("../config-loader.js");
    const { createHarness } = await import("@goondan/openharness");

    vi.mocked(loadConfig).mockResolvedValue({
      agents: {
        onlyAgent: {
          model: { provider: "openai", model: "gpt-4o", apiKey: "test-key" },
        },
      },
    } as never);

    const mockHarness = {
      processTurn: vi.fn().mockResolvedValue({ text: "hello" }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createHarness).mockResolvedValue(mockHarness as never);

    const { runCommand } = await import("../commands/run.js");
    await runCommand("hello", { config: "/fake/harness.config.ts" });

    // process.exit should not have been called
    expect(exitSpy).not.toHaveBeenCalled();
    // processTurn should have been called with the auto-selected agent name
    expect(mockHarness.processTurn).toHaveBeenCalledWith("onlyAgent", "hello", expect.anything());
  });

  it("multiple agents without --agent flag calls process.exit(2)", async () => {
    const { loadConfig } = await import("../config-loader.js");

    vi.mocked(loadConfig).mockResolvedValue({
      agents: {
        agentA: { model: { provider: "openai", model: "gpt-4o", apiKey: "test-key" } },
        agentB: { model: { provider: "openai", model: "gpt-4o", apiKey: "test-key" } },
      },
    } as never);

    const { runCommand } = await import("../commands/run.js");

    await expect(
      runCommand("hello", { config: "/fake/harness.config.ts" }),
    ).rejects.toThrow("process.exit(2)");

    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("unknown --agent name calls process.exit(2)", async () => {
    const { loadConfig } = await import("../config-loader.js");

    vi.mocked(loadConfig).mockResolvedValue({
      agents: {
        realAgent: { model: { provider: "openai", model: "gpt-4o", apiKey: "test-key" } },
      },
    } as never);

    const { runCommand } = await import("../commands/run.js");

    await expect(
      runCommand("hello", { config: "/fake/harness.config.ts", agent: "ghostAgent" }),
    ).rejects.toThrow("process.exit(2)");

    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});
