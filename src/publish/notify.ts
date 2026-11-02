import type { Api } from 'grammy';

export interface PublishNotifier {
  /**
   * React to the original Telegram message. The bot must be a channel administrator.
   * The first attempt uses ✅. Telegram's reaction list does not include that emoji
   * today, so a rejection is retried with 👍.
   */
  react(chatId: number, messageId: number): Promise<void>;
  notifyAdmin(text: string): Promise<void>;
}

export interface ReactionApi {
  setMessageReaction(
    chatId: number,
    messageId: number,
    reaction: ReadonlyArray<{ type: 'emoji'; emoji: string }>,
  ): Promise<unknown>;
  sendMessage(chatId: number, text: string): Promise<unknown>;
}

export function createGrammyNotifier(api: ReactionApi, adminChatId: number): PublishNotifier {
  return {
    async react(chatId: number, messageId: number): Promise<void> {
      try {
        await api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: '✅' }]);
      } catch (error) {
        console.warn(
          `Telegram rejected the ✅ reaction (${error instanceof Error ? error.message : String(error)}). Retrying with 👍, which is on the Bot API reaction list.`,
        );
        await api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: '👍' }]);
      }
    },
    async notifyAdmin(text: string): Promise<void> {
      await api.sendMessage(adminChatId, text);
    },
  };
}

/** Adapt Grammy's client. ✅ is outside the bundled reaction union, so it is cast at this boundary. */
export function notifierFromGrammy(api: Api, adminChatId: number): PublishNotifier {
  const adapted: ReactionApi = {
    setMessageReaction: (chatId, messageId, reaction) =>
      api.setMessageReaction(chatId, messageId, reaction as never),
    sendMessage: (chatId, text) => api.sendMessage(chatId, text),
  };
  return createGrammyNotifier(adapted, adminChatId);
}
