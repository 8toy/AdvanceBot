import { startMessage, donateMessage } from './constants.js';
import { getRandomPositiveReaction, escapeHtml, splitEmojis } from './helper.js';
import { editStatus, progressText, errorText } from './broadcast.js';
import { logger } from './logger.js';
import { uiText, uiButton } from './font.js';

const TARGETS = { users: ['users'], groups: ['groups'], channels: ['channels'], all: ['users', 'groups', 'channels'] };
const DEFAULT_WELCOME = '👋 Welcome {mention} to <b>{group}</b>!\n\nPlease read the group rules and enjoy your stay. ❤️';
const DEFAULT_JOIN = '👋 Hello {mention}!\n\nYour request to join <b>{group}</b> has been received.\nPlease wait while an admin reviews it. ✨';

async function safe(task) { try { await task(); } catch (error) { logger.warn('Storage error:', error.message); } }

export async function onUpdate(data, botApi, Reactions, RestrictedChats, botUsername, RandomLevel, options = {}) {
    const { store = null, adminIds = [] } = options;

    if (data.chat_join_request) {
        await handleJoinRequest(data.chat_join_request, botApi, store, options);
        return;
    }

    if (data.chat_member) {
        await handleChatMember(data.chat_member, botApi, store, options);
        return;
    }

    if (data.message || data.channel_post) {
        const content = data.message || data.channel_post;
        const chatId = content.chat.id;
        const messageId = content.message_id;
        const text = content.text || content.caption || '';
        if (store) await safe(() => store.add(chatId, content.chat.type));

        const parts = text.trim().split(/\s+/);
        const rawCommand = parts[0] || '';
        const arg = parts.slice(1).join(' ');
        const command = rawCommand.split('@')[0].toLowerCase();
        const isPrivate = content.chat.type === 'private';
        const isGroup = ['group', 'supergroup'].includes(content.chat.type);
        const isChannel = content.chat.type === 'channel';
        const isGlobalAdmin = !!data.message && isPrivate && adminIds.includes(content.from?.id);
        const forwardedChannel = isPrivate ? getForwardedChannel(content.reply_to_message) : null;

        if (store && content.from?.id && isPrivate && !command.startsWith('/')) {
            const pending = await store.getPending(content.from.id);
            if (pending) {
                await finishPending(botApi, content, pending, Reactions, store, botUsername, options);
                return;
            }
        }

        if (data.message && command === '/start') await sendStart(botApi, content, botUsername, options);
        else if (data.message && command === '/help') await showHelp(botApi, content.chat.id, botUsername, options);
        else if (data.message && command === '/groupsetting' && isGroup) await showGroupSettings(botApi, content, store, options);
        else if (data.message && command === '/joinsetting' && isPrivate) await showJoinSettings(botApi, content, store, options, forwardedChannel);
        else if (data.message && command === '/reactions') await showReactionSettings(botApi, content, Reactions, store, options, forwardedChannel);
        else if (data.message && command === '/donate') await sendDonate(botApi, chatId, options);
        else if (data.message && isGroup && (command === '/reactions_on' || command === '/reactions_off')) await setGroupReactionState(botApi, content, command === '/reactions_on', store);
        else if (data.message && isPrivate && forwardedChannel && (command === '/reactions_on' || command === '/reactions_off')) await setForwardedChannelState(botApi, content, forwardedChannel, command === '/reactions_on', store);
        else if (isGlobalAdmin && (command === '/stats' || command === '/users')) await sendStats(botApi, chatId, store);
        else if (isGlobalAdmin && command === '/broadcast') await askBroadcast(botApi, content, arg.toLowerCase(), options);
        else {
            const custom = store ? await store.getReactions(chatId) : null;
            const active = custom?.length ? custom : Reactions;
            const enabled = store ? await store.isReactionsEnabled(chatId) : true;
            if (enabled && active.length && !RestrictedChats.includes(chatId) && messageId) {
                const threshold = 1 - (RandomLevel / 10);
                if (isGroup) {
                    if (Math.random() <= threshold) await botApi.setMessageReaction(chatId, messageId, getRandomPositiveReaction(active));
                } else if (isChannel) {
                    await botApi.setMessageReaction(chatId, messageId, getRandomPositiveReaction(active));
                }
            }
        }
        return;
    }

    if (data.callback_query) { await onCallback(data.callback_query, botApi, options); return; }

    if (data.my_chat_member) {
        const { chat, new_chat_member } = data.my_chat_member;
        if (store) {
            if (['kicked', 'left'].includes(new_chat_member?.status)) await safe(() => store.remove(chat.id));
            else await safe(() => store.add(chat.id, chat.type, { force: true }));
        }
        return;
    }

    if (data.pre_checkout_query) {
        await botApi.answerPreCheckoutQuery(data.pre_checkout_query.id, true);
        await botApi.sendMessage(data.pre_checkout_query.from.id, uiText('Thank you for your donation! 💝'));
    }
}

