export {
  handlers as slackHandlers,
  send as slackSend,
  read as slackRead,
  edit as slackEdit,
  remove as slackDelete,
  react as slackReact,
  downloadFile as slackDownloadFile,
} from "./slack.js";

export {
  handlers as telegramHandlers,
  send as telegramSend,
  edit as telegramEdit,
  remove as telegramDelete,
  react as telegramReact,
  setChatAction as telegramSetChatAction,
  downloadFile as telegramDownloadFile,
} from "./telegram.js";

