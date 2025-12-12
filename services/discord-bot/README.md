# @proompteng/discord-bot

A small Discord gateway bot that streams chat completions from **Jangar** (the existing Codex app-server proxy) into Discord messages.

## Trigger mode

The bot responds **only** when the first token of a message is a mention of the bot:

```
<@BOT_ID> summarize this PR…
```

Everything after the mention is treated as the prompt.

## Threading (`x-openwebui-chat-id`)

Each prompt is sent to Jangar with a stable chat id:

```
discord:<guildId>:<channelId>:<authorId>
```

This keeps conversation state stable per-user, per-channel.

## Environment variables

- `DISCORD_BOT_TOKEN` (required): Discord bot token.
- `JANGAR_BASE_URL` (required): Base URL to Jangar (example: `http://127.0.0.1:3000`).
- `CODEX_MODEL` (optional): Overrides the model sent to Jangar. Default: `gpt-5.1-codex-max`.
- `DISCORD_ALLOWED_GUILD_IDS` (optional): Comma-separated allowlist of guild IDs.
- `DISCORD_ALLOWED_CHANNEL_IDS` (optional): Comma-separated allowlist of channel IDs.

## Discord configuration

The bot requires these gateway intents:

- `Guilds`
- `GuildMessages`
- `MessageContent` (privileged)

## Local development

```bash
cd services/discord-bot
DISCORD_BOT_TOKEN=... \
JANGAR_BASE_URL=http://127.0.0.1:3000 \
bun run dev
```

## Tests

```bash
cd services/discord-bot
bun run test
```