async function handleChatMember(update, botApi, store, options) {
    const chat = update.chat;
    const oldStatus = update.old_chat_member?.status;
    const member = update.new_chat_member;
    const newStatus = member?.status;
    if (!store || !chat || !['group', 'supergroup'].includes(chat.type)) return;
    await safe(() => store.add(chat.id, chat.type));
    if (!['member', 'administrator'].includes(newStatus) || ['member', 'administrator'].includes(oldStatus)) return;
    if (!member?.user || member.user.is_bot) return;
    const settings = await store.getGroupSettings(chat.id);
    if (!settings.welcome_enabled) return;

    const text = renderTemplate(settings.welcome_message || DEFAULT_WELCOME, member.user, chat);
    const keyboard = normalizeButtons(settings.welcome_buttons);
    try {
        if (settings.welcome_mode === 'only_user') {
            await botApi.sendEphemeralMessage(chat.id, member.user.id, text, keyboard);
        } else {
            await botApi.sendMessage(chat.id, text, keyboard);
        }
    } catch (error) {
        logger.warn(`Welcome message failed in ${chat.id}: ${error.message}`);
        if (settings.welcome_mode === 'only_user') {
            try { await botApi.sendMessage(member.user.id, text, keyboard); } catch (_) {}
        }
    }
}

async function handleJoinRequest(request, botApi, store, options) {
    if (!store) return;
    const chat = request.chat;
    const user = request.from;
    if (!chat?.id || !user?.id) return;
    await safe(() => store.add(chat.id, chat.type));
    const settings = await store.getGroupSettings(chat.id);
    if (!settings.join_enabled) return;

    const text = renderTemplate(settings.join_message || DEFAULT_JOIN, user, chat);
    const keyboard = normalizeButtons(settings.join_buttons);
    const recipient = request.user_chat_id || user.id;
    try { await botApi.sendMessage(recipient, text, keyboard); } catch (error) {
        logger.warn(`Join-request notification failed for ${user.id}: ${error.message}`);
    }

    if (settings.join_mode === 'auto_accept') {
        try {
            await botApi.approveChatJoinRequest(chat.id, user.id);
            try {
                await botApi.sendMessage(recipient, renderTemplate('<b>✅ Your request has been accepted.</b>\nWelcome to {group}! 🎉', user, chat), keyboard);
            } catch (_) {}
        } catch (error) {
            logger.warn(`Could not auto-accept join request in ${chat.id}: ${error.message}`);
        }
    }
}

function renderTemplate(text, user, chat) {
    const name = escapeHtml([user?.first_name, user?.last_name].filter(Boolean).join(' ') || 'there');
    const username = user?.username ? `@${escapeHtml(user.username)}` : name;
    const mention = `<a href="tg://user?id=${user?.id}">${name}</a>`;
    const group = escapeHtml(chat?.title || 'this chat');
    return String(text)
        .replaceAll('{name}', name)
        .replaceAll('{username}', username)
        .replaceAll('{mention}', mention)
        .replaceAll('{group}', group);
}

function normalizeButtons(buttons) {
    if (!Array.isArray(buttons)) return null;
    const rows = [];
    for (const item of buttons) {
        if (!item?.text || !item?.url) continue;
        rows.push([{
            text: item.text,
            url: item.url,
            ...(item.style ? { style: item.style } : {})
        }]);
    }
    return rows.length ? rows : null;
}

function getForwardedChannel(message) {
    const origin = message?.forward_origin;
    if (origin?.type === 'channel' && origin.chat?.id) return origin.chat;
    return null;
}

async function verifyAdmin(botApi, chatId, userId) {
    try {
        const member = await botApi.getChatMember(chatId, userId);
        return ['creator', 'administrator'].includes(member?.status);
    } catch (_) { return false; }
}

async function verifyGroupAdmin(botApi, content) {
    return verifyAdmin(botApi, content.chat.id, content.from?.id);
}

