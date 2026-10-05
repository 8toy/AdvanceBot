/**
 * Telegram API for:
 *      - sendMessage
 *      - setMessageReaction
 */

import { logger } from './logger.js';

export default class TelegramBotAPI {
    constructor(botToken) {
        this.apiUrl = `https://api.telegram.org/bot${botToken}/`;
    }

    async callApi(action, body, quiet = false) {
        try {
            const response = await fetch(this.apiUrl + action, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(10000) // 10 second timeout
            });

            const data = await response.json();

            if (!response.ok && quiet) {
                const err = new Error(`Telegram API error: ${data.description || 'Unknown error'}`);
                err.code = data.error_code;
                err.retryAfter = data.parameters?.retry_after;
                throw err;
            }

            if (!response.ok) {
                // One concise summary line at warn level; the bot recovers from
                // these gracefully, so the per-request details go to debug.
                logger.warn(`Telegram API request failed: ${action} (Status: ${response.status})${data.description ? ' - ' + data.description : ''}`);

                // Log only relevant fields based on action
                if (action === 'setMessageReaction') {
                    logger.debug(`Chat ID: ${body.chat_id}, Message ID: ${body.message_id}, Reaction: ${body.reaction?.[0]?.emoji}`);
                } else if (action === 'sendMessage') {
                    logger.debug(`Chat ID: ${body.chat_id}, Text: ${body.text?.substring(0, 50)}...`);
                } else if (action === 'sendInvoice') {
                    logger.debug(`Chat ID: ${body.chat_id}, Title: ${body.title}`);
                } else if (action === 'answerPreCheckoutQuery') {
                    logger.debug(`Pre-checkout Query ID: ${body.pre_checkout_query_id}, OK: ${body.ok}`);
                } else {
                    logger.debug(`Chat ID: ${body.chat_id || 'N/A'}`);
                }

                if (data.error_code) {
                    logger.debug(`Error code: ${data.error_code}`);
                }

                const err = new Error(`Telegram API error: ${data.description || 'Unknown error'}`);
                err.code = data.error_code;
                err.retryAfter = data.parameters?.retry_after;
                throw err;
            }

            return data;

        } catch (error) {
            // Log network/timeout errors with action and relevant details
            if (quiet && !error.message.includes('Telegram API error')) {
                throw new Error(`Network error: ${action}`);
            }
            if (error.name === 'AbortError') {
                logger.warn(`Request timeout for action: ${action}`);
                if (action === 'setMessageReaction') {
                    logger.debug(`Chat ID: ${body.chat_id}, Message ID: ${body.message_id}, Reaction: ${body.reaction?.[0]?.emoji}`);
                } else if (body.chat_id) {
                    logger.debug(`Chat ID: ${body.chat_id}`);
                }
                throw new Error(`Telegram API timeout: ${action}`);
            } else if (!error.message.includes('Telegram API error')) {
                logger.warn(`Network error for action: ${action} - ${error.message}`);
                if (action === 'setMessageReaction') {
                    logger.debug(`Chat ID: ${body.chat_id}, Message ID: ${body.message_id}, Reaction: ${body.reaction?.[0]?.emoji}`);
                } else if (body.chat_id) {
                    logger.debug(`Chat ID: ${body.chat_id}`);
                }
                throw new Error(`Network error: ${action}`);
            }

            throw error;
        }
    }

    /**
     * https://core.telegram.org/bots/api#setmessagereaction
     * @param {number} chatId 
     * @param {number} messageId 
     * @param {string} emoji 
     */
    async setWebhook(url, allowedUpdates = ['message','channel_post','callback_query','my_chat_member','pre_checkout_query','chat_member','chat_join_request']) {
        const data = await this.callApi('setWebhook', { url, allowed_updates: allowedUpdates });
        return data.result;
    }

    async setMessageReaction(chatId, messageId, emoji) {
        await this.callApi('setMessageReaction', {
            chat_id: chatId,
            message_id: messageId,
            reaction: [{
                type: 'emoji',
                emoji: emoji
            }],
            is_big: true
        });
    }

    /**
     * https://core.telegram.org/bots/api#sendmessage
     * @param {number} chatId
     * @param {string} text
     */
    async sendEphemeralMessage(chatId, receiverUserId, text, inlineKeyboard = null, callbackQueryId = undefined) {
        const ephemeral_message_parameters = { receiver_user_id: receiverUserId };
        if (callbackQueryId) ephemeral_message_parameters.callback_query_id = callbackQueryId;
        const data = await this.callApi('sendMessage', {
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ephemeral_message_parameters,
            ...(inlineKeyboard && { reply_markup: { inline_keyboard: inlineKeyboard } })
        });
        return data.result;
    }

    async sendMessage(chatId, text, inlineKeyboard = null, parseMode = 'HTML') {
        const data = await this.callApi('sendMessage', {
            chat_id: chatId,
            text: text,
            parse_mode: parseMode,
            disable_web_page_preview: true,
            ...(inlineKeyboard && { reply_markup: { inline_keyboard: inlineKeyboard } })
        });
        return data.result;
    }

    /**
     * https://core.telegram.org/bots/api#sendphoto
     */
    async sendPhoto(chatId, photo, caption, inlineKeyboard = null) {
        const data = await this.callApi('sendPhoto', {
            chat_id: chatId,
            photo: photo,
            caption: caption,
            parse_mode: 'HTML',
            ...(inlineKeyboard && { reply_markup: { inline_keyboard: inlineKeyboard } })
        });
        return data.result;
    }

    /**
     * https://core.telegram.org/bots/api#sendanimation
     */
    async sendAnimation(chatId, animation, caption, inlineKeyboard = null) {
        const data = await this.callApi('sendAnimation', {
            chat_id: chatId,
            animation: animation,
            caption: caption,
            parse_mode: 'HTML',
            ...(inlineKeyboard && { reply_markup: { inline_keyboard: inlineKeyboard } })
        });
        return data.result;
    }

    /**
     * https://core.telegram.org/bots/api#copymessage
     * Quiet: used for broadcasts, failures are handled by the caller.
     */

    async approveChatJoinRequest(chatId, userId) {
        const data = await this.callApi('approveChatJoinRequest', { chat_id: chatId, user_id: userId }, true);
        return data.result;
    }

    async declineChatJoinRequest(chatId, userId) {
        const data = await this.callApi('declineChatJoinRequest', { chat_id: chatId, user_id: userId }, true);
        return data.result;
    }

    async getChatMember(chatId, userId) {
        const data = await this.callApi('getChatMember', { chat_id: chatId, user_id: userId }, true);
        return data.result;
    }

    async forwardMessage(chatId, fromChatId, messageId) {
        const data = await this.callApi('forwardMessage', {
            chat_id: chatId,
            from_chat_id: fromChatId,
            message_id: messageId
        }, true);
        return data.result;
    }

    async pinMessage(chatId, messageId, disableNotification = true) {
        const data = await this.callApi('pinChatMessage', {
            chat_id: chatId,
            message_id: messageId,
            disable_notification: disableNotification
        }, true);
        return data.result;
    }

    async copyMessage(chatId, fromChatId, messageId, replyMarkup = null) {
        const data = await this.callApi('copyMessage', {
            chat_id: chatId,
            from_chat_id: fromChatId,
            message_id: messageId,
            ...(replyMarkup && { reply_markup: replyMarkup })
        }, true);
        return data.result;
    }

    /**
     * https://core.telegram.org/bots/api#editmessagetext
     */
    async editMessageText(chatId, messageId, text, inlineKeyboard = null) {
        await this.callApi('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: { inline_keyboard: inlineKeyboard || [] }
        }, true);
    }

    /**
     * https://core.telegram.org/bots/api#answercallbackquery
     */
    async answerCallbackQuery(callbackQueryId, text = '', showAlert = false) {
        await this.callApi('answerCallbackQuery', {
            callback_query_id: callbackQueryId,
            text: text,
            show_alert: showAlert
        }, true);
    }

    /**
     * https://core.telegram.org/bots/api#sendinvoice
     * @param {number} params.chatId - Unique identifier for the target chat
     * @param {string} params.title - Product name
     * @param {string} params.description - Product description
     * @param {string} params.payload - Bot-defined invoice payload
     * @param {string} params.providerToken - Payments provider token
     * @param {string} params.startParameter - Unique deep-linking parameter
     * @param {string} params.currency - Three-letter ISO 4217 currency code
     * @param {Array} params.prices - Price breakdown (e.g., [{label: 'Product', amount: 1000}])
     */
    async sendInvoice(chatId, title, description, payload, providerToken, startParameter, currency, prices) {
        await this.callApi('sendInvoice', {
            chat_id: chatId,
            title: title,
            description: description,
            payload: payload,
            provider_token: providerToken,
            start_parameter: startParameter,
            currency: currency,
            prices: prices
        });
    }

    /**
     * https://core.telegram.org/bots/api#answerprecheckoutquery
     * @param {string} preCheckoutQueryId - Unique identifier for the query to be answered
     * @param {boolean} ok - Specify if the query was successful
     */
    async answerPreCheckoutQuery(preCheckoutQueryId, ok) {
        await this.callApi('answerPreCheckoutQuery', {
            pre_checkout_query_id: preCheckoutQueryId,
            ok: ok
        });
    }
};