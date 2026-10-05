import { chatKind } from './helper.js';

const SEEN_TTL = 10 * 60 * 1000;

export function createD1Store(db) {
    const seen = new Map();
    let ready = null;

    function init() {
        if (!ready) {
            ready = (async () => {
                await db.prepare('CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY, kind TEXT NOT NULL)').run();
                await db.prepare(`CREATE TABLE IF NOT EXISTS chat_settings (
                    chat_id INTEGER PRIMARY KEY,
                    reactions_enabled INTEGER NOT NULL DEFAULT 1,
                    reactions TEXT,
                    welcome_enabled INTEGER NOT NULL DEFAULT 1,
                    welcome_mode TEXT NOT NULL DEFAULT 'group',
                    welcome_message TEXT,
                    welcome_buttons TEXT,
                    join_enabled INTEGER NOT NULL DEFAULT 1,
                    join_mode TEXT NOT NULL DEFAULT 'notify',
                    join_message TEXT,
                    join_buttons TEXT
                )`).run();
                await db.prepare(`CREATE TABLE IF NOT EXISTS pending_settings (
                    user_id INTEGER PRIMARY KEY,
                    chat_id INTEGER NOT NULL,
                    mode TEXT NOT NULL DEFAULT 'reactions',
                    payload TEXT,
                    expires_at INTEGER NOT NULL
                )`).run();
                const migrations = [
                    'ALTER TABLE chat_settings ADD COLUMN welcome_enabled INTEGER NOT NULL DEFAULT 1',
                    "ALTER TABLE chat_settings ADD COLUMN welcome_mode TEXT NOT NULL DEFAULT 'group'",
                    'ALTER TABLE chat_settings ADD COLUMN welcome_message TEXT',
                    'ALTER TABLE chat_settings ADD COLUMN welcome_buttons TEXT',
                    'ALTER TABLE chat_settings ADD COLUMN join_enabled INTEGER NOT NULL DEFAULT 1',
                    "ALTER TABLE chat_settings ADD COLUMN join_mode TEXT NOT NULL DEFAULT 'notify'",
                    'ALTER TABLE chat_settings ADD COLUMN join_message TEXT',
                    'ALTER TABLE chat_settings ADD COLUMN join_buttons TEXT',
                    "ALTER TABLE pending_settings ADD COLUMN mode TEXT NOT NULL DEFAULT 'reactions'",
                    'ALTER TABLE pending_settings ADD COLUMN payload TEXT'
                ];
                for (const sql of migrations) { try { await db.prepare(sql).run(); } catch (_) {} }
            })().catch(error => { ready = null; throw error; });
        }
        return ready;
    }

    async function getRow(id) {
        await init();
        return db.prepare('SELECT * FROM chat_settings WHERE chat_id = ?1').bind(id).first();
    }

    function normalize(row) {
        return {
            reactions_enabled: row?.reactions_enabled !== 0,
            reactions: parseJson(row?.reactions),
            welcome_enabled: row?.welcome_enabled !== 0,
            welcome_mode: row?.welcome_mode || 'group',
            welcome_message: row?.welcome_message || '',
            welcome_buttons: parseJson(row?.welcome_buttons) || [],
            join_enabled: row?.join_enabled !== 0,
            join_mode: row?.join_mode || 'notify',
            join_message: row?.join_message || '',
            join_buttons: parseJson(row?.join_buttons) || []
        };
    }

    return {
        async add(id, type, { force = false } = {}) {
            const kind = chatKind(type);
            if (!kind) return;
            const last = seen.get(id);
            if (!force && last && Date.now() - last < SEEN_TTL) return;
            await init();
            await db.prepare('INSERT OR IGNORE INTO chats (id, kind) VALUES (?1, ?2)').bind(id, kind).run();
            seen.set(id, Date.now());
        },
        async remove(id) {
            await init(); seen.delete(id);
            await db.prepare('DELETE FROM chats WHERE id = ?1').bind(id).run();
            await db.prepare('DELETE FROM chat_settings WHERE chat_id = ?1').bind(id).run();
        },
        async setReactionsEnabled(id, enabled) {
            await init();
            await db.prepare(`INSERT INTO chat_settings (chat_id, reactions_enabled) VALUES (?1, ?2)
                ON CONFLICT(chat_id) DO UPDATE SET reactions_enabled = excluded.reactions_enabled`).bind(id, enabled ? 1 : 0).run();
        },
        async setReactions(id, reactions) {
            await init();
            await db.prepare(`INSERT INTO chat_settings (chat_id, reactions_enabled, reactions) VALUES (?1, 1, ?2)
                ON CONFLICT(chat_id) DO UPDATE SET reactions = excluded.reactions`).bind(id, JSON.stringify(reactions)).run();
        },
        async resetReactions(id) {
            await init(); await db.prepare('UPDATE chat_settings SET reactions = NULL WHERE chat_id = ?1').bind(id).run();
        },
        async getReactions(id) { return parseJson((await getRow(id))?.reactions); },
        async isReactionsEnabled(id) { return normalize(await getRow(id)).reactions_enabled; },
        async setPending(userId, chatId, mode = 'reactions', payload = null, ttlMs = 5 * 60 * 1000) {
            await init();
            await db.prepare(`INSERT INTO pending_settings (user_id, chat_id, mode, payload, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(user_id) DO UPDATE SET chat_id=excluded.chat_id, mode=excluded.mode, payload=excluded.payload, expires_at=excluded.expires_at`)
                .bind(userId, chatId, mode, payload == null ? null : JSON.stringify(payload), Date.now() + ttlMs).run();
        },
        async getPending(userId) {
            await init();
            const row = await db.prepare('SELECT chat_id, mode, payload, expires_at FROM pending_settings WHERE user_id = ?1').bind(userId).first();
            if (!row) return null;
            if (Number(row.expires_at) < Date.now()) { await db.prepare('DELETE FROM pending_settings WHERE user_id = ?1').bind(userId).run(); return null; }
            return { chatId: Number(row.chat_id), mode: row.mode, payload: parseJson(row.payload) };
        },
        async clearPending(userId) { await init(); await db.prepare('DELETE FROM pending_settings WHERE user_id = ?1').bind(userId).run(); },
        async getGroupSettings(id) { return normalize(await getRow(id)); },
        async updateGroupSettings(id, patch) {
            await init();
            const fields = Object.entries(patch).filter(([k]) => k !== 'chat_id');
            if (!fields.length) return;
            const columns = fields.map(([k]) => `${k} = ?`).join(', ');
            const values = fields.map(([,v]) => Array.isArray(v) ? JSON.stringify(v) : v);
            await db.prepare(`INSERT INTO chat_settings (chat_id) VALUES (?1) ON CONFLICT(chat_id) DO NOTHING`).bind(id).run();
            await db.prepare(`UPDATE chat_settings SET ${columns} WHERE chat_id = ?`).bind(...values, id).run();
        },
        async kindForId(id) { await init(); return (await db.prepare('SELECT kind FROM chats WHERE id = ?1').bind(id).first())?.kind || null; },
        async counts() {
            await init(); const { results } = await db.prepare('SELECT kind, COUNT(*) AS n FROM chats GROUP BY kind').all();
            const counts = { users: 0, groups: 0, channels: 0 };
            for (const row of results) if (row.kind in counts) counts[row.kind] = Number(row.n);
            return counts;
        },
        async ids(kinds, afterId = Number.MIN_SAFE_INTEGER, limit = 1000000) {
            await init();
            const marks = kinds.map((_, i) => `?${i + 3}`).join(',');
            const { results } = await db.prepare(`SELECT id FROM chats WHERE id > ?1 AND kind IN (${marks}) ORDER BY id LIMIT ?2`).bind(afterId, limit, ...kinds).all();
            return results.map(row => Number(row.id));
        }
    };
}

function parseJson(value) {
    if (!value) return null;
    try { return JSON.parse(value); } catch (_) { return null; }
}
