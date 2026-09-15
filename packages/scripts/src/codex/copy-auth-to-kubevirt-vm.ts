#!/usr/bin/env bun

import { stat, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import os from 'node:os'
import process from 'node:process'

import { ensureCli, fatal } from '../shared/cli'

type Options = {
  namespace: string
  vmi: string
  user: string
  sshKey: string
  authPath: string
  destPath: string
  kubeconfig?: string
}

const parseArgs = (): Options => {
  const args = process.argv.slice(2)
  const options: Partial<Options> = {
    namespace: 'workers',
    vmi: 'workers',
    user: 'ubuntu',
    sshKey: `${os.homedir()}/.ssh/id_ed25519`,
    authPath: process.env.CODEX_AUTH ?? `${os.homedir()}/.codex/auth.json`,
    destPath: '/home/ubuntu/.codex/auth.json',
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
      case '--auth': {
        index += 1
        const value = args[index]
        if (!value) fatal('--auth requires a value')
        options.authPath = value
        break
      }
      case '--dest': {
        index += 1
        const value = args[index]
        if (!value) fatal('--dest requires a value')
        options.destPath = value
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
    authPath: options.authPath ?? `${os.homedir()}/.codex/auth.json`,
    destPath: options.destPath ?? '/home/ubuntu/.codex/auth.json',
    kubeconfig: options.kubeconfig,
  }
}

const printHelp = () => {
  console.log(`Usage: bun run packages/scripts/src/codex/copy-auth-to-kubevirt-vm.ts [options]

Options:
  -n, --namespace   KubeVirt namespace (default: workers)
  --vmi             VMI name (default: workers)
  --user            SSH user (default: ubuntu)
  --ssh-key         SSH private key path (default: ~/.ssh/id_ed25519)
  --auth            Local Codex auth.json path (default: ~/.codex/auth.json or CODEX_AUTH)
  --dest            Remote auth.json path (default: /home/ubuntu/.codex/auth.json)
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

const main = async () => {
  ensureCli('ssh')
  ensureCli('virtctl')

  const options = parseArgs()
  await ensureFile(options.authPath, 'Codex auth.json')
  await ensureFile(options.sshKey, 'SSH key')

  const authBytes = await readFile(options.authPath)
  const remoteDir = dirname(options.destPath)

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
    `umask 077; mkdir -p ${remoteDir}; cat > ${options.destPath}`,
  ]

  console.log(`Copying ${options.authPath} -> ${options.user}@${options.vmi}:${options.destPath}`)
  const subprocess = Bun.spawn(['ssh', ...sshArgs], {
    stdin: 'pipe',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  void subprocess.stdin?.write(authBytes)
  void subprocess.stdin?.end()

  const exitCode = await subprocess.exited
  if (exitCode !== 0) {
    fatal(`SSH copy failed (${exitCode})`)
  }
}

if (import.meta.main) {
  await main()
}
