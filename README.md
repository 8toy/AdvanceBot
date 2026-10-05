# ⚡ Telegram Auto Reaction Bot — V5

A multi-platform Telegram bot built around one shared codebase.

## ✨ Included

- ❤️ Automatic reactions for groups and channels
- ⚙️ `/groupsetting` — single admin/owner dashboard for group features
- 🛡️ `/joinsetting` — private-channel join-request dashboard
- 👋 Custom group welcome messages
- 👤 Welcome mode: **Only User** (Telegram ephemeral message) or **Group**
- 🔘 Custom welcome buttons with `primary`, `success`, `danger` styles
- 🛡️ Private channel/group join-request handling
- 🔔 Join-request **Notify Only** mode
- ✅ Join-request **Auto Accept** mode
- 📝 Custom join-request message and buttons
- ❤️ Per-group/channel custom reactions
- 📢 Copy/Forward broadcast
- 📌 Pin/Without Pin broadcast option
- ❓ Help screen with Back navigation
- 🔗 `/start start` deep-link compatible
- ☁️ Cloudflare Workers + D1 + Queues
- 🍃 MongoDB Atlas support on Node-based hosts
- 🐳 Docker support
- ▲ Vercel webhook/serverless support
- 🚂 Railway, Koyeb, Heroku and VPS support

---

# 🗂️ Storage architecture

The project deliberately uses two database adapters:

| Platform | Storage |
|---|---|
| Cloudflare Workers | **D1 + Queues** |
| Koyeb | **MongoDB** |
| Railway | **MongoDB** |
| Heroku | **MongoDB** |
| VPS | **MongoDB** |
| Docker | **MongoDB** |
| Vercel | **MongoDB** |
| Local Node | MongoDB or JSON fallback |

The MongoDB driver is imported only by the Node entrypoint, so the Cloudflare Worker bundle does not load the Node MongoDB driver.

Cloudflare D1 is available on Workers Free; current free limits include 5 million rows read/day, 100,000 rows written/day and 5 GB total storage. D1 daily limits are enforced, so heavy usage can require a paid plan.

Cloudflare Queues are also available on Workers Free with 10,000 operations/day; Free retention is 24 hours.

---

# ⚙️ Group Settings

Add the bot as an administrator in a group and run:

```text
/groupsetting
```

Only a Telegram group **owner/administrator** can open or change the panel.

The panel controls:

```text
👋 Welcome
   ├─ Enable / Disable
   ├─ Change Message
   ├─ Only User
   ├─ Group
   └─ Welcome Buttons

❤️ Reactions
   └─ Enable / Disable

🛡️ Join Requests
   ├─ Enable / Disable
   ├─ Auto Accept
   ├─ Notify Only
   ├─ Request Message
   └─ Request Buttons

👁 Preview
```

## Welcome variables

Use these in a custom welcome message:

```text
{name}
{username}
{mention}
{group}
```

Example:

```text
👋 Welcome {mention} to <b>{group}</b>!
Please read the rules and enjoy your stay. ❤️
```

### Only User

Telegram's current Bot API supports ephemeral messages, which can be sent inside a group to one selected user. The bot uses the current `ephemeral_message_parameters` API shape.

If Telegram cannot deliver the ephemeral message, the bot falls back to a private message when possible.

---

# 🛡️ Join Requests

For a private channel or group using join requests, add the bot as an administrator with the required invite-user permission.

Telegram sends `chat_join_request` updates to eligible bot administrators, and the bot can approve or decline requests through the Bot API. The request's `user_chat_id` can be used for a short period to message the requester before the request is processed.

Modes:

### 🔔 Notify Only

The bot sends the configured message to the requester and leaves the request pending.

### ✅ Auto Accept

The bot sends the configured notification, approves the request, then sends an acceptance confirmation.

---

# ☁️ Cloudflare Workers — Free / One Click

### Deploy button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/a-if/Reactions/tree/main)

The Worker uses:

- Workers
- D1
- Queues
- Worker environment variables/secrets

### Required

```text
BOT_TOKEN       → Telegram BotFather token (SECRET)
BOT_USERNAME    → Bot username without @
```

Optional:

```text
ADMIN_IDS
UPDATES_URL
SUPPORT_URL
UPLOAD_URL
EMOJI_LIST
RANDOM_LEVEL
RESTRICTED_CHATS
START_ANIMATION
DONATE_ANIMATION
```

**Never commit the real BOT_TOKEN to GitHub.**

After deployment, open the Worker URL once. `AUTO_SET_WEBHOOK=true` makes the Worker configure its Telegram webhook automatically.

### Manual Cloudflare deployment

