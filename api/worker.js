import TelegramBotAPI from "./TelegramBotAPI.js";
import { htmlContent } from './constants.js';
import { splitEmojis, returnHTML, getChatIds } from "./helper.js";
import { onUpdate } from './bot-handler.js';
import { logger, setLogLevel } from './logger.js';
import { createD1Store } from './store-d1.js';
import { broadcastStep, progressText, finishText, errorText, editStatus } from './broadcast.js';

// Free plan allows 50 outgoing requests per invocation and 10 ms CPU,
// so a broadcast is split into small queue messages.
const BROADCAST_CHUNK = 20;
let webhookReady = false;

// Cache for parsed environment variables to avoid repeated parsing
let configCache = null;

function getConfig(env) {
    // Parse environment variables once and cache them
    if (!configCache || configCache.env !== env) {
        // Workers have no process.env, so apply the level from the request env.
        setLogLevel(env.LOG_LEVEL);
        configCache = {
            env: env,
            botToken: env.BOT_TOKEN,
            botUsername: env.BOT_USERNAME,
            reactions: splitEmojis(env.EMOJI_LIST),
            restrictedChats: getChatIds(env.RESTRICTED_CHATS),
            randomLevel: parseInt(env.RANDOM_LEVEL || '0', 10),
            botApi: new TelegramBotAPI(env.BOT_TOKEN),
            store: env.DB ? createD1Store(env.DB) : null,
            adminIds: getChatIds(env.ADMIN_IDS),
            updatesUrl: env.UPDATES_URL || undefined,
            supportUrl: env.SUPPORT_URL || undefined,
            startAnimation: env.START_ANIMATION || undefined,
            donateAnimation: env.DONATE_ANIMATION || undefined,
            uploadUrl: env.UPLOAD_URL || undefined,
            botUsername: env.BOT_USERNAME,
            defaultReactions: splitEmojis(env.EMOJI_LIST)
        };
    }
    return configCache;
}

export default {
    async fetch(request, env) {
        // Parse environment variables once at startup
        const config = getConfig(env);
        const url = new URL(request.url);

        // Health check endpoint
        if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
            // The deploy button does not know the final workers.dev/custom URL until deployment.
            // Configure Telegram automatically the first time the Worker is opened.
            if (env.AUTO_SET_WEBHOOK !== 'false' && !webhookReady && config.botToken) {
                try {
                    await config.botApi.setWebhook(url.origin + '/');
                    webhookReady = true;
                } catch (error) {
                    logger.warn('Automatic webhook setup failed:', error.message);
                }
            }
        }

        if (url.pathname === '/health' && request.method === 'GET') {
            return new Response(JSON.stringify({
                status: 'ok',
                timestamp: new Date().toISOString(),
                environment: env.NODE_ENV || 'production',
                botConfigured: !!config.botToken && !!config.botUsername
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (request.method === 'POST') {
            const data = await request.json()
            try {
                await onUpdate(
                    data,
                    config.botApi,
                    config.reactions,
                    config.restrictedChats,
                    config.botUsername,
                    config.randomLevel,
                    {
                        store: config.store,
                        adminIds: config.adminIds,
                        updatesUrl: config.updatesUrl,
                        supportUrl: config.supportUrl,
                        startAnimation: config.startAnimation,
                        donateAnimation: config.donateAnimation,
                        uploadUrl: config.uploadUrl,
                        botUsername: config.botUsername,
                        defaultReactions: config.reactions,
                        enqueueBroadcast: env.BROADCAST_QUEUE ? (job) => env.BROADCAST_QUEUE.send(job) : null
                    }
                )
            } catch (error) {
                logger.error('Error in onUpdate:', error.message)
            }
        } else {
            return returnHTML(htmlContent)
        }

        // Return HTTP 200.OK to Telegram
        return new Response('Ok', { status: 200 })
    },

    // One queue message = one small chunk of a broadcast
    async queue(batch, env) {
        const config = getConfig(env);
        for (const message of batch.messages) {
            let job = message.body;
            try {
                const step = await broadcastStep(config.botApi, config.store, job, BROADCAST_CHUNK);
                job = step.job;

                if (step.done) {
                    await editStatus(config.botApi, job, finishText(job));
                } else {
                    if (Date.now() - (job.lastEdit || 0) > 4000) {
                        job.lastEdit = Date.now();
                        await editStatus(config.botApi, job, progressText(job));
                    }
                    await env.BROADCAST_QUEUE.send(job, { delaySeconds: 1 });
                }
            } catch (error) {
                logger.error('Broadcast error:', error.message);
                await editStatus(config.botApi, job, errorText(job, error));
            }
            message.ack();
        }
    }
};
