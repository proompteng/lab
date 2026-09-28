Oirat (Discord Mention Bot)

Listens for @mentions, creates a thread from the triggering message, and replies in-thread using the Jangar completion endpoint. Subsequent messages in bot-owned threads continue the conversation without requiring @mentions.

## Development

```bash
bun --cwd services/oirat run dev
```

Create a local env file from the example:

```bash
cp services/oirat/.env.example services/oirat/.env
```

## Environment

Required:

- `DISCORD_BOT_TOKEN`
- `JANGAR_BASE_URL` (e.g. `http://127.0.0.1:3000`)

Optional:

- `JANGAR_MODEL` (defaults to Jangar server default)
- `JANGAR_API_KEY` (sent as `Authorization: Bearer ...`)
- `JANGAR_SYSTEM_PROMPT` (system message at top of each thread)
- `DISCORD_ALLOWED_GUILD_IDS` (comma-separated allowlist)
- `DISCORD_ALLOWED_CHANNEL_IDS` (comma-separated allowlist)
- `DISCORD_HISTORY_LIMIT` (default: 24)
- `DISCORD_THREAD_NAME_PREFIX` (default: `Jangar`)
- `DISCORD_THREAD_AUTO_ARCHIVE_MINUTES` (default: 1440)

## Discord setup

- Enable the `MESSAGE CONTENT` privileged intent in the Discord developer portal.
- Invite the bot with `bot` + `applications.commands` scopes and `Send Messages`, `Create Public Threads`, and `Read Message History` permissions.

## Notes

- The bot only auto-responds in threads it creates (thread owner is the bot). In other threads it replies only when explicitly mentioned.
- Responses are chunked to stay under Discord's message length limits.
