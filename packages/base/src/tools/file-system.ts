import { readFile, writeFile, readdir } from "node:fs/promises";
import type { ToolDefinition, JsonObject, ToolContext } from "@goondan/openharness-types";

export function FileReadTool(): ToolDefinition {
  return {
    name: "file_read",
    description: "Read the contents of a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file to read." },
        encoding: {
          type: "string",
          enum: ["utf8", "base64"],
          description: "File encoding. Defaults to utf8.",
        },
      },
      required: ["path"],
    },
    async handler(args: JsonObject, _ctx: ToolContext) {
      const filePath = args["path"] as string;
      const encoding = (args["encoding"] as BufferEncoding | undefined) ?? "utf8";
      try {
        const content = await readFile(filePath, { encoding });
        return { type: "text", text: content };
      } catch (err) {
        return { type: "error", error: (err as Error).message };
      }
    },
  };
}

export function FileWriteTool(): ToolDefinition {
  return {
    name: "file_write",
    description: "Write content to a file, creating or overwriting it.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file to write." },
        content: { type: "string", description: "The content to write to the file." },
      },
      required: ["path", "content"],
    },
    async handler(args: JsonObject, _ctx: ToolContext) {
      const filePath = args["path"] as string;
      const content = args["content"] as string;
      try {
        await writeFile(filePath, content, "utf8");
        return { type: "text", text: `File written: ${filePath}` };
      } catch (err) {
        return { type: "error", error: (err as Error).message };
      }
    },
  };
}

export function FileListTool(): ToolDefinition {
  return {
    name: "file_list",
    description: "List files and directories in a given directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the directory to list." },
      },
      required: ["path"],
    },
    async handler(args: JsonObject, _ctx: ToolContext) {
      const dirPath = args["path"] as string;
      try {
        const entries = await readdir(dirPath, { withFileTypes: true });
        const result = entries.map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "directory" : "file",
        }));
        return { type: "json", data: result };
      } catch (err) {
        return { type: "error", error: (err as Error).message };
      }
    },
  };
}
