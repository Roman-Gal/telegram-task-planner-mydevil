export const activeMember = member => ['creator','administrator','member'].includes(member?.status) || (member?.status === 'restricted' && member.is_member === true);

export class Access {
  constructor(store, telegram, config) { this.store = store; this.telegram = telegram; this.config = config; this.botId = null; }
  allowed(chatId) {
    if (chatId > 0) return true;
    const explicit = this.config.allowedChatIds?.has(chatId);
    if (this.config.ownerUserId) return !this.store.groupDenied(chatId) && (explicit || this.store.groupApproved(chatId, this.config.ownerUserId));
    return !this.config.allowedChatIds?.size || explicit;
  }
  async membership(event) {
    if (!event?.chat || !['group','supergroup','channel'].includes(event.chat.type) || !this.botId || event.new_chat_member?.user?.id !== this.botId) return;
    const chatId = event.chat.id;
    if (!activeMember(event.new_chat_member)) { this.store.revokeGroup(chatId); return; }
    const unauthorizedJoin = this.config.ownerUserId && !activeMember(event.old_chat_member) && event.from?.id !== this.config.ownerUserId;
    if (unauthorizedJoin) this.store.revokeGroup(chatId);
    if (this.config.ownerUserId && event.from?.id === this.config.ownerUserId && event.chat.type !== 'channel') {
      this.store.approveGroup(chatId, this.config.ownerUserId);
    }
    if (unauthorizedJoin || !this.allowed(chatId) || (this.config.ownerUserId && event.chat.type === 'channel')) {
      try { await this.telegram.call('leaveChat', { chat_id: chatId }); }
      catch (error) { if (![400,403].includes(error.code)) throw error; }
      return;
    }
    this.store.remember(event.from, chatId);
  }
  authorize(chatId, userId) {
    if (chatId >= 0 || !this.config.ownerUserId || userId !== this.config.ownerUserId) return false;
    this.store.approveGroup(chatId, userId);
    return true;
  }
}
