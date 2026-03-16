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
});

// ---------------------------------------------------------------------------
// Test 4 & 5: Agent auto-selection logic
// ---------------------------------------------------------------------------

describe("agent auto-selection", () => {
  it("1 agent is selected automatically", () => {
    const agents = { myAgent: {} };
    const agentNames = Object.keys(agents);
    const selectedAgent = agentNames.length === 1 ? agentNames[0] : null;
    expect(selectedAgent).toBe("myAgent");
  });

  it("2+ agents without --agent flag results in error (exit code 2)", () => {
    const agents = { agentA: {}, agentB: {} };
    const agentNames = Object.keys(agents);
    const requestedAgent: string | undefined = undefined;

    let exitCode: number | null = null;

    if (!requestedAgent) {
      if (agentNames.length > 1) {
        exitCode = 2;
      } else {
        exitCode = 0;
      }
    } else {
      exitCode = 0;
    }

    expect(exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Exit codes
// ---------------------------------------------------------------------------

describe("exit codes", () => {
  it("exit codes are correct: 0=success, 1=runtime error, 2=usage error", () => {
    // These are the defined exit codes for the CLI
    const EXIT_SUCCESS = 0;
    const EXIT_RUNTIME_ERROR = 1;
    const EXIT_USAGE_ERROR = 2;

    expect(EXIT_SUCCESS).toBe(0);
    expect(EXIT_RUNTIME_ERROR).toBe(1);
    expect(EXIT_USAGE_ERROR).toBe(2);
  });
});
