#!/usr/bin/env bun

import { fatal } from '../shared/cli'
import { updateTengriRelease } from './release-manifests'

function valueAfter(args: string[], flag: string) {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: update-release.ts --tengri-digest sha256:<64 hex> --nanoagent-digest sha256:<64 hex>')
    return
  }
  const release = updateTengriRelease({
    tengriDigest: valueAfter(args, '--tengri-digest'),
    nanoagentDigest: valueAfter(args, '--nanoagent-digest'),
  })
  console.log(JSON.stringify(release))
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to update the Tengri release', error))
}
