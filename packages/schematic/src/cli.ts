#!/usr/bin/env bun
import { runCli } from './index'

const parseArgs = () => {
  const args = process.argv.slice(2)
  const opts: { dryRun?: boolean; force?: boolean; name?: string } = {}

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--dry-run' || arg === '-n') {
      opts.dryRun = true
    } else if (arg === '--force' || arg === '-f') {
      opts.force = true
    } else if (arg === '--name' && args[i + 1]) {
      opts.name = args[i + 1]
      i += 1
    }
  }

  return opts
}

runCli(parseArgs()).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
