#!/usr/bin/env bun

import { exit } from 'node:process'
import { runSkillCli } from '../skills/cli'

export const main = async () => {
  const { args, flags } = parseArgs(process.argv.slice(2))

  try {
    const result = await runSkillCli(args, flags)
    if (result && typeof result.exitCode === 'number') {
      exit(result.exitCode)
      return
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    exit(1)
    return
  }
}

export function parseArgs(argv: string[]) {
  const args: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (!value.startsWith('-')) {
      args.push(value)
      continue
    }

    const trimmed = value.replace(/^-+/, '')
    if (trimmed.length === 0) {
      continue
    }

    const equalsIndex = trimmed.indexOf('=')
    if (equalsIndex !== -1) {
      const key = trimmed.slice(0, equalsIndex)
      const flagValue = trimmed.slice(equalsIndex + 1)
      flags[key] = flagValue
      continue
    }

    const key = trimmed
    const next = argv[index + 1]
    if (next && !next.startsWith('-')) {
      flags[key] = next
      index++
      continue
    }

    flags[key] = true
  }

  return { args, flags }
}

if (import.meta.main) {
  await main()
}
