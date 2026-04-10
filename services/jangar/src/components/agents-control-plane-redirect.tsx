import { Card, CardContent, CardDescription, CardHeader, CardTitle, buttonVariants } from '@proompteng/design/ui'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import * as React from 'react'

import {
  PrimitiveDetailPage,
  PrimitiveListPage,
  type PrimitiveListField,
} from '@/components/agents-control-plane-primitives'
import { DEFAULT_NAMESPACE, parseNamespaceSearch } from '@/components/agents-control-plane-search'
import type { AgentPrimitiveKind, PrimitiveResource } from '@/data/agents-control-plane'
import { cn } from '@/lib/utils'

type AliasConfig = {
  kind: AgentPrimitiveKind
  title: string
  description: string
}

const aliasConfigs: Record<string, AliasConfig> = {
  'agent-providers': {
    kind: 'AgentProvider',
    title: 'Agent providers',
    description: 'Configured execution providers available to the agents control plane.',
  },
  'agent-runs': {
    kind: 'AgentRun',
    title: 'Agent runs',
    description: 'Individual agent execution records and their current runtime state.',
  },
  agents: {
    kind: 'Agent',
    title: 'Agents',
    description: 'Agent definitions registered in the control plane.',
  },
  approvals: {
    kind: 'ApprovalPolicy',
    title: 'Approval policies',
    description: 'Approval policies that gate execution-sensitive workflows.',
  },
  artifacts: {
    kind: 'Artifact',
    title: 'Artifacts',
    description: 'Artifacts produced by control-plane jobs and workflows.',
  },
  budgets: {
    kind: 'Budget',
    title: 'Budgets',
    description: 'Budget resources used to constrain automation and execution.',
  },
  'implementation-sources': {
    kind: 'ImplementationSource',
    title: 'Implementation sources',
    description: 'Webhook-backed or scheduled sources that generate implementation work.',
  },
  memories: {
    kind: 'Memory',
    title: 'Memories',
    description: 'Memory backends and their backing storage references.',
  },
  'orchestration-runs': {
    kind: 'OrchestrationRun',
    title: 'Orchestration runs',
    description: 'Live and historical orchestration execution records.',
  },
  orchestrations: {
    kind: 'Orchestration',
    title: 'Orchestrations',
    description: 'Orchestration templates and their workflow definitions.',
  },
  schedules: {
    kind: 'Schedule',
    title: 'Schedules',
    description: 'Scheduled triggers that drive recurring control-plane work.',
  },
  'secret-bindings': {
    kind: 'SecretBinding',
    title: 'Secret bindings',
    description: 'Bindings that authorize controlled secret usage for agents and tools.',
  },
  'signal-deliveries': {
    kind: 'SignalDelivery',
    title: 'Signal deliveries',
    description: 'Recorded signal delivery attempts and their downstream outcomes.',
  },
  signals: {
    kind: 'Signal',
    title: 'Signals',
    description: 'Signals emitted by the control plane to coordinate downstream systems.',
  },
  swarms: {
    kind: 'Swarm',
    title: 'Swarms',
    description: 'Swarm coordination resources and their current stage health.',
  },
  'tool-runs': {
    kind: 'ToolRun',
    title: 'Tool runs',
    description: 'Individual tool execution records for control-plane workflows.',
  },
  tools: {
    kind: 'Tool',
    title: 'Tools',
    description: 'Tool definitions exposed to agents and orchestration steps.',
  },
  workspaces: {
    kind: 'Workspace',
    title: 'Workspaces',
    description: 'Workspace resources used by agent execution environments.',
  },
}

const canonicalSections = [
  {
    title: 'Primary pages',
    links: [
      { to: '/control-plane/implementation-specs', label: 'Implementation specs' },
      { to: '/control-plane/runs', label: 'Runs' },
      { to: '/control-plane/agent-runs', label: 'Agent runs' },
    ],
  },
  {
    title: 'Primitive inventory',
    links: Object.entries(aliasConfigs)
      .filter(([segment]) => segment !== 'agent-runs')
      .map(([segment, config]) => ({ to: `/control-plane/${segment}`, label: config.title })),
  },
]

const primitiveListFields: PrimitiveListField[] = [
  {
    label: 'Kind',
    value: (resource: PrimitiveResource) => resource.kind ?? '—',
  },
  {
    label: 'API version',
    value: (resource: PrimitiveResource) => resource.apiVersion ?? '—',
  },
]

