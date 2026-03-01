import type { ConversationState, CoreMessage, Message, MessageEvent } from "../types.js";

export interface ConversationWarning {
  code: "E_MESSAGE_TARGET_NOT_FOUND";
  message: string;
  eventIndex: number;
  targetId: string;
}

export interface RuntimeConversationState extends ConversationState {
  emitMessageEvent(event: MessageEvent): void;
  applyEvent(event: MessageEvent): Message[];
  foldEventsToBase(): void;
  replaceBase(messages: Message[]): void;
  readonly warnings: ConversationWarning[];
}

export class ConversationStateImpl implements RuntimeConversationState {
  private base: Message[];
  private stagedEvents: MessageEvent[];
  private stagedWarnings: ConversationWarning[];

  constructor(baseMessages: Message[] = [], events: MessageEvent[] = []) {
    this.base = cloneMessageList(baseMessages);
    this.stagedEvents = [];
    this.stagedWarnings = [];

    for (const event of events) {
      this.emitMessageEvent(event);
    }
  }

  get baseMessages(): Message[] {
    return cloneMessageList(this.base);
  }

  get events(): MessageEvent[] {
    return this.stagedEvents.map((event) => cloneMessageEvent(event));
  }

  get nextMessages(): Message[] {
    const applied = applyMessageEvents(this.base, this.stagedEvents);
    return cloneMessageList(applied.messages);
  }

  get warnings(): ConversationWarning[] {
    return [...this.stagedWarnings];
  }

  emitMessageEvent(event: MessageEvent): void {
    const clonedEvent = cloneMessageEvent(event);
    this.stagedEvents.push(clonedEvent);

    const applied = applyMessageEvents(this.base, this.stagedEvents);
    this.stagedWarnings = applied.warnings;
  }

  applyEvent(event: MessageEvent): Message[] {
    this.emitMessageEvent(event);
    return this.nextMessages;
  }

  foldEventsToBase(): void {
    const applied = applyMessageEvents(this.base, this.stagedEvents);
    this.base = cloneMessageList(applied.messages);
    this.stagedEvents = [];
    this.stagedWarnings = [];
  }

  replaceBase(messages: Message[]): void {
    this.base = cloneMessageList(messages);
    this.stagedEvents = [];
    this.stagedWarnings = [];
  }

  toLlmMessages(): CoreMessage[] {
    return this.nextMessages.map((message) => cloneCoreMessage(message.data));
  }
}

export interface ApplyMessageEventsResult {
  messages: Message[];
  warnings: ConversationWarning[];
}

export function applyMessageEvents(baseMessages: Message[], events: MessageEvent[]): ApplyMessageEventsResult {
  let current = cloneMessageList(baseMessages);
  const warnings: ConversationWarning[] = [];

  events.forEach((event, eventIndex) => {
    if (event.type === "append") {
      current = [...current, cloneMessage(event.message)];
      return;
    }

    if (event.type === "replace") {
      const targetIndex = current.findIndex((message) => message.id === event.targetId);
      if (targetIndex < 0) {
        warnings.push({
          code: "E_MESSAGE_TARGET_NOT_FOUND",
          message: `replace target not found: ${event.targetId}`,
          eventIndex,
          targetId: event.targetId,
        });
        return;
      }

      const before = current.slice(0, targetIndex);
      const after = current.slice(targetIndex + 1);
      current = [...before, cloneMessage(event.message), ...after];
      return;
    }

    if (event.type === "remove") {
      const targetIndex = current.findIndex((message) => message.id === event.targetId);
      if (targetIndex < 0) {
        warnings.push({
          code: "E_MESSAGE_TARGET_NOT_FOUND",
          message: `remove target not found: ${event.targetId}`,
          eventIndex,
          targetId: event.targetId,
        });
        return;
      }

      const before = current.slice(0, targetIndex);
      const after = current.slice(targetIndex + 1);
      current = [...before, ...after];
      return;
    }

    current = [];
  });

  return {
    messages: current,
    warnings,
  };
}

function cloneCoreMessage(message: CoreMessage): CoreMessage {
  return { ...message };
}

export function cloneMessageList(messages: Message[]): Message[] {
  return messages.map((message) => cloneMessage(message));
}

export function cloneMessage(message: Message): Message {
  return {
    id: message.id,
    data: cloneCoreMessage(message.data),
    metadata: { ...message.metadata },
    createdAt: new Date(message.createdAt.getTime()),
    source: cloneMessageSource(message.source),
  };
}

function cloneMessageSource(source: Message["source"]): Message["source"] {
  if (source.type === "assistant") {
    return { type: "assistant", stepId: source.stepId };
  }

  if (source.type === "tool") {
    return {
      type: "tool",
      toolCallId: source.toolCallId,
      toolName: source.toolName,
    };
  }

  if (source.type === "extension") {
    return {
      type: "extension",
      extensionName: source.extensionName,
    };
  }

  if (source.type === "system") {
    return { type: "system" };
  }

  return { type: "user" };
}

export function cloneMessageEvent(event: MessageEvent): MessageEvent {
  if (event.type === "append") {
    return {
      type: "append",
      message: cloneMessage(event.message),
    };
  }

  if (event.type === "replace") {
    return {
      type: "replace",
      targetId: event.targetId,
      message: cloneMessage(event.message),
    };
  }

  if (event.type === "remove") {
    return {
      type: "remove",
      targetId: event.targetId,
    };
  }

  return { type: "truncate" };
}
