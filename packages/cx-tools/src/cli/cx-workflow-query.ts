#!/usr/bin/env bun

import {
  applyTemporalDefaults,
  exitWithError,
  getOptionValue,
  hasOption,
  requireOption,
  resolveBinary,
  runCommand,
  usage,
} from './_shared'

const usageText = `Usage: cx-workflow-query [temporal workflow query args]

Examples:
  cx-workflow-query --workflow-id my-workflow-id --query-type your-query

This command forwards arguments to:
  temporal workflow query

Output is requested as JSON by default.
`

const withJsonOutput = (args: string[]) => {
  if (hasOption(args, '--output', '-o')) {
    return args
  }
  return [...args, '--output', 'json']
}

export const main = async () => {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    usage(usageText)
    return 0
  }

  try {
    requireOption(args, 'workflow-id is required: pass --workflow-id', '--workflow-id', '-w')
    requireOption(args, 'query-type is required: pass --query-type', '--query-type', '--query')
    const binary = resolveBinary('temporal')
    const normalizedArgs = withJsonOutput(applyTemporalDefaults(args))
    const queryType = getOptionValue(normalizedArgs, '--query-type', '--query')
    if (!queryType) {
      return exitWithError('Missing --query-type value', usageText)
    }
    const exitCode = await runCommand(binary, ['workflow', 'query', ...normalizedArgs])
    return exitCode
  } catch (error) {
    if (error instanceof Error) {
      return exitWithError(error.message, usageText)
    }
    return exitWithError('Unexpected error while executing cx-workflow-query')
  }
}

if (import.meta.main) {
  const code = await main()
  process.exit(typeof code === 'number' ? code : 1)
}