async function setGroupReactionState(botApi, content, enabled, store) {
    if (!(await verifyGroupAdmin(botApi, content))) return botApi.sendMessage(content.chat.id, uiText('⚠️ Only group admins can change reaction settings.'));
    if (!store) return notConfigured(botApi, content.chat.id);
    await store.setReactionsEnabled(content.chat.id, enabled);
    await botApi.sendMessage(content.chat.id, uiText(enabled ? '🟢 Auto reactions enabled.' : '🔴 Auto reactions disabled.'));
}

async function setForwardedChannelState(botApi, content, channel, enabled, store) {
    if (!store) return notConfigured(botApi, content.chat.id);
    if (!(await verifyAdmin(botApi, channel.id, content.from?.id))) return botApi.sendMessage(content.chat.id, uiText('⚠️ You must be a channel admin to change its reaction settings.'));
    await store.setReactionsEnabled(channel.id, enabled);
    await botApi.sendMessage(content.chat.id, uiText(`${enabled ? '🟢' : '🔴'} Reactions ${enabled ? 'enabled' : 'disabled'} for ${channel.title || 'the channel'}.`));
}

async function showReactionSettings(botApi, content, defaults, store, options, forwardedChannel = null) {
    if (!store) return notConfigured(botApi, content.chat.id);
    let targetId = content.chat.id;
    let targetTitle = content.chat.title || 'this chat';
    if (content.chat.type === 'private') {
        if (!forwardedChannel) return botApi.sendMessage(content.chat.id, uiText('⚙️ Forward one of your channel posts to me, then reply to that forwarded post with /reactions.'));
        targetId = forwardedChannel.id;
        targetTitle = forwardedChannel.title || 'Channel';
        if (!(await verifyAdmin(botApi, targetId, content.from?.id))) return botApi.sendMessage(content.chat.id, uiText('⚠️ You must be a channel admin to manage its reactions.'));
    } else if (!['group', 'supergroup'].includes(content.chat.type)) return botApi.sendMessage(content.chat.id, uiText('⚠️ Reaction settings are available in groups and channels.'));
    else if (!(await verifyGroupAdmin(botApi, content))) return botApi.sendMessage(content.chat.id, uiText('⚠️ Only group admins can manage reaction settings.'));

    const enabled = await store.isReactionsEnabled(targetId);
    const custom = await store.getReactions(targetId);
    await botApi.sendMessage(content.chat.id, uiText(`⚙️ Reaction Settings — ${targetTitle}\n\nStatus: ${enabled ? '🟢 ON' : '🔴 OFF'}\nReactions: ${(custom || defaults || []).join(' ')}`), [
        [Object.assign(uiButton(enabled ? '🔴 TURN OFF' : '🟢 TURN ON', enabled ? 'danger' : 'success'), { callback_data: `rs:${enabled ? 'off' : 'on'}:${targetId}` }), Object.assign(uiButton('✏️ CUSTOM', 'primary'), { callback_data: `rs:custom:${targetId}` })],
        [Object.assign(uiButton('🔄 RESET', 'primary'), { callback_data: `rs:reset:${targetId}` })]
    ]);
}

async function showJoinSettings(botApi, content, store, options, forwardedChannel = null) {
    if (!store) return notConfigured(botApi, content.chat.id);
    if (!forwardedChannel) return botApi.sendMessage(content.chat.id, uiText('🛡️ Forward a post from the private channel to me, then reply to it with /joinsetting.'));
    if (!(await verifyAdmin(botApi, forwardedChannel.id, content.from?.id))) return botApi.sendMessage(content.chat.id, uiText('⚠️ You must be a channel admin to manage join-request settings.'));
    await sendJoinSettingsPanel(botApi, content.chat.id, null, forwardedChannel.id, store, options, false);
}

