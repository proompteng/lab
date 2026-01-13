#!/usr/bin/env bun

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const VERSION = '0.1.0'
const EXIT_VALIDATION = 2
const EXIT_KUBE = 3
const EXIT_RUNTIME = 4
const EXIT_UNKNOWN = 5

class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

type GlobalFlags = {
  kubeconfig?: string
  context?: string
  namespace?: string
  output?: string
}

type CommandResult = {
  stdout: string
  stderr: string
  code: number | null
}

const runCommand = (command: string, args: string[], input?: string): Promise<CommandResult> =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ stdout, stderr, code }))
    if (input) {
      child.stdin.write(input)
    }
    child.stdin.end()
  })

const runKubectl = async (args: string[], flags: GlobalFlags, input?: string) => {
  const base = [...args]
  if (flags.kubeconfig) {
    base.push('--kubeconfig', flags.kubeconfig)
  }
  if (flags.context) {
    base.push('--context', flags.context)
  }
  if (flags.namespace && !base.includes('-n') && !base.includes('--namespace')) {
    base.push('-n', flags.namespace)
  }
  return runCommand('kubectl', base, input)
}

const parseGlobalFlags = (argv: string[]) => {
  const flags: GlobalFlags = {}
  const rest: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue
    if (arg === '--kubeconfig') {
      flags.kubeconfig = argv[++i]
      continue
    }
    if (arg === '--context') {
      flags.context = argv[++i]
      continue
    }
    if (arg === '--namespace' || arg === '-n') {
      flags.namespace = argv[++i]
      continue
    }
    if (arg === '--output' || arg === '-o') {
      flags.output = argv[++i]
      continue
    }
    rest.push(arg)
  }
  return { flags, rest }
}

const usage = () =>
  `
agentctl ${VERSION}

Usage:
  agentctl version
  agentctl config view|set --namespace <ns>
  agentctl completion <shell>

  agentctl agent get <name>
  agentctl agent list
  agentctl agent apply -f <file>
  agentctl agent delete <name>

  agentctl impl get <name>
  agentctl impl list
  agentctl impl create --text <text> [--summary <text>] [--source provider=github,externalId=...,url=...]
  agentctl impl apply -f <file>
  agentctl impl delete <name>

  agentctl source list
  agentctl source apply -f <file>
  agentctl source delete <name>

  agentctl memory list
  agentctl memory apply -f <file>
  agentctl memory delete <name>

  agentctl run submit --agent <name> --impl <name> --runtime <type> [flags]
  agentctl run apply -f <file>
  agentctl run get <name>
  agentctl run list
  agentctl run logs <name> [--follow]
  agentctl run cancel <name>

Global flags:
  --kubeconfig <path>
  --context <name>
  --namespace <ns>
  --output <yaml|json|table>

Run submit flags:
  --workload-image <image>
  --cpu <value>
  --memory <value>
  --memory-ref <name>
  --param key=value
  --runtime-config key=value
  --idempotency-key <value>
  --wait
`.trim()

const ensureOutput = (flags: GlobalFlags) => flags.output ?? 'table'

const handleKubectl = async (args: string[], flags: GlobalFlags, input?: string) => {
  const result = await runKubectl(args, flags, input)
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.code !== 0) {
    reportMissingCrds(result.stderr || result.stdout)
  }
  return result.code === 0 ? 0 : EXIT_KUBE
}

const parseKeyValueList = (values: string[]) => {
  const output: Record<string, string> = {}
  for (const item of values) {
    const [key, ...rest] = item.split('=')
    if (!key) continue
    output[key] = rest.join('=')
  }
  return output
}

const parseSource = (raw?: string) => {
  if (!raw) return undefined
  const fields = raw.split(',').map((entry) => entry.trim())
  const source: Record<string, string> = {}
  for (const field of fields) {
    const [key, ...rest] = field.split('=')
    if (!key) continue
    source[key] = rest.join('=')
  }
  if (!source.provider) return undefined
  return source
}

const isMissingCrdsMessage = (message: string) =>
  message.includes("the server doesn't have a resource type") || message.includes('no matches for kind')

const reportMissingCrds = (stderr: string) => {
  if (!isMissingCrdsMessage(stderr)) return
  console.error('Agents CRDs not found. Install the agents chart or apply CRDs before retrying.')
}

