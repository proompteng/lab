import { BunRuntime } from '@effect/platform-bun'

import { BaynMain } from './runtime'

if (import.meta.main) {
  BunRuntime.runMain(BaynMain, { disablePrettyLogger: true })
}
