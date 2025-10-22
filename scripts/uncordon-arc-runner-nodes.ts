#!/usr/bin/env bun

import { $ } from 'bun'

$.throws(true)

type Taint = {
  key: string
  value?: string
  effect?: string
}

interface NodeResource {
  metadata?: {
    name?: string
    labels?: Record<string, string>
  }
  spec?: {
    taints?: Taint[]
  }
}

type ExecCommand = string[]

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

function parseNodeNames(): string[] {
  const override = args.find((arg) => arg.startsWith('--nodes='))
  const envOverride = process.env.ARC_RUNNER_NODE_NAMES
  const raw = override?.slice('--nodes='.length) ?? envOverride ?? ''
  if (!raw.trim()) {
    return []
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function readCount(): number | undefined {
  const override = args.find((arg) => arg.startsWith('--count='))
  const envOverride = process.env.ARC_RUNNER_NODE_COUNT
  const raw = override?.slice('--count='.length) ?? envOverride
  if (!raw || !raw.trim()) {
    return undefined
  }
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed) || parsed < 1) {
    throw new Error(`Invalid node count "${raw}"`)
  }
  return parsed
}

const explicitNodeNames = parseNodeNames()
const limit = readCount()
const labelKey = process.env.ARC_RUNNER_LABEL_KEY ?? 'github.com/arc-runner'
const labelValue = process.env.ARC_RUNNER_LABEL_VALUE ?? 'true'
const drainTaintKey = 'node.kubernetes.io/unschedulable'

const nodeList = (await $`kubectl get nodes -o json`.json()) as { items?: NodeResource[] }
const nodes = (nodeList.items ?? []).filter((node) => node.metadata?.name) as Required<NodeResource>[]

if (nodes.length === 0) {
  throw new Error('No Kubernetes nodes detected')
}

const sortedNodes = [...nodes].sort((a, b) => (a.metadata.name ?? '').localeCompare(b.metadata.name ?? ''))
const labelledNodes = sortedNodes.filter((node) => node.metadata.labels?.[labelKey] === labelValue)
const nodeMap = new Map(sortedNodes.map((node) => [node.metadata.name ?? '', node]))

const explicitTargets = explicitNodeNames.map((name) => {
  const match = nodeMap.get(name)
  if (!match) {
    throw new Error(
      `Node "${name}" not found. Available nodes: ${sortedNodes.map((node) => node.metadata.name ?? '').join(', ')}`,
    )
  }
  return match
})

let selected: Required<NodeResource>[]

if (explicitTargets.length > 0) {
  selected = explicitTargets
} else {
  if (labelledNodes.length === 0) {
    throw new Error(
      `No nodes carry label ${labelKey}=${labelValue}. Provide --nodes or ensure nodes are labeled for ARC runners.`,
    )
  }
  selected = typeof limit === 'number' ? labelledNodes.slice(-Math.min(limit, labelledNodes.length)) : labelledNodes
}

if (selected.length === 0) {
  throw new Error('No nodes selected for uncordoning. Provide --nodes or ensure labelled nodes exist.')
}

console.log(`Uncordoning nodes: ${selected.map((node) => node.metadata.name ?? '').join(', ')}`)

function hasDrainTaint(node: NodeResource): boolean {
  return (node.spec?.taints ?? []).some((taint) => taint.key === drainTaintKey)
}

async function run(command: ExecCommand, options: { allowFailure?: boolean } = {}) {
  const [binary, ...rest] = command
  const display = `$ ${command.join(' ')}`
  console.log(dryRun ? `${display} (dry-run)` : display)
  if (dryRun) {
    return
  }
  const proc = Bun.spawn([binary, ...rest], { stdout: 'inherit', stderr: 'inherit' })
  await proc.exited
  if (proc.exitCode !== 0 && !options.allowFailure) {
    throw new Error(`Command failed (${proc.exitCode}): ${command.join(' ')}`)
  }
}

for (const node of selected) {
  const name = node.metadata.name
  if (!name) {
    continue
  }
  await run(['kubectl', 'uncordon', name])

  if (hasDrainTaint(node)) {
    await run(['kubectl', 'taint', 'nodes', name, `${drainTaintKey}-`], { allowFailure: true })
  }
}

console.log(
  'Completed uncordon operations. Verify ARC runner pods tolerate the dedicated taint and reschedule as expected.',
)
