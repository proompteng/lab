#!/usr/bin/env bun

import { stat } from 'node:fs/promises'
import os from 'node:os'
import process from 'node:process'

import { ensureCli, fatal } from '../shared/cli'

type Options = {
  namespace: string
  vmi: string
  user: string
  sshKey: string
  opPath?: string
  authKey?: string
  extraArgs?: string
  kubeconfig?: string
}

const DEFAULT_OP_TAILSCALE_AUTH_PATH = 'op://infra/tailscale auth key/authkey'

const parseArgs = (): Options => {
  const args = process.argv.slice(2)
  const options: Partial<Options> = {
    namespace: 'workers',
    vmi: 'workers',
    user: 'ubuntu',
    sshKey: `${os.homedir()}/.ssh/id_ed25519`,
    opPath: process.env.TAILSCALE_AUTHKEY_OP_PATH ?? DEFAULT_OP_TAILSCALE_AUTH_PATH,
    extraArgs: process.env.TAILSCALE_EXTRA_ARGS,
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    switch (arg) {
      case '--namespace':
      case '-n': {
        index += 1
        const value = args[index]
        if (!value) fatal(`${arg} requires a value`)
        options.namespace = value
        break
      }
      case '--vmi': {
        index += 1
        const value = args[index]
        if (!value) fatal('--vmi requires a value')
        options.vmi = value
        break
      }
      case '--user': {
        index += 1
        const value = args[index]
        if (!value) fatal('--user requires a value')
        options.user = value
        break
      }
      case '--ssh-key': {
        index += 1
        const value = args[index]
        if (!value) fatal('--ssh-key requires a value')
        options.sshKey = value
        break
      }
      case '--op-path': {
        index += 1
        const value = args[index]
        if (!value) fatal('--op-path requires a value')
        options.opPath = value
        break
      }
      case '--authkey': {
        index += 1
        const value = args[index]
        if (!value) fatal('--authkey requires a value')
        options.authKey = value
        break
      }
      case '--extra-args': {
        index += 1
        const value = args[index]
        if (!value) fatal('--extra-args requires a value')
        options.extraArgs = value
        break
      }
      case '--kubeconfig': {
        index += 1
        const value = args[index]
        if (!value) fatal('--kubeconfig requires a value')
        options.kubeconfig = value
        break
      }
      case '--help':
      case '-h': {
        printHelp()
        process.exit(0)
        break
      }
      default:
        fatal(`Unknown option: ${arg}`)
    }
  }

  return {
    namespace: options.namespace ?? 'workers',
    vmi: options.vmi ?? 'workers',
    user: options.user ?? 'ubuntu',
    sshKey: options.sshKey ?? `${os.homedir()}/.ssh/id_ed25519`,
    opPath: options.opPath ?? DEFAULT_OP_TAILSCALE_AUTH_PATH,
    authKey: options.authKey,
    extraArgs: options.extraArgs,
    kubeconfig: options.kubeconfig,
  }
}

const printHelp = () => {
  console.log(`Usage: bun run packages/scripts/src/workers/seed-tailscale-auth.ts [options]

Options:
  -n, --namespace   KubeVirt namespace (default: workers)
  --vmi             VMI name (default: workers)
  --user            SSH user (default: ubuntu)
  --ssh-key         SSH private key path (default: ~/.ssh/id_ed25519)
  --op-path         1Password path for auth key (default: op://infra/tailscale auth key/authkey)
  --authkey         Use this auth key instead of 1Password
  --extra-args      Extra args for tailscale up (or set TAILSCALE_EXTRA_ARGS env)
  --kubeconfig      Path to kubeconfig for virtctl (optional)
  -h, --help        Show this help message
`)
}

const ensureFile = async (path: string, description: string) => {
  try {
    const info = await stat(path)
    if (!info.isFile()) {
      fatal(`${description} is not a file: ${path}`)
    }
  } catch (error) {
    fatal(`${description} not found: ${path}`, error)
  }
}

const readAuthKey = async (options: Options) => {
  if (options.authKey) {
    return options.authKey.trim()
  }

  ensureCli('op')
  const path = options.opPath ?? DEFAULT_OP_TAILSCALE_AUTH_PATH
  const subprocess = Bun.spawn(['op', 'read', path], {
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const output = await new Response(subprocess.stdout).text()
  const exitCode = await subprocess.exited
  if (exitCode !== 0) {
    fatal(`Failed to read Tailscale auth key from 1Password: ${path}`)
  }
  return output.trim()
}

const escapeSingleQuotes = (value: string) => value.replaceAll("'", "'\"'\"'")

const main = async () => {
  ensureCli('ssh')
  ensureCli('virtctl')

  const options = parseArgs()
  await ensureFile(options.sshKey, 'SSH key')

  const authKey = await readAuthKey(options)
  if (!authKey) {
    fatal('Tailscale auth key is empty')
  }

  const extraArgs = options.extraArgs?.trim() ?? ''
  const content = [
    `TAILSCALE_AUTHKEY='${escapeSingleQuotes(authKey)}'`,
    `TAILSCALE_EXTRA_ARGS='${escapeSingleQuotes(extraArgs)}'`,
    '',
  ].join('\n')

  const kubeconfigArgs = options.kubeconfig ? ['--kubeconfig', options.kubeconfig] : []
  const proxyCommand = [
    'virtctl',
    ...kubeconfigArgs,
    '-n',
    options.namespace,
    'port-forward',
    '--stdio=true',
    `vmi/${options.vmi}`,
    '22',
  ].join(' ')

  const sshArgs = [
    '-o',
    `ProxyCommand=${proxyCommand}`,
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-i',
    options.sshKey,
    `${options.user}@vmi/${options.vmi}`,
    "sudo bash -lc 'umask 077; cat > /etc/default/tailscale-auth; systemctl restart tailscale-up.service'",
  ]

  console.log(`Seeding Tailscale auth key on ${options.user}@${options.vmi} (namespace ${options.namespace})`)
  const subprocess = Bun.spawn(['ssh', ...sshArgs], {
    stdin: 'pipe',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  void subprocess.stdin?.write(content)
  void subprocess.stdin?.end()

  const exitCode = await subprocess.exited
  if (exitCode !== 0) {
    fatal(`SSH copy failed (${exitCode})`)
  }
}

if (import.meta.main) {
  await main()
}