const handleRunSubmit = async (args: string[], flags: GlobalFlags) => {
  const params: Record<string, string[]> = { param: [], runtimeConfig: [] }
  const options: Record<string, string> = {}

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '--agent' || arg === '--impl' || arg === '--runtime' || arg === '--workload-image') {
      options[arg.slice(2)] = args[++i]
      continue
    }
    if (arg === '--cpu' || arg === '--memory' || arg === '--idempotency-key' || arg === '--memory-ref') {
      options[arg.slice(2)] = args[++i]
      continue
    }
    if (arg === '--param') {
      params.param.push(args[++i])
      continue
    }
    if (arg === '--runtime-config') {
      params.runtimeConfig.push(args[++i])
      continue
    }
    if (arg === '--wait') {
      options.wait = 'true'
    }
  }

  if (!options.agent || !options.impl || !options.runtime) {
    throw new ValidationError('--agent, --impl, and --runtime are required')
  }

  const runSpec: Record<string, unknown> = {
    apiVersion: 'agents.proompteng.ai/v1alpha1',
    kind: 'AgentRun',
    metadata: {
      generateName: `${options.agent}-`,
      namespace: flags.namespace,
    },
    spec: {
      agentRef: { name: options.agent },
      implementationSpecRef: { name: options.impl },
      runtime: {
        type: options.runtime,
        config: parseKeyValueList(params.runtimeConfig),
      },
      parameters: parseKeyValueList(params.param),
      idempotencyKey: options['idempotency-key'] ?? randomUUID(),
    },
  }

  if (options['workload-image']) {
    runSpec.spec = runSpec.spec ?? {}
    ;(runSpec.spec as Record<string, unknown>).workload = { image: options['workload-image'] }
  }

  if (options.cpu || options.memory) {
    const workload = (runSpec.spec as Record<string, unknown>).workload as Record<string, unknown> | undefined
    const resources: Record<string, unknown> = { requests: {} }
    if (options.cpu) (resources.requests as Record<string, unknown>).cpu = options.cpu
    if (options.memory) (resources.requests as Record<string, unknown>).memory = options.memory
    ;(runSpec.spec as Record<string, unknown>).workload = { ...(workload ?? {}), resources }
  }

  if (options['memory-ref']) {
    ;(runSpec.spec as Record<string, unknown>).memoryRef = { name: options['memory-ref'] }
  }

  const result = await runKubectl(['create', '-f', '-', '-o', 'json'], flags, JSON.stringify(runSpec))
  if (result.code !== 0) {
    reportMissingCrds(result.stderr || result.stdout)
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    return EXIT_KUBE
  }
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  const code = result.code ?? 1
  if (code !== 0 || options.wait !== 'true') return code === 0 ? 0 : EXIT_KUBE

  const created = JSON.parse(result.stdout)
  const name = created.metadata?.name
  if (!name) return code
  return handleRunWait(name, flags)
}

