#!/usr/bin/env bun

/**
 * Temporarily disable the Argo CD Dex deployment while bootstrapping a fresh cluster.
 *
 * Option 1 from the runbook:
 *   - scale the Dex deployment to zero replicas
 *   - remove the permissive network policy that would otherwise expose the unused service
 *
 * Dex can be re-enabled later by scaling the deployment back up (and allowing Argo CD to recreate
 * the network policy during an application sync).
 */

type Mode = 'disable' | 'enable'

interface Options {
  namespace: string
  dryRun: boolean
  mode: Mode
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    namespace: 'argocd',
    dryRun: false,
    mode: 'disable',
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--namespace':
      case '-n': {
        const value = argv[++i]
        if (!value) throw new Error(`${arg} requires a value`)
        options.namespace = value
        break
      }
      case '--dry-run':
        options.dryRun = true
        break
      case '--enable':
      case '--undo':
        options.mode = 'enable'
        break
      case '--disable':
        options.mode = 'disable'
        break
      case '--help':
      case '-h':
        printUsage()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function printUsage(): void {
  console.log(`Usage: bun scripts/disable-dex.ts [options]

Options:
  --namespace, -n  Namespace that hosts Argo CD (default: argocd)
  --disable        Disable Dex by scaling to 0 and deleting the network policy (default)
  --enable, --undo Re-enable Dex by scaling to 1
  --dry-run        Print the commands instead of executing them
  --help, -h       Show this help message

Examples:
  bun scripts/disable-dex.ts
  bun scripts/disable-dex.ts --namespace staging-argocd
  bun scripts/disable-dex.ts --enable
`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const { namespace, dryRun, mode } = options
  const deployment = 'argocd-dex-server'
  const networkPolicy = 'argocd-dex-server-network-policy'

  const commands: Array<{ preview: string; command: string[] }> = []

  if (mode === 'disable') {
    commands.push({
      preview: `kubectl -n ${namespace} scale deployment ${deployment} --replicas=0`,
      command: ['kubectl', '-n', namespace, 'scale', 'deployment', deployment, '--replicas=0'],
    })
    commands.push({
      preview: `kubectl -n ${namespace} delete networkpolicy ${networkPolicy} --ignore-not-found`,
      command: ['kubectl', '-n', namespace, 'delete', 'networkpolicy', networkPolicy, '--ignore-not-found'],
    })
  } else {
    commands.push({
      preview: `kubectl -n ${namespace} scale deployment ${deployment} --replicas=1`,
      command: ['kubectl', '-n', namespace, 'scale', 'deployment', deployment, '--replicas=1'],
    })
  }

  for (const { preview, command } of commands) {
    if (dryRun) {
      console.log(`[dry-run] ${preview}`)
      // eslint-disable-next-line no-continue
      continue
    }
    console.log(`> ${preview}`)
    const process = Bun.spawn(command, {
      stdout: 'inherit',
      stderr: 'inherit',
    })
    const exitCode = await process.exited
    if (exitCode !== 0) {
      throw new Error(`Command failed with exit code ${exitCode}: ${preview}`)
    }
  }

  if (mode === 'disable') {
    console.log(
      '\nDex has been scaled to zero. The network policy was removed so the unused service is no longer exposed.',
    )
    console.log('When Sealed Secrets and Argo Workflows are ready, re-enable Dex with either:')
    console.log(`  bun scripts/restore-dex.ts${namespace !== 'argocd' ? ` --namespace ${namespace}` : ''}`)
    console.log('or:')
    console.log(`  bun scripts/disable-dex.ts --enable${namespace !== 'argocd' ? ` --namespace ${namespace}` : ''}`)
    console.log('or (direct kubectl):')
    console.log(`  kubectl -n ${namespace} scale deployment ${deployment} --replicas=1`)
    console.log('\nAfter re-enabling, sync the Argo CD app so the network policy and other overlays are restored.')
  } else {
    console.log(
      '\nDex scaled back to one replica. Sync the Argo CD application to recreate the network policy if needed.',
    )
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
