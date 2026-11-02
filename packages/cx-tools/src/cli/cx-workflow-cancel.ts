#!/usr/bin/env bun

import { applyTemporalDefaults, exitWithError, requireOption, resolveBinary, runCommand, usage } from './_shared'

const usageText = `Usage: cx-workflow-cancel [temporal workflow cancel args]

Examples:
  cx-workflow-cancel --workflow-id my-workflow-id
  cx-workflow-cancel --workflow-id my-workflow-id --run-id my-run-id

This command forwards arguments to:
  temporal workflow cancel
`

export const main = async () => {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    usage(usageText)
    return 0
  }

  try {
    requireOption(args, 'workflow-id is required: pass --workflow-id', '--workflow-id', '-w')
    const binary = resolveBinary('temporal')
    const normalizedArgs = applyTemporalDefaults(args)
    const exitCode = await runCommand(binary, ['workflow', 'cancel', ...normalizedArgs])

    return exitCode
  } catch (error) {
    if (error instanceof Error) {
      return exitWithError(error.message, usageText)
    }
    return exitWithError('Unexpected error while executing cx-workflow-cancel')
  }
}

if (import.meta.main) {
  const code = await main()
  process.exit(typeof code === 'number' ? code : 1)
}
