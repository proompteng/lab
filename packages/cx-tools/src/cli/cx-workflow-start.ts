#!/usr/bin/env bun

import { applyTemporalDefaults, exitWithError, hasOption, resolveBinary, runCommand, usage } from './_shared'

const usageText = `Usage: cx-workflow-start [temporal workflow start args]

This command forwards arguments to:
  temporal workflow start

Common examples:
  cx-workflow-start --task-queue default --workflow-type Worker --workflow-id example --input '{}'
`

export const main = async () => {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    usage(usageText)
    return 0
  }

  try {
    const binary = resolveBinary('temporal')
    const taskQueue = process.env.TEMPORAL_TASK_QUEUE?.trim() || process.env.TEMPORAL_TASK_QUEUE_ID?.trim()
    let normalizedArgs = applyTemporalDefaults(args)

    if (!hasOption(normalizedArgs, '--task-queue', '--task_queue')) {
      if (!taskQueue) {
        return exitWithError('Missing --task-queue and TEMPORAL_TASK_QUEUE is not set.', usageText)
      }
      normalizedArgs = [...normalizedArgs, '--task-queue', taskQueue]
    }

    const exitCode = await runCommand(binary, ['workflow', 'start', ...normalizedArgs])

    return exitCode
  } catch (error) {
    if (error instanceof Error) {
      return exitWithError(error.message, usageText)
    }
    return exitWithError('Unexpected error while executing cx-workflow-start')
  }
}

if (import.meta.main) {
  const code = await main()
  process.exit(typeof code === 'number' ? code : 1)
}
