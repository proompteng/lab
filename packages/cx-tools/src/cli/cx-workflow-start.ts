#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { runCommand } from './runner'
import { withTemporalDefaults } from './shared'

interface ParsedArgs {
  help: boolean
  input?: string
  inputFile?: string
  namespace?: string
  output?: string
  passthrough: string[]
  temporalBinary: string
  taskQueue?: string
  workflowId?: string
  workflowType?: string
}

const HELP_TEXT = `Usage: cx-workflow-start [options] <workflow-id> <workflow-type>

Start a Temporal workflow and stream CLI output.

Options:
  -h, --help                   Show this help text.
  --temporal-binary <path>      Temporal CLI binary to invoke. [default: temporal]
  --namespace <name>            Namespace override.
  --output <json|text>          Force output format.
  --task-queue <name>          Task queue for workflow execution.
  --workflow-id <id>           Override positional workflow-id.
  --workflow-type <type>       Override positional workflow-type.
  --input <json>               Workflow input JSON string.
  --input-file <path>          Read workflow input JSON from file.
  --                                  Pass through remaining args.
`

const consumeValue = (args: string[], i: number): string => {
  const value = args[i + 1]
  if (!value || value.startsWith('-')) {
    throw new Error(`Missing value for ${args[i]}`)
  }
  return value
}

const parseWorkflowStartArgs = (argv: string[]): ParsedArgs => {
  const parsed: ParsedArgs = {
    help: false,
    passthrough: [],
    temporalBinary: 'temporal',
  }

  const positional: string[] = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (!arg) {
      continue
    }

    if (arg === '--') {
      parsed.passthrough.push(...argv.slice(i + 1))
      break
    }

    if (!arg.startsWith('-')) {
      positional.push(arg)
      continue
    }

    if (arg === '-h' || arg === '--help') {
      parsed.help = true
      continue
    }

    if (arg.startsWith('--temporal-binary=')) {
      parsed.temporalBinary = arg.substring('--temporal-binary='.length)
      continue
    }
    if (arg === '--temporal-binary') {
      parsed.temporalBinary = consumeValue(argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--namespace=')) {
      parsed.namespace = arg.substring('--namespace='.length)
      continue
    }
    if (arg === '--namespace') {
      parsed.namespace = consumeValue(argv, i)
      i += 1
      continue
    }

    if (arg === '--output') {
      parsed.output = consumeValue(argv, i)
      i += 1
      continue
    }
    if (arg.startsWith('--output=')) {
      parsed.output = arg.substring('--output='.length)
      continue
    }

    if (arg.startsWith('--task-queue=')) {
      parsed.taskQueue = arg.substring('--task-queue='.length)
      continue
    }
    if (arg === '--task-queue') {
      parsed.taskQueue = consumeValue(argv, i)
      i += 1
      continue
    }

    if (arg === '--workflow-id') {
      parsed.workflowId = consumeValue(argv, i)
      i += 1
      continue
    }
    if (arg.startsWith('--workflow-id=')) {
      parsed.workflowId = arg.substring('--workflow-id='.length)
      continue
    }

    if (arg === '--workflow-type') {
      parsed.workflowType = consumeValue(argv, i)
      i += 1
      continue
    }
    if (arg.startsWith('--workflow-type=')) {
      parsed.workflowType = arg.substring('--workflow-type='.length)
      continue
    }

    if (arg === '--input') {
      parsed.input = consumeValue(argv, i)
      i += 1
      continue
    }
    if (arg.startsWith('--input=')) {
      parsed.input = arg.substring('--input='.length)
      continue
    }

    if (arg === '--input-file') {
      parsed.inputFile = consumeValue(argv, i)
      i += 1
      continue
    }
    if (arg.startsWith('--input-file=')) {
      parsed.inputFile = arg.substring('--input-file='.length)
      continue
    }

    if (arg.startsWith('--')) {
      if (arg.includes('=')) {
        parsed.passthrough.push(arg)
      } else if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
        parsed.passthrough.push(arg, argv[i + 1])
        i += 1
      } else {
        parsed.passthrough.push(arg)
      }
      continue
    }

    parsed.passthrough.push(arg)
  }

  if (positional.length > 0) {
    parsed.workflowId = parsed.workflowId ?? positional[0]
    parsed.workflowType = parsed.workflowType ?? positional[1]
  }

  if (positional.length > 2) {
    throw new Error('Only workflow-id and workflow-type are expected as positional arguments.')
  }

  return parsed
}

const parseInput = async (options: ParsedArgs): Promise<string | undefined> => {
  if (options.input && options.inputFile) {
    throw new Error('Use either --input or --input-file, not both.')
  }

  if (!options.input && !options.inputFile) {
    return undefined
  }

  if (options.input) {
    return options.input
  }

  const loaded = await readFile(resolve(options.inputFile ?? ''), 'utf8')
  const normalized = loaded.trim()
  if (!normalized) {
    throw new Error(`Workflow input file was empty: ${options.inputFile}`)
  }

  return normalized
}

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