const readRecord = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const readString = (value: unknown) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const buildSummaryItems = (resource: Record<string, unknown>) => {
  const metadata = readRecord(resource.metadata)
  return [
    { label: 'Kind', value: readString(resource.kind) ?? '—' },
    { label: 'API version', value: readString(resource.apiVersion) ?? '—' },
    { label: 'UID', value: readString(metadata?.uid) ?? '—' },
  ]
}

const resolveSearchState = (search: string) =>
  parseNamespaceSearch(Object.fromEntries(new URLSearchParams(search).entries()))

const resolveAlias = (pathname: string) => {
  if (pathname === '/control-plane' || pathname === '/control-plane/') {
    return { type: 'landing' as const }
  }

  const relativePath = pathname.replace(/^\/control-plane\/?/, '')
  const segments = relativePath.split('/').filter(Boolean)
  const [segment, ...rest] = segments

  if (!segment) {
    return { type: 'landing' as const }
  }

  const config = aliasConfigs[segment]
  if (!config) {
    return { type: 'landing' as const }
  }

  if (rest.length === 0) {
    return { type: 'list' as const, segment, config }
  }

  return {
    type: 'detail' as const,
    segment,
    config,
    name: decodeURIComponent(rest.join('/')),
  }
}

function ControlPlaneLandingPage() {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Control Plane</p>
        <h1 className="text-lg font-semibold">Control-plane navigation</h1>
        <p className="text-xs text-muted-foreground">
          Historical control-plane aliases now render their primitive surfaces directly instead of bouncing back to
          implementation specs.
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-2">
        {canonicalSections.map((section) => (
          <Card key={section.title}>
            <CardHeader className="border-b">
              <CardTitle>{section.title}</CardTitle>
              <CardDescription>
                Namespace defaults to `{DEFAULT_NAMESPACE}` unless overridden in the URL.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 pt-4">
              {section.links.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  search={{ namespace: DEFAULT_NAMESPACE }}
                  className={cn(
                    'inline-flex items-center justify-between rounded-none border border-border px-3 py-2 text-sm',
                  )}
                >
                  <span>{link.label}</span>
                  <span className="text-xs text-muted-foreground">{link.to}</span>
                </Link>
              ))}
            </CardContent>
          </Card>
        ))}
      </section>
    </main>
  )
}

export function ControlPlaneRedirect() {
  const location = useLocation()
  const navigate = useNavigate()
  const searchState = React.useMemo(() => resolveSearchState(location.search), [location.search])
  const alias = React.useMemo(() => resolveAlias(location.pathname), [location.pathname])

  if (alias.type === 'landing') {
    return <ControlPlaneLandingPage />
  }

  if (alias.type === 'list') {
    return (
      <PrimitiveListPage
        title={alias.config.title}
        description={alias.config.description}
        kind={alias.config.kind}
        emptyLabel={`No ${alias.config.title.toLowerCase()} found.`}
        detailPath={`/control-plane/${alias.segment}/$name`}
        fields={primitiveListFields}
        searchState={searchState}
        onNavigate={(nextSearch) => void navigate({ to: location.pathname, search: nextSearch })}
        sectionLabel="Control Plane"
      />
    )
  }

  return (
    <PrimitiveDetailPage
      title={alias.config.title}
      description={alias.config.description}
      kind={alias.config.kind}
      name={alias.name}
      backPath={`/control-plane/${alias.segment}`}
      searchState={searchState}
      summaryItems={(resource) => buildSummaryItems(resource)}
      sectionLabel="Control Plane"
      errorLabel={`Failed to load ${alias.config.title.toLowerCase()}.`}
    />
  )
}

export function ControlPlaneTorghutQuantPage() {
  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <header className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Control Plane</p>
        <h1 className="text-lg font-semibold">Torghut quant</h1>
        <p className="text-xs text-muted-foreground">
          The canonical Torghut control-plane surface lives under `/torghut/control-plane`.
        </p>
      </header>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Canonical destination</CardTitle>
          <CardDescription>Use the shared Torghut operator page for live quant status and controls.</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <Link to="/torghut/control-plane" className={cn(buttonVariants({ variant: 'outline' }))}>
            Open Torghut control plane
          </Link>
        </CardContent>
      </Card>
    </main>
  )
}
