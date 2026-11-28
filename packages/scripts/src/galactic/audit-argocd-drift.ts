#!/usr/bin/env bun

import { parseArgs } from 'node:util'

import { ensureCli } from '../shared/cli'
import {
  argocdNamespace,
  audit,
  liveResourceSchema,
  localPruneCandidates,
  renderMarkdown,
  snapshotSchema,
} from './audit-argocd-drift-core'

const usage =
  'Usage: bun run packages/scripts/src/galactic/audit-argocd-drift.ts [--fixture <path>] [--format json|markdown]'

class AuditError extends Error {}

const options = () => {
  try {
    const { values } = parseArgs({
      options: {
        fixture: { type: 'string' },
        format: { type: 'string', default: 'markdown' },
        help: { type: 'boolean', short: 'h' },
      },
    })
    const { fixture, format, help } = values
    if (fixture === '' || (format !== 'json' && format !== 'markdown')) throw new AuditError()
    return { fixture, format, help }
  } catch {
    // Parser errors can include raw arguments.
    throw new AuditError(usage)
  }
}

const get = (namespace: string, ...resources: string[]) => {
  try {
    const result = Bun.spawnSync(
      ['kubectl', '-n', namespace, 'get', ...resources, '-o', 'json', '--request-timeout=15s'],
      {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: 20_000,
      },
    )
    return result.success ? result.stdout.toString() : undefined
  } catch {
    return undefined
  }
}

const decode = (input: string): unknown => {
  try {
    return JSON.parse(input)
  } catch {
    return undefined
  }
}

const readFixture = async (path: string) => {
  try {
    return await Bun.file(path).text()
  } catch {
    throw new AuditError('Unable to read the fixture file.')
  }
}

const readApplications = () => {
  ensureCli('kubectl')
  const json = get(argocdNamespace, 'applications')
  if (json === undefined)
    throw new AuditError('Unable to list Argo CD Applications. Check the kubectl context and list access in argocd.')
  return json
}

const main = async () => {
  const { fixture, format, help } = options()
  if (help) {
    console.log(usage)
    return
  }
  const snapshot = snapshotSchema.safeParse(
    decode(fixture !== undefined ? await readFixture(fixture) : readApplications()),
  )
  if (!snapshot.success) {
    const path = snapshot.error.issues[0]?.path.join('.') || 'document'
    throw new AuditError(
      `Invalid audit input at ${path}. Expected an Application list with optional live resource evidence.`,
    )
  }

  const liveResources = fixture === undefined ? [] : snapshot.data.liveResources
  if (fixture === undefined) {
    for (const { group, kind, namespace, name } of localPruneCandidates(snapshot.data)) {
      const live = get(namespace || argocdNamespace, group ? `${kind}.${group}` : kind, name)
      if (live === undefined) continue
      const resource = liveResourceSchema.safeParse(decode(live))
      if (
        resource.success &&
        resource.data.group === group &&
        resource.data.kind === kind &&
        resource.data.namespace === namespace &&
        resource.data.name === name
      ) {
        liveResources.push(resource.data)
      }
    }
  }

  const applications = audit({ ...snapshot.data, liveResources })
  process.stdout.write(
    format === 'json' ? `${JSON.stringify({ applications }, null, 2)}\n` : renderMarkdown(applications),
  )
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof AuditError ? error.message : 'Argo CD drift audit failed.')
    process.exitCode = 1
  })
}
