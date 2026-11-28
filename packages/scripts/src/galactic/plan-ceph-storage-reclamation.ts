#!/usr/bin/env bun

import { parseArgs } from 'node:util'

import { ensureCli, fatal } from '../shared/cli'
import { formatCephStorageReclamation, planCephStorageReclamation } from './plan-ceph-storage-reclamation-core'

const usage = `Usage:
  bun run packages/scripts/src/galactic/plan-ceph-storage-reclamation.ts --context <context> [--format markdown|json]
  bun run packages/scripts/src/galactic/plan-ceph-storage-reclamation.ts --fixture <path> [--format markdown|json]

Only reads Kubernetes inventory and Ceph statistics. No resources are deleted or changed.`

const namespaced = (resource: string) => ['get', resource, '--all-namespaces', '-o', 'json']
const clusterScoped = (resource: string) => ['get', resource, '-o', 'json']
const ceph = (...args: string[]) => [
  '-n',
  'rook-ceph',
  'exec',
  'deploy/rook-ceph-tools',
  '-c',
  'rook-ceph-tools',
  '--',
  'ceph',
  ...args,
  '--format',
  'json',
]
const reads = {
  pvcs: namespaced('persistentvolumeclaims'),
  pvs: clusterScoped('persistentvolumes'),
  pods: namespaced('pods'),
  deployments: namespaced('deployments.apps'),
  statefulSets: namespaced('statefulsets.apps'),
  snapshots: namespaced('volumesnapshots.snapshot.storage.k8s.io'),
  snapshotContents: clusterScoped('volumesnapshotcontents.snapshot.storage.k8s.io'),
  cephDf: ceph('df'),
  cephPools: ceph('osd', 'pool', 'ls', 'detail'),
  cephCrushRules: ceph('osd', 'crush', 'rule', 'dump'),
  cephOsdDf: ceph('osd', 'df', 'tree'),
}

const readLive = async (context: string) => {
  ensureCli('kubectl')
  const asOf = new Date().toISOString()
  const entries = await Promise.all(
    Object.entries(reads).map(async ([field, args]) => {
      const process = (() => {
        try {
          return Bun.spawn(['kubectl', '--context', context, '--request-timeout=30s', ...args], {
            stdout: 'pipe',
            stderr: 'ignore',
            timeout: 45_000,
          })
        } catch {
          throw new Error(`Could not launch kubectl for ${field}`)
        }
      })()
      const [exit, stdout] = await Promise.all([process.exited, new Response(process.stdout).text()])
      if (exit !== 0)
        throw new Error(`Unable to read ${field} (kubectl exit ${exit}); check context and read permissions`)
      try {
        const data: unknown = JSON.parse(stdout)
        return [field, data] as const
      } catch {
        throw new Error(`Invalid JSON from ${field}`)
      }
    }),
  )
  return { ...Object.fromEntries(entries), asOf }
}

const readFixture = async (path: string): Promise<unknown> => {
  try {
    return await Bun.file(path).json()
  } catch {
    throw new Error('Unable to read fixture as JSON')
  }
}

const main = async () => {
  const { values } = (() => {
    try {
      return parseArgs({
        args: Bun.argv.slice(2),
        options: {
          context: { type: 'string' },
          fixture: { type: 'string' },
          format: { type: 'string', default: 'markdown' },
          help: { type: 'boolean', short: 'h' },
        },
      })
    } catch {
      return fatal(usage)
    }
  })()
  if (values.help) {
    console.log(usage)
    return
  }
  if (
    (values.context === undefined) === (values.fixture === undefined) ||
    values.context?.trim() === '' ||
    values.fixture?.trim() === '' ||
    (values.format !== 'markdown' && values.format !== 'json')
  ) {
    return fatal(usage)
  }
  const raw = values.fixture !== undefined ? await readFixture(values.fixture) : await readLive(values.context ?? '')
  process.stdout.write(formatCephStorageReclamation(planCephStorageReclamation(raw), values.format))
}

if (import.meta.main) {
  await main().catch((error: unknown) => fatal('Could not produce a reclamation plan.', error))
}
