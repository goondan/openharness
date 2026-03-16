import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env } from "@goondan/openharness-types";
import { isEnvRef, resolveEnv } from "../env.js";
import { ConfigError } from "../errors.js";

describe("env() helper", () => {
  // Test 1: env("KEY") returns an EnvRef marker object
  it("env() returns an EnvRef marker object with the correct name", () => {
    const ref = env("MY_KEY");
    expect(ref).toBeTypeOf("object");
    expect(ref).not.toBeNull();
    expect(ref.name).toBe("MY_KEY");
  });
});

describe("isEnvRef()", () => {
  // Test 5: isEnvRef correctly identifies EnvRef objects
  it("returns true for an EnvRef object", () => {
    const ref = env("SOME_VAR");
    expect(isEnvRef(ref)).toBe(true);
  });

  it("returns false for a plain string", () => {
    expect(isEnvRef("plain-string")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isEnvRef(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isEnvRef(undefined)).toBe(false);
  });

  it("returns false for an object without a name property", () => {
    expect(isEnvRef({ foo: "bar" })).toBe(false);
  });

  it("returns false for an object with a non-string name property", () => {
    expect(isEnvRef({ name: 42 })).toBe(false);
  });
});

describe("resolveEnv()", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // Test 2: resolveEnv(envRef) with process.env.KEY set → returns value
  it("resolves an EnvRef when the environment variable is set", () => {
    process.env["TEST_API_KEY"] = "secret-value";
    const ref = env("TEST_API_KEY");
    expect(resolveEnv(ref)).toBe("secret-value");
  });

  // Test 3: resolveEnv(envRef) with missing env var → throws ConfigError
  it("throws ConfigError when the environment variable is not set", () => {
    delete process.env["MISSING_VAR"];
    const ref = env("MISSING_VAR");
    expect(() => resolveEnv(ref)).toThrow(ConfigError);
    expect(() => resolveEnv(ref)).toThrow('Environment variable "MISSING_VAR" is not set');
  });

  // Test 4: resolveEnv(plainString) → returns string as-is
  it("returns a plain string as-is", () => {
    expect(resolveEnv("plain-value")).toBe("plain-value");
  });
});
