import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/models/index.ts"],
  format: ["esm"],
  dts: true,
  external: [
    "@anthropic-ai/sdk",
    "@google/generative-ai",
    "openai",
  ],
});
