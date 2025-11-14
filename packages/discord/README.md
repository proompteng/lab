# @proompteng/discord

Shared Discord channel helpers extracted from Froussard. Provides utilities to create stage-specific channels, chunk messages, bootstrap channel streams, and pipe Codex output into Discord.

Usage:

```ts
import { bootstrapChannel, streamChannel } from '@proompteng/discord'

const channel = await bootstrapChannel({ botToken, guildId }, metadata)
await streamChannel({ botToken, guildId }, channel, myIterable)
```

Consumers (e.g., `apps/froussard` and `apps/froussard/scripts/discord-relay.ts`) should import from this package instead of copying the implementation.
