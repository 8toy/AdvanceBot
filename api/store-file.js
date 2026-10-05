import fs from 'node:fs';
import path from 'node:path';
import { chatKind } from './helper.js';
import { logger } from './logger.js';

const DEFAULTS = {
    reactions_enabled: true,
    reactions: null,
    welcome_enabled: true,
    welcome_mode: 'group',
    welcome_message: '',
    welcome_buttons: [],
    join_enabled: true,
    join_mode: 'notify',
    join_message: '',
    join_buttons: []
};

export function createFileStore(dir = './data') {
    const file = path.join(dir, 'store.json');
    const state = { chats: new Map(), settings: new Map(), pending: new Map() };
    try {
        if (fs.existsSync(file)) {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            for (const [id, kind] of Object.entries(raw.chats || {})) state.chats.set(Number(id), kind);
            for (const [id, value] of Object.entries(raw.settings || {})) state.settings.set(Number(id), value);
        }
    } catch (error) { logger.warn(`Could not read ${file}: ${error.message}`); }

    let timer = null;
    function flush() {
        try {
            fs.mkdirSync(dir, { recursive: true });
            const out = {
                chats: Object.fromEntries(state.chats),
                settings: Object.fromEntries(state.settings)
            };
            fs.writeFileSync(file + '.tmp', JSON.stringify(out, null, 2));
            fs.renameSync(file + '.tmp', file);
        } catch (error) { logger.warn(`Could not save ${file}: ${error.message}`); }
    }
    function scheduleSave() { if (!timer) timer = setTimeout(() => { timer = null; flush(); }, 500); }
    function settings(id) { if (!state.settings.has(id)) state.settings.set(id, { ...DEFAULTS }); return state.settings.get(id); }

    return {
        flush,
        async add(id, type) { const kind = chatKind(type); if (!kind || state.chats.get(id) === kind) return; state.chats.set(id, kind); scheduleSave(); },
        async remove(id) { state.chats.delete(id); state.settings.delete(id); scheduleSave(); },
        async setReactionsEnabled(id, enabled) { settings(id).reactions_enabled = !!enabled; scheduleSave(); },
        async setReactions(id, reactions) { settings(id).reactions = reactions; scheduleSave(); },
        async resetReactions(id) { settings(id).reactions = null; scheduleSave(); },
        async getReactions(id) { return settings(id).reactions; },
        async isReactionsEnabled(id) { return settings(id).reactions_enabled !== false; },
        async setPending(userId, chatId, mode = 'reactions', payload = null, ttlMs = 300000) { state.pending.set(userId, { chatId, mode, payload, expires_at: Date.now() + ttlMs }); },
        async getPending(userId) { const p = state.pending.get(userId); if (!p) return null; if (p.expires_at < Date.now()) { state.pending.delete(userId); return null; } return p; },
        async clearPending(userId) { state.pending.delete(userId); },
        async getGroupSettings(id) { return { ...DEFAULTS, ...settings(id) }; },
        async updateGroupSettings(id, patch) { Object.assign(settings(id), patch); scheduleSave(); },
        async counts() { const counts = { users: 0, groups: 0, channels: 0 }; for (const kind of state.chats.values()) if (kind in counts) counts[kind]++; return counts; },
        async ids(kinds, afterId = Number.MIN_SAFE_INTEGER, limit = Infinity) { return [...state.chats].filter(([id, kind]) => id > afterId && kinds.includes(kind)).map(([id]) => id).sort((a,b)=>a-b).slice(0, limit); },
        async close() { flush(); }
    };
}
