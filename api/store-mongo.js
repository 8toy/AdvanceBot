import { MongoClient } from 'mongodb';
import { chatKind } from './helper.js';

const SEEN_TTL = 10 * 60 * 1000;

export function createMongoStore(uri, dbName = 'reaction-bot') {
    const client = new MongoClient(uri, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 8000,
        connectTimeoutMS: 8000
    });
    let dbPromise = null;
    const seen = new Map();

    async function db() {
        if (!dbPromise) {
            dbPromise = client.connect().then(() => client.db(dbName));
        }
        try { return await dbPromise; }
        catch (error) { dbPromise = null; throw error; }
    }

    async function collections() {
        const d = await db();
        return {
            chats: d.collection('chats'),
            settings: d.collection('chat_settings'),
            pending: d.collection('pending_settings')
        };
    }

    return {
        async add(id, type, { force = false } = {}) {
            const kind = chatKind(type);
            if (!kind) return;
            const last = seen.get(id);
            if (!force && last && Date.now() - last < SEEN_TTL) return;
            const { chats } = await collections();
            await chats.updateOne({ _id: String(id) }, { $set: { id: Number(id), kind } }, { upsert: true });
            seen.set(id, Date.now());
        },
        async remove(id) {
            const { chats, settings } = await collections();
            seen.delete(id);
            await chats.deleteOne({ _id: String(id) });
            await settings.deleteOne({ _id: String(id) });
        },
        async setReactionsEnabled(id, enabled) {
            const { settings } = await collections();
            await settings.updateOne({ _id: String(id) }, { $set: { chat_id: Number(id), reactions_enabled: !!enabled } }, { upsert: true });
        },
        async setReactions(id, reactions) {
            const { settings } = await collections();
            await settings.updateOne({ _id: String(id) }, { $set: { chat_id: Number(id), reactions: reactions || [] } }, { upsert: true });
        },
        async resetReactions(id) {
            const { settings } = await collections();
            await settings.updateOne({ _id: String(id) }, { $unset: { reactions: '' } }, { upsert: true });
        },
        async getReactions(id) {
            const { settings } = await collections();
            const row = await settings.findOne({ _id: String(id) }, { projection: { reactions: 1 } });
            return Array.isArray(row?.reactions) && row.reactions.length ? row.reactions : null;
        },
        async isReactionsEnabled(id) {
            const { settings } = await collections();
            const row = await settings.findOne({ _id: String(id) }, { projection: { reactions_enabled: 1 } });
            return row?.reactions_enabled !== false;
        },
        async setPending(userId, chatId, mode = 'reactions', payload = null, ttlMs = 5 * 60 * 1000) {
            const { pending } = await collections();
            await pending.updateOne({ _id: String(userId) }, { $set: { user_id: Number(userId), chat_id: Number(chatId), mode, payload, expires_at: Date.now() + ttlMs } }, { upsert: true });
        },
        async getPending(userId) {
            const { pending } = await collections();
            const row = await pending.findOne({ _id: String(userId) });
            if (!row) return null;
            if (Number(row.expires_at) < Date.now()) { await pending.deleteOne({ _id: String(userId) }); return null; }
            return { chatId: Number(row.chat_id), mode: row.mode || 'reactions', payload: row.payload ?? null };
        },
        async clearPending(userId) {
            const { pending } = await collections();
            await pending.deleteOne({ _id: String(userId) });
        },
        async getGroupSettings(id) {
            const { settings } = await collections();
            const row = await settings.findOne({ _id: String(id) });
            return normalizeSettings(row);
        },
        async updateGroupSettings(id, patch) {
            const { settings } = await collections();
            await settings.updateOne({ _id: String(id) }, { $set: { chat_id: Number(id), ...patch } }, { upsert: true });
        },
        async counts() {
            const { chats } = await collections();
            const rows = await chats.aggregate([{ $group: { _id: '$kind', n: { $sum: 1 } } }]).toArray();
            const counts = { users: 0, groups: 0, channels: 0 };
            for (const row of rows) if (row._id in counts) counts[row._id] = row.n;
            return counts;
        },
        async ids(kinds, afterId = Number.MIN_SAFE_INTEGER, limit = 1000000) {
            const { chats } = await collections();
            const rows = await chats.find({ kind: { $in: kinds }, id: { $gt: Number(afterId) } }, { projection: { id: 1 } }).sort({ id: 1 }).limit(limit).toArray();
            return rows.map(row => Number(row.id));
        },
        flush() {},
        async close() { await client.close(); }
    };
}

function normalizeSettings(row) {
    return {
        reactions_enabled: row?.reactions_enabled !== false,
        reactions: Array.isArray(row?.reactions) ? row.reactions : null,
        welcome_enabled: row?.welcome_enabled !== false,
        welcome_mode: row?.welcome_mode || 'group',
        welcome_message: row?.welcome_message || '',
        welcome_buttons: Array.isArray(row?.welcome_buttons) ? row.welcome_buttons : [],
        join_enabled: row?.join_enabled !== false,
        join_mode: row?.join_mode || 'notify',
        join_message: row?.join_message || '',
        join_buttons: Array.isArray(row?.join_buttons) ? row.join_buttons : []
    };
}
