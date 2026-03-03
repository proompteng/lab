#!/usr/bin/env bun

import { exitWithError, hasOption, resolveBinary, runCommand, usage } from './_shared'

const usageText = `Usage: cx-codex-run [codex exec options]

This command is a thin wrapper around:
  codex exec --json <args>

It enforces JSON event streaming by default unless --json is passed explicitly.
`

const buildArgs = (args: string[]) => {
  const baseArgs = ['exec', ...args]
  if (!hasOption(args, '--json')) {
    return [...baseArgs, '--json']
  }
  return baseArgs
}

export const main = async () => {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    usage(usageText)
    return 0
  }

  try {
    const binary = resolveBinary('codex')
    const exitCode = await runCommand(binary, buildArgs(args), {
      env: process.env,
    })
    return exitCode
  } catch (error) {
    if (error instanceof Error) {
      return exitWithError(error.message, usageText)
    }
    return exitWithError('Unexpected error while executing cx-codex-run')
  }
}

if (import.meta.main) {
  const code = await main()
  process.exit(typeof code === 'number' ? code : 1)
}
