#!/usr/bin/env bun
import { runCommand } from './runner'
import { withTemporalDefaults } from './shared'

interface ParsedArgs {
  help: boolean
  namespace?: string
  output?: string
  passthrough: string[]
  reason?: string
  temporalBinary: string
  workflowId?: string
  runId?: string
}

const HELP_TEXT = `Usage: cx-workflow-cancel [options] <workflow-id>

Cancel a Temporal workflow.

Options:
  -h, --help                   Show this help text.
  --temporal-binary <path>      Temporal CLI binary to invoke. [default: temporal]
  --namespace <name>            Namespace override.
  --output <json|text>          Force output format.
  --run-id <id>                 Workflow run id to cancel.
  --reason <text>               Cancel reason.
  --                                  Pass through remaining args.
`

const consumeValue = (args: string[], i: number): string => {
  const value = args[i + 1]
  if (!value || value.startsWith('-')) {
    throw new Error(`Missing value for ${args[i]}`)
  }
  return value
}

const parseWorkflowCancelArgs = (argv: string[]): ParsedArgs => {
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

    if (arg === '--temporal-binary') {
      parsed.temporalBinary = consumeValue(argv, i)
      i += 1
      continue
    }
    if (arg.startsWith('--temporal-binary=')) {
      parsed.temporalBinary = arg.substring('--temporal-binary='.length)
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

    if (arg === '--run-id') {
      parsed.runId = consumeValue(argv, i)
      i += 1
      continue
    }
    if (arg.startsWith('--run-id=')) {
      parsed.runId = arg.substring('--run-id='.length)
      continue
    }

    if (arg === '--reason') {
      parsed.reason = consumeValue(argv, i)
      i += 1
      continue
    }
    if (arg.startsWith('--reason=')) {
      parsed.reason = arg.substring('--reason='.length)
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
  }

  if (positional.length > 1) {
    throw new Error('Only workflow-id is expected as a positional argument.')
  }

  return parsed
}

export const main = async () => {
  let parsed: ParsedArgs
  try {
    parsed = parseWorkflowCancelArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(HELP_TEXT)
    return 1
  }

  if (parsed.help) {
    console.log(HELP_TEXT)
    return 0
  }

  if (!parsed.workflowId) {
    console.error('Missing required workflow-id argument.')
    console.error(HELP_TEXT)
    return 1
  }

  const args = withTemporalDefaults([
    'workflow',
    'cancel',
    '--workflow-id',
    parsed.workflowId,
    ...(parsed.namespace ? ['--namespace', parsed.namespace] : []),
    ...(parsed.runId ? ['--run-id', parsed.runId] : []),
    ...(parsed.output ? ['--output', parsed.output] : []),
    ...(parsed.reason ? ['--reason', parsed.reason] : []),
    ...parsed.passthrough,
  ])

  return await runCommand(parsed.temporalBinary, args)
}

if (import.meta.main) {
  const code = await main()
  process.exit(typeof code === 'number' ? code : 1)
}
