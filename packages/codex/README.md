# @proompteng/codex

Minimal wrapper around the Codex CLI that mirrors the TypeScript SDK primitives (Codex, Thread, run/runStreamed).

Usage:

```ts
import { Codex } from '@proompteng/codex'

const codex = new Codex()
const thread = codex.startThread({ workingDirectory: process.cwd(), approvalPolicy: 'never' })

const { finalResponse } = await thread.run('summarize the repo')
console.log(finalResponse)
```

Authentication is handled by the Codex CLI itself. Log in once via `codex login` (or copy `$HOME/.codex/auth.json` onto the host) and the wrapper will reuse that session. Set `codexPathOverride` if the `codex` binary is not on `PATH`.

```
const codex = new Codex({ codexPathOverride: '/usr/local/bin/codex' })
```
