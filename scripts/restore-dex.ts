#!/usr/bin/env bun

/**
 * Restore the Argo CD Dex deployment after Sealed Secrets and Argo Workflows are online.
 *
 * This reverses the bootstrap "disable Dex" flow by scaling the deployment back up
 * and optionally syncing the Argo CD application so the network policy returns.
 */

interface Options {
  namespace: string
  dryRun: boolean
  sync: boolean
  appName: string
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    namespace: 'argocd',
    dryRun: false,
    sync: false,
    appName: 'argocd',
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
      case '--app': {
        const value = argv[++i]
        if (!value) throw new Error(`${arg} requires a value`)
        options.appName = value
        break
      }
      case '--sync':
        options.sync = true
        break
      case '--no-sync':
        options.sync = false
        break
      case '--dry-run':
        options.dryRun = true
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
  console.log(`Usage: bun scripts/restore-dex.ts [options]

Options:
  --namespace, -n  Namespace that hosts Argo CD (default: argocd)
  --app            Argo CD application name to sync (default: argocd)
  --sync           Run 'argocd app sync' after scaling the deployment
  --no-sync        Skip syncing even if --sync is set elsewhere
  --dry-run        Print the commands instead of executing them
  --help, -h       Show this help message

Examples:
  bun scripts/restore-dex.ts
  bun scripts/restore-dex.ts --namespace staging-argocd
  bun scripts/restore-dex.ts --sync --app argocd-control-plane
`)
}

async function run(command: string[], dryRun: boolean, description: string) {
  if (dryRun) {
    console.log(`[dry-run] ${description}`)
    return
  }

  console.log(`> ${description}`)
  const process = Bun.spawn(command, {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await process.exited
  if (exitCode !== 0) {
    throw new Error(`Command failed with exit code ${exitCode}: ${description}`)
  }
}

async function main() {
  const { namespace, dryRun, sync, appName } = parseArgs(process.argv.slice(2))
  const deployment = 'argocd-dex-server'
  const scaleDescription = `kubectl -n ${namespace} scale deployment ${deployment} --replicas=1`

  await run(['kubectl', '-n', namespace, 'scale', 'deployment', deployment, '--replicas=1'], dryRun, scaleDescription)

  if (sync) {
    const argocdPath = await Bun.which('argocd')
    if (!argocdPath) {
      throw new Error("argocd CLI not found in PATH. Install argocd or rerun without '--sync'.")
    }
    const syncDescription = `argocd app sync ${appName}`
    await run([argocdPath, 'app', 'sync', appName], dryRun, syncDescription)
  } else {
    console.log(
      '\nDex scaled back to one replica. Sync the Argo CD application to restore the network policy and overlays.',
    )
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
