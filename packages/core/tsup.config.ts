import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/models/index.ts"],
  format: ["esm"],
  dts: true,
  external: [
    "@ai-sdk/anthropic",
    "@ai-sdk/google",
    "@ai-sdk/openai",
  ],
});
