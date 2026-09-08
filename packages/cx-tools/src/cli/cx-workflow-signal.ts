#!/usr/bin/env bun

import { applyTemporalDefaults, exitWithError, requireOption, resolveBinary, runCommand, usage } from './_shared'

const usageText = `Usage: cx-workflow-signal [temporal workflow signal args]

Examples:
  cx-workflow-signal --workflow-id my-workflow-id --name your-signal --input '{}'

This command forwards arguments to:
  temporal workflow signal
`

export const main = async () => {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    usage(usageText)
    return 0
  }

  try {
    requireOption(args, 'workflow-id is required: pass --workflow-id', '--workflow-id', '-w')
    requireOption(args, 'signal name is required: pass --name', '--name')
    const binary = resolveBinary('temporal')
    const normalizedArgs = applyTemporalDefaults(args)
    const exitCode = await runCommand(binary, ['workflow', 'signal', ...normalizedArgs])
    return exitCode
  } catch (error) {
    if (error instanceof Error) {
      return exitWithError(error.message, usageText)
    }
    return exitWithError('Unexpected error while executing cx-workflow-signal')
  }
}

if (import.meta.main) {
  const code = await main()
  process.exit(typeof code === 'number' ? code : 1)
}
