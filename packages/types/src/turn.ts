import type { Message } from "./message.js";

export interface TurnResult {
  readonly turnId: string;
  readonly responseMessage?: Message;
  readonly finishReason: "text_response" | "max_steps" | "error" | "aborted";
  readonly error?: {
    message: string;
    code?: string;
  };
}