async function sendJoinSettingsPanel(botApi, chatId, messageId, targetId, store, options, edit = false) {
    const s = await store.getGroupSettings(targetId);
    const text = uiText(`🛡️ JOIN REQUEST SETTINGS\n\nStatus: ${s.join_enabled ? '🟢 ON' : '🔴 OFF'}\nMode: ${s.join_mode === 'auto_accept' ? '✅ AUTO ACCEPT' : '🔔 NOTIFY ONLY'}`);
    const keyboard = [
        [Object.assign(uiButton(s.join_enabled ? '🔴 DISABLE' : '🟢 ENABLE', s.join_enabled ? 'danger' : 'success'), { callback_data: `js:join:${targetId}:${s.join_enabled ? 0 : 1}` }), Object.assign(uiButton(s.join_mode === 'auto_accept' ? '🔔 NOTIFY ONLY' : '✅ AUTO ACCEPT', 'primary'), { callback_data: `js:mode:${targetId}:${s.join_mode === 'auto_accept' ? 'notify' : 'auto_accept'}` })],
        [Object.assign(uiButton('📝 CHANGE MESSAGE', 'primary'), { callback_data: `js:msg:${targetId}` })],
        [Object.assign(uiButton('🔘 CHANGE BUTTONS', 'primary'), { callback_data: `js:btn:${targetId}` })],
        [Object.assign(uiButton('👁 PREVIEW', 'success'), { callback_data: `js:preview:${targetId}` })]
    ];
    if (edit) return botApi.editMessageText(chatId, messageId, text, keyboard);
    return botApi.sendMessage(chatId, text, keyboard);
}

async function showGroupSettings(botApi, content, store, options) {
    if (!store) return notConfigured(botApi, content.chat.id);
    if (!(await verifyGroupAdmin(botApi, content))) return botApi.sendMessage(content.chat.id, uiText('⚠️ Only the group owner/admins can use /groupsetting.'));
    await sendGroupSettingsPanel(botApi, content.chat.id, content.message_id, store, options);
}

async function sendGroupSettingsPanel(botApi, chatId, messageId, store, options, edit = false) {
    const s = await store.getGroupSettings(chatId);
    const text = uiText(`⚙️ GROUP SETTINGS\n\n👋 Welcome: ${s.welcome_enabled ? '🟢 ON' : '🔴 OFF'}\n   Mode: ${s.welcome_mode === 'only_user' ? '👤 ONLY USER' : '👥 GROUP'}\n\n❤️ Reactions: ${s.reactions_enabled ? '🟢 ON' : '🔴 OFF'}\n\n🛡️ Join Requests: ${s.join_enabled ? '🟢 ON' : '🔴 OFF'}\n   Mode: ${s.join_mode === 'auto_accept' ? '✅ AUTO ACCEPT' : '🔔 NOTIFY ONLY'}`);
    const keyboard = [
        [Object.assign(uiButton(s.welcome_enabled ? '👋 WELCOME: ON' : '👋 WELCOME: OFF', s.welcome_enabled ? 'success' : 'danger'), { callback_data: `gs:welcome:${chatId}:${s.welcome_enabled ? 0 : 1}` }), Object.assign(uiButton('📝 MESSAGE', 'primary'), { callback_data: `gs:wmsg:${chatId}` })],
        [Object.assign(uiButton('👤 ONLY USER', 'primary'), { callback_data: `gs:wmode:${chatId}:only_user` }), Object.assign(uiButton('👥 GROUP', 'primary'), { callback_data: `gs:wmode:${chatId}:group` })],
        [Object.assign(uiButton('🔘 WELCOME BUTTONS', 'primary'), { callback_data: `gs:wbtn:${chatId}` })],
        [Object.assign(uiButton(s.reactions_enabled ? '❤️ REACTIONS: ON' : '❤️ REACTIONS: OFF', s.reactions_enabled ? 'success' : 'danger'), { callback_data: `gs:react:${chatId}:${s.reactions_enabled ? 0 : 1}` })],
        [Object.assign(uiButton(s.join_enabled ? '🛡️ REQUESTS: ON' : '🛡️ REQUESTS: OFF', s.join_enabled ? 'success' : 'danger'), { callback_data: `gs:join:${chatId}:${s.join_enabled ? 0 : 1}` }), Object.assign(uiButton(s.join_mode === 'auto_accept' ? '✅ AUTO ACCEPT' : '🔔 NOTIFY', 'primary'), { callback_data: `gs:jmode:${chatId}:${s.join_mode === 'auto_accept' ? 'notify' : 'auto_accept'}` })],
        [Object.assign(uiButton('📝 REQUEST MESSAGE', 'primary'), { callback_data: `gs:jmsg:${chatId}` }), Object.assign(uiButton('🔘 REQUEST BUTTONS', 'primary'), { callback_data: `gs:jbtn:${chatId}` })],
        [Object.assign(uiButton('👁 PREVIEW', 'success'), { callback_data: `gs:preview:${chatId}` })]
    ];
    if (edit) await botApi.editMessageText(chatId, messageId, text, keyboard); else await botApi.sendMessage(chatId, text, keyboard);
}

