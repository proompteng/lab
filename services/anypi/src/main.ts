#!/usr/bin/env bun

import { runAnypi } from './run'

runAnypi().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