```bash
npm install
npx wrangler login
npx wrangler deploy
```

Set the token as a Worker secret rather than putting the real token into source control.

---

# 🍃 MongoDB Atlas — Node hosts

MongoDB is the preferred persistent database for Koyeb, Railway, Heroku, VPS, Docker and Vercel.

MongoDB's official Node.js driver supports Atlas and the current driver can connect using a MongoDB connection URI.

Create a MongoDB Atlas deployment, create a database user, then copy the driver connection string. citeturn0search1

Set:

```env
MONGODB_URL=mongodb+srv://USERNAME:PASSWORD@CLUSTER.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=reaction-bot
```

The bot creates its collections automatically:

```text
chats
chat_settings
pending_settings
```

---

# 🚂 Railway

1. Create a new Railway project.
2. Deploy this GitHub repository.
3. Add the environment variables from `.env.example`.
4. Set `MONGODB_URL` and `MONGODB_DB`.
5. Set `WEBHOOK_URL` to the public HTTPS URL of the service.
6. Railway starts the bot with:

```bash
npm start
```

The included `railway.json` configures the start command and `/health` check.

---

# 🟢 Koyeb

Create a Web Service from the repository.

Set:

```env
BOT_TOKEN=...
BOT_USERNAME=...
MONGODB_URL=...
MONGODB_DB=reaction-bot
WEBHOOK_URL=https://YOUR-KOYEB-DOMAIN/
```

Start command:

```bash
npm start
```

Port:

```text
3000
```

The included `koyeb.yaml` contains the basic service/health configuration.

---

# 🟠 Heroku

Create an app and deploy the repository.

Set Config Vars:

```text
BOT_TOKEN
BOT_USERNAME
MONGODB_URL
MONGODB_DB
WEBHOOK_URL
ADMIN_IDS
```

The included `Procfile` runs:

```text
web: npm start
```

---

# ▲ Vercel

Vercel should be used as a **webhook/serverless endpoint**, not as a permanent background worker.

1. Import the repository into Vercel.
2. Add:

```text
BOT_TOKEN
BOT_USERNAME
MONGODB_URL
MONGODB_DB
ADMIN_IDS
```

3. Deploy.
4. Set `WEBHOOK_URL` to the deployed Vercel URL if you want automatic webhook setup.

The Express app is exported for Vercel instead of calling `app.listen()` inside the serverless runtime.

---

# 🖥️ VPS

```bash
sudo apt update
sudo apt install -y git nodejs npm

git clone YOUR_REPOSITORY
cd Reactions
npm install
cp .env.example .env
nano .env
npm start
```

Use a process manager such as PM2 for production:

```bash
npm install -g pm2
pm2 start api/index.js --name auto-reaction-bot
pm2 save
pm2 startup
```

Set `WEBHOOK_URL` to your HTTPS reverse-proxy URL.

---

# 🐳 Docker

```bash
cp .env.example .env
nano .env

docker compose up -d --build
```

The container exposes port `3000`.

For production, use MongoDB instead of relying on the JSON fallback:

```env
MONGODB_URL=...
MONGODB_DB=reaction-bot
```

---

# 🔐 Security

Never put these in GitHub:

```text
BOT_TOKEN
MONGODB_URL
MONGODB passwords
```

Use platform secrets/environment variables.

If a Telegram bot token is ever exposed publicly, revoke it immediately with BotFather and create a new one.

---

# 🔧 Telegram permissions

## Group

Give the bot enough permissions to:

- receive required updates
- send messages
- react to messages
- pin messages if broadcast pinning is required

For the welcome system, Telegram must deliver the relevant member updates to the bot.

## Private channel / join requests

The bot must be an administrator with the required invite-user permission. Telegram documents this requirement for receiving and processing join requests.

---

# 🧪 Local development

```bash
npm install
cp .env.example .env
npm start
```

Health check:

```text
GET /health
```

For local webhook testing, expose the server through an HTTPS tunnel and set `WEBHOOK_URL` accordingly.

---

# 📋 Main commands

```text
/start
/help
/reactions
/groupsetting
/reactions_on
/reactions_off
/donate
/stats
/users
/broadcast
```

`/stats`, `/users` and `/broadcast` are global-admin commands controlled by `ADMIN_IDS`.

---

# 📌 Notes

- Cloudflare uses D1/Queues; it does **not** load the MongoDB Node driver in the Worker entrypoint.
- Node deployments use MongoDB when `MONGODB_URL` is configured.
- Local Node can fall back to JSON storage when MongoDB is omitted.
- Vercel is intended for webhook/serverless execution.
- Railway/Koyeb/Heroku/VPS/Docker are better suited to the always-running Node deployment model.
