import type { GlobalFlags } from '../config'

type ParsedGlobalFlags = {
  argv: string[]
  flags: GlobalFlags
}

const takeValue = (argv: string[], index: number): string | undefined => {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) return undefined
  return value
}

export const parseGlobalFlags = (argv: string[]): ParsedGlobalFlags => {
  const flags: GlobalFlags = {}
  const rest: string[] = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue

    if (arg === '--kube') {
      flags.kube = true
      continue
    }
    if (arg === '--grpc') {
      flags.grpc = true
      continue
    }

    if (arg === '--namespace' || arg === '-n') {
      const value = takeValue(argv, i)
      if (!value) {
        rest.push(arg)
        continue
      }
      flags.namespace = value
      i += 1
      continue
    }
    if (arg.startsWith('--namespace=')) {
      flags.namespace = arg.slice('--namespace='.length)
      continue
    }

    if (arg === '--server' || arg === '--address') {
      const value = takeValue(argv, i)
      if (!value) {
        rest.push(arg)
        continue
      }
      flags.address = value
      i += 1
      continue
    }
    if (arg.startsWith('--server=')) {
      flags.address = arg.slice('--server='.length)
      continue
    }
    if (arg.startsWith('--address=')) {
      flags.address = arg.slice('--address='.length)
      continue
    }

    if (arg === '--token') {
      const value = takeValue(argv, i)
      if (!value) {
        rest.push(arg)
        continue
      }
      flags.token = value
      i += 1
      continue
    }
    if (arg.startsWith('--token=')) {
      flags.token = arg.slice('--token='.length)
      continue
    }

    if (arg === '--output' || arg === '-o') {
      const value = takeValue(argv, i)
      if (!value) {
        rest.push(arg)
        continue
      }
      flags.output = value as GlobalFlags['output']
      i += 1
      continue
    }
    if (arg.startsWith('--output=')) {
      flags.output = arg.slice('--output='.length) as GlobalFlags['output']
      continue
    }

    if (arg === '--kubeconfig') {
      const value = takeValue(argv, i)
      if (!value) {
        rest.push(arg)
        continue
      }
      flags.kubeconfig = value
      i += 1
      continue
    }
    if (arg.startsWith('--kubeconfig=')) {
      flags.kubeconfig = arg.slice('--kubeconfig='.length)
      continue
    }

    if (arg === '--context') {
      const value = takeValue(argv, i)
      if (!value) {
        rest.push(arg)
        continue
      }
      flags.context = value
      i += 1
      continue
    }
    if (arg.startsWith('--context=')) {
      flags.context = arg.slice('--context='.length)
      continue
    }

    if (arg === '--tls') {
      flags.tls = true
      continue
    }
    if (arg === '--no-tls') {
      flags.tls = false
      continue
    }

    if (arg === '--yes' || arg === '-y') {
      flags.yes = true
      continue
    }
    if (arg === '--no-input') {
      flags.noInput = true
      continue
    }
    if (arg === '--color') {
      flags.color = true
      continue
    }
    if (arg === '--no-color') {
      flags.color = false
      continue
    }
    if (arg === '--pager') {
      flags.pager = true
      continue
    }
    if (arg === '--no-pager') {
      flags.pager = false
      continue
    }

    rest.push(arg)
  }

  return { argv: rest, flags }
}