async function finishPending(botApi, content, pending, Reactions, store, botUsername, options) {
    const value = (content.text || '').trim();
    await store.clearPending(content.from.id);
    if (pending.mode === 'reactions') {
        const reactions = splitEmojis(value).slice(0, 20);
        if (!reactions.length) return botApi.sendMessage(content.chat.id, uiText('⚠️ No valid emojis found.'));
        await store.setReactions(pending.chatId, reactions);
        return botApi.sendMessage(content.chat.id, uiText(`✅ Custom reactions saved:\n\n${reactions.join(' ')}`));
    }
    if (pending.mode === 'welcome_message' || pending.mode === 'join_message') {
        const key = pending.mode === 'welcome_message' ? 'welcome_message' : 'join_message';
        await store.updateGroupSettings(pending.chatId, { [key]: value });
        await botApi.sendMessage(content.chat.id, uiText(`✅ Message saved.\n\nVariables: {name} {username} {mention} {group}`));
        return sendGroupSettingsPanel(botApi, content.chat.id, null, store, options);
    }
    if (pending.mode === 'welcome_buttons' || pending.mode === 'join_buttons') {
        const parsed = parseButtons(value);
        if (!parsed.length) return botApi.sendMessage(content.chat.id, uiText('⚠️ Invalid buttons. Use one per line: Button Name | https://example.com | primary'));
        const key = pending.mode === 'welcome_buttons' ? 'welcome_buttons' : 'join_buttons';
        await store.updateGroupSettings(pending.chatId, { [key]: parsed });
        await botApi.sendMessage(content.chat.id, uiText(`✅ ${pending.mode === 'welcome_buttons' ? 'Welcome' : 'Join-request'} buttons saved.`));
        return sendGroupSettingsPanel(botApi, content.chat.id, null, store, options);
    }
}

