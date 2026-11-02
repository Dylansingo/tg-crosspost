import { Bot } from 'grammy';
import type { TelegramFileApi } from './download.js';

/**
 * Grammy is used for Bot API calls only. Do not start polling or a webhook
 * listener from the Bot instance; Express owns POST /webhook/telegram.
 */
export function createGrammyFileApi(bot: Bot): TelegramFileApi {
  return {
    getFile(fileId: string) {
      return bot.api.getFile(fileId);
    },
  };
}
