import { Flag, GlobalFlag } from 'effect/cli'
import type { GlobalFlags } from '../config'

type KeysOf<T> = { [K in keyof GlobalFlags]-?: NonNullable<GlobalFlags[K]> extends T ? K : never }[keyof GlobalFlags]
type GlobalOption = {
  name: string
  alias?: string
  description: string
} & ({ key: KeysOf<string> } | { key: KeysOf<boolean>; value: boolean })

// The same option definitions drive bootstrap (before the transport and pager are
// initialized), Effect's inherited help, and shell completions.
const options: readonly GlobalOption[] = [
  { name: 'kube', key: 'kube', value: true, description: 'Force Kubernetes API mode (default).' },
  { name: 'grpc', key: 'grpc', value: true, description: 'Force gRPC mode.' },
  { name: 'namespace', alias: 'n', key: 'namespace', description: 'Select the namespace (default: agents).' },
  { name: 'server', alias: 'address', key: 'address', description: 'Set the gRPC endpoint (use with --grpc).' },
  { name: 'token', key: 'token', description: 'Set the gRPC bearer token.' },
  { name: 'tls', key: 'tls', value: true, description: 'Enable gRPC TLS.' },
  { name: 'no-tls', key: 'tls', value: false, description: 'Disable gRPC TLS.' },
  { name: 'kubeconfig', key: 'kubeconfig', description: 'Use this kubeconfig file.' },
  { name: 'context', key: 'context', description: 'Use this kubeconfig context.' },
  {
    name: 'output',
    alias: 'o',
    key: 'output',
    description: 'Use table, wide, json, yaml, yaml-stream, or text output.',
  },
  { name: 'yes', alias: 'y', key: 'yes', value: true, description: 'Skip confirmation prompts.' },
  { name: 'no-input', key: 'noInput', value: true, description: 'Disable interactive prompting.' },
  { name: 'color', key: 'color', value: true, description: 'Use the default color behavior.' },
  { name: 'no-color', key: 'color', value: false, description: 'Disable color output.' },
  { name: 'pager', key: 'pager', value: true, description: 'Page output when stdout is a terminal.' },
  { name: 'no-pager', key: 'pager', value: false, description: 'Disable the pager.' },
]

const byFlag = new Map<string, GlobalOption>()
for (const option of options) {
  byFlag.set(`--${option.name}`, option)
  if (option.alias) byFlag.set(`${option.alias.length === 1 ? '-' : '--'}${option.alias}`, option)
}

export const parseGlobalFlags = (argv: string[]) => {
  const flags: GlobalFlags = {}
  const rest: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--') {
      rest.push(...argv.slice(i))
      break
    }
    const equals = arg.indexOf('=')
    const option = byFlag.get(equals < 0 ? arg : arg.slice(0, equals))
    if (!option) {
      rest.push(arg)
    } else if ('value' in option) {
      if (equals < 0) flags[option.key] = option.value
      else rest.push(arg)
    } else {
      const value = equals < 0 ? argv[i + 1] : arg.slice(equals + 1)
      if (value === undefined || (equals < 0 && (!value || value.startsWith('-')))) {
        rest.push(arg)
        continue
      }
      if (option.key === 'output') flags.output = value as GlobalFlags['output']
      else flags[option.key] = value
      if (equals < 0) i += 1
    }
  }
  return { argv: rest, flags }
}

export const globalOptions = options.map((option) => {
  const describe = <A>(flag: Flag.Flag<A>) => {
    const described = flag.pipe(Flag.withDescription(option.description))
    return option.alias ? described.pipe(Flag.withAlias(option.alias)) : described
  }
  const setting = GlobalFlag.Setting(option.name)
  return 'value' in option
    ? setting({ flag: describe(Flag.Boolean(option.name).pipe(Flag.withDefault(false))) })
    : setting({ flag: Flag.optional(describe(Flag.String(option.name))) })
})
