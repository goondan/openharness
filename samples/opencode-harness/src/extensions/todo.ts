import type { ExtensionApi, JsonObject } from "@goondan/openharness";

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
type TodoPriority = "high" | "medium" | "low";

interface TodoItem {
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled";
}

function isTodoPriority(value: unknown): value is TodoPriority {
  return value === "high" || value === "medium" || value === "low";
}

function parseTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  const items: TodoItem[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const obj = raw as Record<string, unknown>;
    const content = typeof obj.content === "string" ? obj.content : "";
    const status = obj.status;
    const priority = obj.priority;
    if (content.trim().length === 0) continue;
    if (!isTodoStatus(status)) continue;
    if (!isTodoPriority(priority)) continue;
    items.push({
      content: content.trim(),
      status,
      priority,
    });
  }
  return items;
}

function formatTodos(todos: TodoItem[]): string {
  return JSON.stringify(todos, null, 2);
}

export function register(api: ExtensionApi): void {
  api.tools.register(
    {
      name: "todo__write",
      description: "Update the todo list (opencode-style).",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "The updated todo list",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "Brief description of the task" },
                status: {
                  type: "string",
                  description: "pending | in_progress | completed | cancelled",
                  enum: ["pending", "in_progress", "completed", "cancelled"],
                },
                priority: {
                  type: "string",
                  description: "high | medium | low",
                  enum: ["high", "medium", "low"],
                },
              },
            },
          },
        },
        required: ["todos"],
        additionalProperties: false,
      },
      source: { type: "extension", name: "opencode-todo" },
    },
    async (_ctx, args) => {
      const todos = parseTodos((args as JsonObject).todos);
      const jsonTodos: JsonObject[] = todos.map((todo) => ({
        content: todo.content,
        status: todo.status,
        priority: todo.priority,
      }));
      await api.state.set({ todos: jsonTodos });
      const remaining = todos.filter((t) => t.status !== "completed" && t.status !== "cancelled").length;
      return `todos(${remaining} remaining)\n\n${formatTodos(todos)}`;
    },
  );

  api.tools.register(
    {
      name: "todo__read",
      description: "Read the current todo list (opencode-style).",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      source: { type: "extension", name: "opencode-todo" },
    },
    async () => {
      const state = await api.state.get();
      const todos =
        typeof state === "object" && state !== null && !Array.isArray(state) ? parseTodos((state as any).todos) : [];
      const remaining = todos.filter((t) => t.status !== "completed" && t.status !== "cancelled").length;
      return `todos(${remaining} remaining)\n\n${formatTodos(todos)}`;
    },
  );
}
