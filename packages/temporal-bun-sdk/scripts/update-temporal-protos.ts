#!/usr/bin/env bun

import { $ } from 'bun'

const main = async () => {
  // TODO(TBS-007): Parameterise Temporal version, validate buf installation,
  // and sync proto overlays before regenerating TypeScript stubs.
  console.log('[temporal-bun-sdk] proto update scaffold – not yet implemented.')
  await $`echo TODO`
}

await main()