const handleRunWait = async (name: string, flags: GlobalFlags) => {
  const deadline = Date.now() + 60 * 60 * 1000
  while (Date.now() < deadline) {
    const result = await runKubectl(['get', 'agentruns.agents.proompteng.ai', name, '-o', 'json'], flags)
    if (result.code !== 0) return EXIT_KUBE
    const resource = JSON.parse(result.stdout)
    const phase = resource.status?.phase
    if (phase && ['Succeeded', 'Failed', 'Cancelled'].includes(phase)) {
      console.log(`AgentRun ${name} ${phase}`)
      return 0
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  console.error('Timed out waiting for AgentRun completion')
  return EXIT_RUNTIME
}

const handleRunLogs = async (name: string, flags: GlobalFlags, follow: boolean) => {
  const result = await runKubectl(['get', 'agentruns.agents.proompteng.ai', name, '-o', 'json'], flags)
  if (result.code !== 0) return result.code ?? 1
  const resource = JSON.parse(result.stdout)
  const runtimeRef = resource.status?.runtimeRef ?? {}
  const runtimeType = runtimeRef.type ?? resource.spec?.runtime?.type
  const runtimeName = runtimeRef.name

  if (runtimeType === 'job' && runtimeName) {
    return handleKubectl(['logs', `job/${runtimeName}`, ...(follow ? ['-f'] : [])], flags)
  }

  return handleKubectl(['logs', '-l', `agents.proompteng.ai/agent-run=${name}`, ...(follow ? ['-f'] : [])], flags)
}

const handleRunCancel = async (name: string, flags: GlobalFlags) => {
  const result = await runKubectl(['get', 'agentruns.agents.proompteng.ai', name, '-o', 'json'], flags)
  if (result.code !== 0) return result.code ?? 1
  const resource = JSON.parse(result.stdout)
  const runtimeRef = resource.status?.runtimeRef ?? {}
  const runtimeType = runtimeRef.type ?? resource.spec?.runtime?.type
  const runtimeName = runtimeRef.name

  if (runtimeType === 'job' && runtimeName) {
    return handleKubectl(['delete', 'job', runtimeName], flags)
  }
  if (runtimeType === 'argo' && runtimeName) {
    return handleKubectl(['delete', 'workflow', runtimeName], flags)
  }
  console.error('No cancellable runtime found for this AgentRun')
  return EXIT_RUNTIME
}

const handleCompletion = (shell: string) => {
  if (shell === 'bash' || shell === 'zsh') {
    console.log(`# ${shell} completion for agentctl
_agentctl_complete() {
  COMPREPLY=()
  local cur="${COMP_WORDS[COMP_CWORD]}"
  local cmds="version config completion agent impl source memory run"
  COMPREPLY=( $(compgen -W "$cmds" -- "$cur") )
}
complete -F _agentctl_complete agentctl
`)
    return 0
  }
  if (shell === 'fish') {
    console.log('complete -c agentctl -f -a "version config completion agent impl source memory run"')
    return 0
  }
  console.error(`Unsupported shell: ${shell}`)
  return EXIT_VALIDATION
}

const main = async () => {
  try {
    const { flags, rest } = parseGlobalFlags(process.argv.slice(2))
    const [command, subcommand, ...args] = rest

    if (!command || command === 'help' || command === '--help' || command === '-h') {
      console.log(usage())
      return 0
    }

    if (command === 'version') {
      console.log(`agentctl ${VERSION}`)
      return 0
    }

    if (command === 'config') {
      if (subcommand === 'view') {
        return handleKubectl(['config', 'view', '--minify'], flags)
      }
      if (subcommand === 'set') {
        const nsIndex = args.findIndex((arg) => arg === '--namespace' || arg === '-n')
        const namespace = nsIndex >= 0 ? args[nsIndex + 1] : flags.namespace
        if (!namespace) {
          throw new ValidationError('namespace is required')
        }
        return handleKubectl(['config', 'set-context', '--current', `--namespace=${namespace}`], flags)
      }
    }

    if (command === 'completion') {
      const shell = subcommand ?? ''
      return handleCompletion(shell)
    }

    const resourceMap: Record<string, string> = {
      agent: 'agents.agents.proompteng.ai',
      impl: 'implementationspecs.agents.proompteng.ai',
      source: 'implementationsources.agents.proompteng.ai',
      memory: 'memories.agents.proompteng.ai',
      run: 'agentruns.agents.proompteng.ai',
    }

    if (command === 'agent' || command === 'impl' || command === 'source' || command === 'memory') {
      const resource = resourceMap[command]
      if (subcommand === 'get') {
        return handleKubectl(['get', resource, args[0], '-o', ensureOutput(flags)], flags)
      }
      if (subcommand === 'list') {
        return handleKubectl(['get', resource, '-o', ensureOutput(flags)], flags)
      }
      if (subcommand === 'apply') {
        const fileIndex = args.indexOf('-f')
        const file = fileIndex >= 0 ? args[fileIndex + 1] : undefined
        if (!file) {
          throw new ValidationError('apply requires -f <file>')
        }
        return handleKubectl(['apply', '-f', file], flags)
      }
      if (subcommand === 'delete') {
        return handleKubectl(['delete', resource, args[0]], flags)
      }
      if (command === 'impl' && subcommand === 'create') {
        let text = ''
        let summary: string | undefined
        let source: Record<string, string> | undefined
        for (let i = 0; i < args.length; i += 1) {
          if (args[i] === '--text') text = args[++i]
          if (args[i] === '--summary') summary = args[++i]
          if (args[i] === '--source') source = parseSource(args[++i])
        }
        if (!text) {
          throw new ValidationError('--text is required')
        }
        const manifest = {
          apiVersion: 'agents.proompteng.ai/v1alpha1',
          kind: 'ImplementationSpec',
          metadata: { generateName: 'impl-' },
          spec: {
            text,
            summary,
            source,
          },
        }
        return handleKubectl(['create', '-f', '-', '-o', 'json'], flags, JSON.stringify(manifest))
      }
    }

    if (command === 'run') {
      if (subcommand === 'submit') {
        return handleRunSubmit(args, flags)
      }
      if (subcommand === 'apply') {
        const fileIndex = args.indexOf('-f')
        const file = fileIndex >= 0 ? args[fileIndex + 1] : undefined
        if (!file) {
          throw new ValidationError('apply requires -f <file>')
        }
        return handleKubectl(['apply', '-f', file], flags)
      }
      if (subcommand === 'get') {
        return handleKubectl(['get', resourceMap.run, args[0], '-o', ensureOutput(flags)], flags)
      }
      if (subcommand === 'list') {
        return handleKubectl(['get', resourceMap.run, '-o', ensureOutput(flags)], flags)
      }
      if (subcommand === 'logs') {
        const follow = args.includes('--follow')
        return handleRunLogs(args[0], flags, follow)
      }
      if (subcommand === 'cancel') {
        return handleRunCancel(args[0], flags)
      }
    }

    console.error('Unknown command')
    console.log(usage())
    return EXIT_VALIDATION
  } catch (error) {
    if (error instanceof ValidationError) {
      console.error(error.message)
      return EXIT_VALIDATION
    }
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    return EXIT_UNKNOWN
  }
}

if (import.meta.main) {
  const code = await main()
  process.exit(code)
}
