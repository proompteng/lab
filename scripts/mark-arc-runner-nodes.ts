#!/usr/bin/env bun

import { $ } from 'bun'

$.throws(true)

interface NodeResource {
  metadata?: {
    name?: string
    labels?: Record<string, string>
  }
  spec?: {
    taints?: Array<{
      key: string
      value?: string
      effect?: string
    }>
  }
}

type ExecParts = string[]

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

function parseNodeNames(): string[] {
  const override = args.find((part) => part.startsWith('--nodes='))
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

function readCount(): number {
  const override = args.find((part) => part.startsWith('--count='))
  const envOverride = process.env.ARC_RUNNER_NODE_COUNT
  const raw = override?.slice('--count='.length) ?? envOverride ?? '3'
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed) || parsed < 1) {
    throw new Error(`Invalid node count "${raw}"`)
  }
  return parsed
}

const explicitNodeNames = parseNodeNames()
const nodeCount = readCount()
const labelKey = process.env.ARC_RUNNER_LABEL_KEY ?? 'github.com/arc-runner'
const labelValue = process.env.ARC_RUNNER_LABEL_VALUE ?? 'true'
const taintKey = process.env.ARC_RUNNER_TAINT_KEY ?? 'dedicated'
const taintValue = process.env.ARC_RUNNER_TAINT_VALUE ?? 'arc-runner'
const taintEffect = process.env.ARC_RUNNER_TAINT_EFFECT ?? 'NoSchedule'

function shellEscape(part: string) {
  return /[^A-Za-z0-9_@%+=:,./-]/.test(part) ? `'${part.replace(/'/g, `'\\''`)}'` : part
}

async function exec(parts: ExecParts) {
  const command = parts.join(' ')
  console.log(dryRun ? `$ (dry-run) ${command}` : `$ ${command}`)
  if (dryRun) {
    return
  }
  await $`${{ raw: parts.map(shellEscape).join(' ') }}`
}

function hasDesiredLabel(node: NodeResource) {
  return node.metadata?.labels?.[labelKey] === labelValue
}

function hasTaint(node: NodeResource) {
  return (node.spec?.taints ?? []).some(
    (taint) => taint.key === taintKey && taint.value === taintValue && taint.effect === taintEffect,
  )
}

function hasAnyMatchingTaint(node: NodeResource) {
  return (node.spec?.taints ?? []).some((taint) => taint.key === taintKey)
}

const nodeList = (await $`kubectl get nodes -o json`.json()) as { items?: NodeResource[] }
const nodes = (nodeList.items ?? []).filter((node) => node.metadata?.name) as Required<NodeResource>[]

if (nodes.length === 0) {
  throw new Error('No Kubernetes nodes detected')
}

const sortedNodes = [...nodes].sort((a, b) => (a.metadata.name ?? '').localeCompare(b.metadata.name ?? ''))

function resolveExplicitNodes(): Required<NodeResource>[] {
  if (explicitNodeNames.length === 0) {
    return []
  }

  const map = new Map(sortedNodes.map((node) => [node.metadata.name ?? '', node]))
  const missing: string[] = []
  const resolved: Required<NodeResource>[] = []

  for (const name of explicitNodeNames) {
    const match = map.get(name)
    if (match) {
      resolved.push(match)
    } else {
      missing.push(name)
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Node(s) not found: ${missing.join(', ')}. Available nodes: ${sortedNodes
        .map((node) => node.metadata.name)
        .join(', ')}`,
    )
  }

  return resolved
}

const explicitTargets = resolveExplicitNodes()
const selected = explicitTargets.length > 0 ? explicitTargets : sortedNodes.slice(-nodeCount)
const selectedNames = new Set(selected.map((node) => node.metadata.name ?? ''))

if (explicitTargets.length === 0 && selected.length < nodeCount) {
  console.warn(`Requested ${nodeCount} nodes but only found ${selected.length}. Proceeding with available nodes.`)
}

if (selected.length === 0) {
  throw new Error('No target nodes selected. Provide --nodes or ensure node count > 0.')
}

const targetDescriptor =
  explicitTargets.length > 0
    ? selected.map((node) => node.metadata.name ?? '').join(', ')
    : `${selected.map((node) => node.metadata.name ?? '').join(', ')} (selected by highest lex order)`

console.log(`Targeting nodes: ${targetDescriptor}`)

for (const node of selected) {
  const name = node.metadata.name
  if (!name) {
    continue
  }

  if (!hasDesiredLabel(node)) {
    await exec(['kubectl', 'label', 'node', name, `${labelKey}=${labelValue}`, '--overwrite'])
  }

  if (!hasTaint(node)) {
    await exec(['kubectl', 'taint', 'nodes', name, `${taintKey}=${taintValue}:${taintEffect}`, '--overwrite'])
  }
}

for (const node of sortedNodes) {
  const name = node.metadata.name
  if (!name) {
    continue
  }
  if (selectedNames.has(name)) {
    continue
  }

  if (node.metadata.labels?.[labelKey]) {
    await exec(['kubectl', 'label', 'node', name, `${labelKey}-`])
  }

  if (hasAnyMatchingTaint(node)) {
    await exec(['kubectl', 'taint', 'nodes', name, `${taintKey}-`])
  }
}

console.log(
  'Completed node updates. Ensure GitHub runner scale set pods tolerate the applied taint and target the label.',
)
