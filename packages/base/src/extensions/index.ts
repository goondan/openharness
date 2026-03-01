export {
  register as registerLoggingExtension,
  registerLoggingExtension as createLoggingExtension,
} from './logging.js';
export type { LoggingExtensionConfig } from './logging.js';

export {
  register as registerCompactionExtension,
  registerCompactionExtension as createCompactionExtension,
} from './compaction.js';
export type { CompactionExtensionConfig } from './compaction.js';

export {
  register as registerMessageWindowExtension,
  registerMessageWindowExtension as createMessageWindowExtension,
} from './message-window.js';
export type { MessageWindowExtensionConfig } from './message-window.js';

export {
  register as registerToolSearchExtension,
  registerToolSearchExtension as createToolSearchExtension,
} from './tool-search.js';
export type { ToolSearchExtensionConfig } from './tool-search.js';

export {
  register as registerContextMessageExtension,
  register as createContextMessageExtension,
} from './context-message.js';
export type { ContextMessageExtensionConfig } from './context-message.js';

export { register as registerRequiredToolsGuardExtension } from './required-tools-guard.js';
export type { RequiredToolsGuardConfig } from './required-tools-guard.js';

export {
  register as registerInterAgentResponseFormatExtension,
  registerInterAgentResponseFormatExtension as createInterAgentResponseFormatExtension,
} from './inter-agent-response-format.js';
export type { InterAgentResponseFormatExtensionConfig } from './inter-agent-response-format.js';