function parseButtons(value) {
    return value.split('\n').map(line => {
        const [text, url, style = 'primary'] = line.split('|').map(x => x.trim());
        if (!text || !/^https?:\/\//i.test(url || '')) return null;
        return { text, url, style: ['primary', 'success', 'danger'].includes(style) ? style : 'primary' };
    }).filter(Boolean).slice(0, 8);
}

async function sendStart(botApi, content, botUsername, options) {
    const name = escapeHtml(content.from?.first_name || 'UserName');
    const text = startMessage.replace('UserName', name);
    const supportUrl = options.supportUrl;
    const updatesUrl = options.updatesUrl || `https://t.me/${botUsername}`;
    const uploadUrl = options.uploadUrl || `https://t.me/${botUsername}?startgroup=botstart`;
    const keyboard = [
        [Object.assign(uiButton('⇆ ADD ME TO YOUR CHANNELS ⇆', 'success'), { url: `https://t.me/${botUsername}?startchannel=botstart` })],
        [Object.assign(uiButton('⇆ ADD ME TO YOUR GROUPS ⇆', 'success'), { url: `https://t.me/${botUsername}?startgroup=botstart` })],
        [Object.assign(uiButton('❓ HELP', 'primary'), { callback_data: 'help' }), Object.assign(uiButton('⚙️ SETTINGS', 'primary'), { callback_data: 'settings' })],
        [Object.assign(uiButton('• UPDATES •', 'primary'), { url: updatesUrl }), ...(supportUrl ? [Object.assign(uiButton('• SUPPORT •', 'primary'), { url: supportUrl })] : [])],
        [Object.assign(uiButton('📤 UPLOAD / ADD', 'success'), { url: uploadUrl })]
    ];
    if (options.startAnimation) { try { await botApi.sendAnimation(content.chat.id, options.startAnimation, text, keyboard); return; } catch (_) {} }
    await botApi.sendMessage(content.chat.id, text, keyboard);
}

async function showHelp(botApi, chatId, botUsername, options, editTarget = null) {
    const text = uiText(`❖ HELP CENTER\n\n➜ AUTO REACTION\nAutomatically reacts to eligible group and channel messages.\n\n➜ GROUP SETTINGS\nUse /groupsetting as a group admin to configure Welcome, Reactions and Join Requests.\n\n➜ WELCOME\nCustom message, buttons and Only User / Group mode.\n\n➜ JOIN REQUESTS\nCustom notification, buttons and Auto Accept / Notify Only.\n\n➜ BROADCAST\nAdmins can choose copy or forward, then pin or don't pin.`);
    const keyboard = [
        [Object.assign(uiButton('💬 SUPPORT', 'primary'), { url: options.supportUrl || `https://t.me/${botUsername}` }), Object.assign(uiButton('📤 UPLOAD', 'success'), { url: options.uploadUrl || `https://t.me/${botUsername}?startgroup=botstart` })],
        [Object.assign(uiButton('◀️ BACK', 'primary'), { callback_data: 'back' })]
    ];
    if (editTarget) await botApi.editMessageText(editTarget.chatId, editTarget.messageId, text, keyboard); else await botApi.sendMessage(chatId, text, keyboard);
}

async function showWelcomeEdited(botApi, query, botUsername, options) {
    const name = escapeHtml(query.from?.first_name || 'there');
    const text = startMessage.replace('UserName', name);
    await botApi.editMessageText(query.message.chat.id, query.message.message_id, text, [
        [Object.assign(uiButton('⇆ ADD ME TO YOUR CHANNELS ⇆', 'success'), { url: `https://t.me/${botUsername}?startchannel=botstart` })],
        [Object.assign(uiButton('⇆ ADD ME TO YOUR GROUPS ⇆', 'success'), { url: `https://t.me/${botUsername}?startgroup=botstart` })],
        [Object.assign(uiButton('❓ HELP', 'primary'), { callback_data: 'help' }), Object.assign(uiButton('⚙️ SETTINGS', 'primary'), { callback_data: 'settings' })],
        [Object.assign(uiButton('• UPDATES •', 'primary'), { url: options.updatesUrl || `https://t.me/${botUsername}` }), Object.assign(uiButton('• SUPPORT •', 'primary'), { url: options.supportUrl || `https://t.me/${botUsername}` })]
    ]);
}

async function sendDonate(botApi, chatId, options) {
    if (options.donateAnimation) { try { await botApi.sendAnimation(chatId, options.donateAnimation, uiText('🙏 Support Auto Reaction Bot ✨')); } catch (_) {} }
    await botApi.sendInvoice(chatId, uiText('Donate to Auto Reactions Bot ✨'), uiText(donateMessage), '{}', '', 'donate', 'XTR', [{ label: 'Pay ⭐️5', amount: 5 }]);
}

async function sendStats(botApi, chatId, store) {
    if (!store) return notConfigured(botApi, chatId);
    const { users, groups, channels } = await store.counts();
    await botApi.sendMessage(chatId, uiText(`📊 Bot Stats\n\n👤 Users: ${users}\n👥 Groups: ${groups}\n📢 Channels: ${channels}\n\n🧮 Total: ${users + groups + channels}`));
}

async function askBroadcast(botApi, content, target, { store = null, enqueueBroadcast = null }) {
    const chatId = content.chat.id;
    if (!store || !enqueueBroadcast) return notConfigured(botApi, chatId);
    const reply = content.reply_to_message;
    if (!reply) return botApi.sendMessage(chatId, uiText('📢 Reply to the message you want to broadcast with /broadcast.'));
    const targetName = TARGETS[target] ? target : 'users';
    const counts = await store.counts();
    const total = TARGETS[targetName].reduce((sum, kind) => sum + counts[kind], 0);
    if (!total) return botApi.sendMessage(chatId, uiText(`⚠️ No ${targetName === 'all' ? 'chats' : targetName} found yet.`));
    const base = `bc:${targetName}:${chatId}:${reply.message_id}`;
    await botApi.sendMessage(chatId, uiText(`📢 Broadcast to ${total} ${targetName === 'all' ? 'chats' : targetName}.\n\n1️⃣ Choose delivery mode:`), [
        [Object.assign(uiButton('📤 COPY', 'primary'), { callback_data: `${base}:copy` }), Object.assign(uiButton('↪️ FORWARD', 'primary'), { callback_data: `${base}:forward` })],
        [Object.assign(uiButton('❌ CANCEL', 'danger'), { callback_data: 'bcx' })]
    ]);
}

async function onCallback(query, botApi, options) {
    const { store = null, adminIds = [], enqueueBroadcast = null } = options;
    const data = query.data || '';
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;

    if (data === 'settings') {
        await botApi.answerCallbackQuery(query.id);
        if (query.message?.chat?.type === 'group' || query.message?.chat?.type === 'supergroup') {
            const fake = { chat: query.message.chat, from: query.from, message_id: messageId };
            if (store && await verifyGroupAdmin(botApi, fake)) return showGroupSettings(botApi, fake, store, options);
        }
        return botApi.sendMessage(chatId, uiText('⚙️ Use /groupsetting inside your group as an admin.'));
    }
    if (data === 'bcx') { await botApi.answerCallbackQuery(query.id); return botApi.editMessageText(chatId, messageId, uiText('❌ Broadcast cancelled.')); }
    if (data === 'help') { await botApi.answerCallbackQuery(query.id); return showHelp(botApi, chatId, options.botUsername, options); }
    if (data === 'back') { await botApi.answerCallbackQuery(query.id); return showWelcomeEdited(botApi, query, options.botUsername, options); }

    if (data.startsWith('rs:')) {
        const [, action, targetRaw] = data.split(':');
        const targetId = Number(targetRaw);
        if (!store || !targetId || !(await verifyAdmin(botApi, targetId, query.from.id))) return botApi.answerCallbackQuery(query.id, 'Admins only', true);
        if (action === 'on' || action === 'off') await store.setReactionsEnabled(targetId, action === 'on');
        if (action === 'reset') await store.resetReactions(targetId);
        if (action === 'custom') { await store.setPending(query.from.id, targetId, 'reactions'); await botApi.answerCallbackQuery(query.id); return botApi.sendMessage(query.from.id, uiText('✏️ Send 1–20 emoji reactions now. Example: ❤️ 🔥 😂 💯 👀')); }
        await botApi.answerCallbackQuery(query.id);
        const enabled = await store.isReactionsEnabled(targetId);
        const custom = await store.getReactions(targetId);
        return botApi.editMessageText(chatId, messageId, uiText(`⚙️ Reaction Settings\n\nStatus: ${enabled ? '🟢 ON' : '🔴 OFF'}\nReactions: ${(custom || options.defaultReactions || []).join(' ')}`), [
            [Object.assign(uiButton(enabled ? '🔴 TURN OFF' : '🟢 TURN ON', enabled ? 'danger' : 'success'), { callback_data: `rs:${enabled ? 'off' : 'on'}:${targetId}` }), Object.assign(uiButton('✏️ CUSTOM', 'primary'), { callback_data: `rs:custom:${targetId}` })],
            [Object.assign(uiButton('🔄 RESET', 'primary'), { callback_data: `rs:reset:${targetId}` })]
        ]);
    }

    if (data.startsWith('js:')) {
        const [, action, idRaw, value] = data.split(':');
        const targetId = Number(idRaw);
        if (!store || !targetId || !(await verifyAdmin(botApi, targetId, query.from.id))) return botApi.answerCallbackQuery(query.id, 'Admins only', true);
        if (action === 'join') await store.updateGroupSettings(targetId, { join_enabled: value === '1' });
        else if (action === 'mode') await store.updateGroupSettings(targetId, { join_mode: value === 'auto_accept' ? 'auto_accept' : 'notify' });
        else if (action === 'msg') { await store.setPending(query.from.id, targetId, 'join_message'); await botApi.answerCallbackQuery(query.id); return botApi.sendMessage(query.from.id, uiText('📝 Send the new join-request message.\n\nVariables: {name} {username} {mention} {group}')); }
        else if (action === 'btn') { await store.setPending(query.from.id, targetId, 'join_buttons'); await botApi.answerCallbackQuery(query.id); return botApi.sendMessage(query.from.id, uiText('🔘 Send join-request buttons, one per line:\nButton Name | https://example.com | primary\n\nStyles: primary / success / danger')); }
        else if (action === 'preview') {
            const fresh = await store.getGroupSettings(targetId);
            await botApi.answerCallbackQuery(query.id);
            return botApi.sendMessage(query.from.id, renderTemplate(fresh.join_message || DEFAULT_JOIN, query.from, query.message?.chat));
        }
        await botApi.answerCallbackQuery(query.id);
        return sendJoinSettingsPanel(botApi, chatId, messageId, targetId, store, options, true);
    }

    if (data.startsWith('gs:')) {
        const [, action, idRaw, value] = data.split(':');
        const targetId = Number(idRaw);
        if (!store || !targetId) return botApi.answerCallbackQuery(query.id, 'Not configured', true);
        if (!(await verifyAdmin(botApi, targetId, query.from.id))) return botApi.answerCallbackQuery(query.id, 'Admins only', true);
        const settings = await store.getGroupSettings(targetId);
        if (action === 'welcome') await store.updateGroupSettings(targetId, { welcome_enabled: value === '1' });
        else if (action === 'wmode') await store.updateGroupSettings(targetId, { welcome_mode: value === 'only_user' ? 'only_user' : 'group' });
        else if (action === 'react') await store.setReactionsEnabled(targetId, value === '1');
        else if (action === 'join') await store.updateGroupSettings(targetId, { join_enabled: value === '1' });
        else if (action === 'jmode') await store.updateGroupSettings(targetId, { join_mode: value === 'auto_accept' ? 'auto_accept' : 'notify' });
        else if (action === 'wmsg') { await store.setPending(query.from.id, targetId, 'welcome_message'); await botApi.answerCallbackQuery(query.id); return botApi.sendMessage(query.from.id, uiText('📝 Send the new welcome message.\n\nVariables: {name} {username} {mention} {group}')); }
        else if (action === 'jmsg') { await store.setPending(query.from.id, targetId, 'join_message'); await botApi.answerCallbackQuery(query.id); return botApi.sendMessage(query.from.id, uiText('📝 Send the new join-request message.\n\nVariables: {name} {username} {mention} {group}')); }
        else if (action === 'wbtn') { await store.setPending(query.from.id, targetId, 'welcome_buttons'); await botApi.answerCallbackQuery(query.id); return botApi.sendMessage(query.from.id, uiText('🔘 Send welcome buttons, one per line:\nButton Name | https://example.com | primary\n\nStyles: primary / success / danger')); }
        else if (action === 'jbtn') { await store.setPending(query.from.id, targetId, 'join_buttons'); await botApi.answerCallbackQuery(query.id); return botApi.sendMessage(query.from.id, uiText('🔘 Send join-request buttons, one per line:\nButton Name | https://example.com | primary\n\nStyles: primary / success / danger')); }
        else if (action === 'preview') {
            const user = query.from;
            const fakeChat = query.message.chat;
            const fresh = await store.getGroupSettings(targetId);
            await botApi.answerCallbackQuery(query.id);
            return botApi.sendMessage(targetId, renderTemplate(fresh.welcome_message || DEFAULT_WELCOME, user, fakeChat), normalizeButtons(fresh.welcome_buttons));
        }
        await botApi.answerCallbackQuery(query.id);
        return sendGroupSettingsPanel(botApi, targetId, messageId, store, options, true);
    }

    if (data.startsWith('bc:')) {
        if (!adminIds.includes(query.from.id)) return botApi.answerCallbackQuery(query.id, 'Not allowed', true);
        const parts = data.split(':');
        const target = parts[1], fromChatId = Number(parts[2]), sourceMessageId = Number(parts[3]), mode = parts[4], pin = parts[5];
        if (parts.length === 5) {
            await botApi.answerCallbackQuery(query.id);
            return botApi.editMessageText(chatId, messageId, uiText(`📢 ${mode === 'copy' ? 'COPY' : 'FORWARD'} selected.\n\n2️⃣ Should the broadcasted message be pinned?`), [
                [Object.assign(uiButton('📌 PIN', 'success'), { callback_data: `bc:${target}:${fromChatId}:${sourceMessageId}:${mode}:1` }), Object.assign(uiButton('🚫 WITHOUT PIN', 'primary'), { callback_data: `bc:${target}:${fromChatId}:${sourceMessageId}:${mode}:0` })],
                [Object.assign(uiButton('❌ CANCEL', 'danger'), { callback_data: 'bcx' })]
            ]);
        }
        if (!TARGETS[target] || !['copy', 'forward'].includes(mode)) return botApi.answerCallbackQuery(query.id, 'Invalid request', true);
        const counts = await store.counts();
        const job = { kinds: TARGETS[target], fromChatId, messageId: sourceMessageId, statusChatId: chatId, statusMessageId: messageId, afterId: Number.MIN_SAFE_INTEGER, total: TARGETS[target].reduce((s,k)=>s+counts[k],0), sent:0, failed:0, removed:0, startedAt:Date.now(), mode, pin: pin === '1' };
        await botApi.answerCallbackQuery(query.id);
        await editStatus(botApi, job, progressText(job));
        try { await enqueueBroadcast(job); } catch (error) { await editStatus(botApi, job, errorText(job, error)); }
    }
}

async function notConfigured(botApi, chatId) { await botApi.sendMessage(chatId, uiText('⚠️ Database or queue is not configured.')); }
