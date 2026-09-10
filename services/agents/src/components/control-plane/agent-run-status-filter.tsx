import { CheckIcon, ChevronsUpDownIcon, FilterIcon, SearchIcon, XIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

import { cn } from '@/lib/utils'
import type { PrimitiveResourceSummary } from '../../control-plane/api-client'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

export const agentRunStatusOptions = [
  { value: 'Pending', label: 'Pending', description: 'Accepted and waiting for runtime work.' },
  { value: 'Running', label: 'Running', description: 'Runtime work is active.' },
  { value: 'Succeeded', label: 'Succeeded', description: 'Completed successfully.' },
  { value: 'Failed', label: 'Failed', description: 'Finished with an error.' },
  { value: 'Cancelled', label: 'Cancelled', description: 'Stopped before completion.' },
] as const

export type AgentRunStatus = (typeof agentRunStatusOptions)[number]['value']

const agentRunStatusSet = new Set<string>(agentRunStatusOptions.map((option) => option.value))
const agentRunStatusRank = new Map(agentRunStatusOptions.map((option, index) => [option.value, index]))

export const parseAgentRunStatusSearch = (value: unknown): AgentRunStatus[] => {
  const rawValues = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const selected = new Set<AgentRunStatus>()
  for (const rawValue of rawValues) {
    if (typeof rawValue !== 'string') continue
    for (const entry of rawValue.split(',')) {
      const status = entry.trim()
      if (agentRunStatusSet.has(status)) selected.add(status as AgentRunStatus)
    }
  }

  return [...selected].sort((left, right) => (agentRunStatusRank.get(left) ?? 0) - (agentRunStatusRank.get(right) ?? 0))
}

export const serializeAgentRunStatusSearch = (statuses: readonly AgentRunStatus[]) => {
  const selected = parseAgentRunStatusSearch(statuses)
  return selected.length > 0 ? selected.join(',') : undefined
}

export const agentRunPhase = (resource: PrimitiveResourceSummary) =>
  typeof resource.status.phase === 'string' && resource.status.phase.trim().length > 0 ? resource.status.phase : null

export const filterAgentRunsByStatuses = (
  resources: readonly PrimitiveResourceSummary[],
  statuses: readonly AgentRunStatus[],
) => {
  if (statuses.length === 0) return [...resources]
  const selected = new Set(statuses)
  return resources.filter((resource) => {
    const phase = agentRunPhase(resource)
    return phase ? selected.has(phase as AgentRunStatus) : false
  })
}

type AgentRunStatusFilterProps = {
  selectedStatuses: AgentRunStatus[]
  onSelectedStatusesChange: (statuses: AgentRunStatus[]) => void
}

export function AgentRunStatusFilter({ selectedStatuses, onSelectedStatusesChange }: AgentRunStatusFilterProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const selectedSet = useMemo(() => new Set(selectedStatuses), [selectedStatuses])
  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return agentRunStatusOptions
    return agentRunStatusOptions.filter(
      (option) =>
        option.label.toLowerCase().includes(normalizedQuery) ||
        option.description.toLowerCase().includes(normalizedQuery),
    )
  }, [query])

  const toggleStatus = (status: AgentRunStatus) => {
    const next = selectedSet.has(status)
      ? selectedStatuses.filter((selected) => selected !== status)
      : [...selectedStatuses, status]
    onSelectedStatusesChange(parseAgentRunStatusSearch(next))
  }

  const selectedLabel = selectedStatuses.length === 0 ? 'Status' : `${selectedStatuses.length} selected`

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={open}
            aria-label="Filter AgentRuns by status"
            className="max-w-[calc(100vw-8rem)] justify-between gap-2 sm:w-[18rem]"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <FilterIcon data-icon="inline-start" className="text-muted-foreground" />
              <span className="shrink-0 text-muted-foreground sm:hidden">{selectedLabel}</span>
              <span className="hidden min-w-0 items-center gap-1 sm:flex">
                {selectedStatuses.length === 0 ? (
                  <span className="text-muted-foreground">Filter status</span>
                ) : (
                  <SelectedStatusBadges statuses={selectedStatuses} />
                )}
              </span>
            </span>
            <ChevronsUpDownIcon data-icon="inline-end" className="text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[min(20rem,calc(100vw-2rem))] p-0">
          <div className="border-b p-2">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search statuses..."
                className="h-8 pl-8"
                aria-label="Search AgentRun statuses"
              />
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto p-1" role="listbox" aria-multiselectable="true">
            {filteredOptions.map((option) => {
              const selected = selectedSet.has(option.value)
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                  onClick={() => toggleStatus(option.value)}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border border-border',
                      selected ? 'bg-primary text-primary-foreground' : 'text-transparent',
                    )}
                    aria-hidden="true"
                  >
                    <CheckIcon className="size-3" />
                  </span>
                  <span className="grid min-w-0 gap-0.5">
                    <span className="font-medium">{option.label}</span>
                    <span className="text-xs text-muted-foreground">{option.description}</span>
                  </span>
                </button>
              )
            })}
            {filteredOptions.length === 0 ? (
              <div className="px-2 py-6 text-center text-sm text-muted-foreground">No statuses found.</div>
            ) : null}
          </div>
          <div className="flex items-center justify-between border-t p-2">
            <span className="text-xs text-muted-foreground">
              {selectedStatuses.length === 0 ? 'Showing all statuses' : `${selectedStatuses.length} selected`}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                onSelectedStatusesChange([])
                setQuery('')
              }}
              disabled={selectedStatuses.length === 0 && query.length === 0}
            >
              Clear
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {selectedStatuses.length > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Clear AgentRun status filter"
          onClick={() => onSelectedStatusesChange([])}
        >
          <XIcon />
        </Button>
      ) : null}
    </div>
  )
}

function SelectedStatusBadges({ statuses }: { statuses: readonly AgentRunStatus[] }) {
  const visibleStatuses = statuses.slice(0, 2)
  const overflowCount = statuses.length - visibleStatuses.length

  return (
    <>
      {visibleStatuses.map((status) => (
        <Badge key={status} variant="secondary" className="max-w-24 truncate px-1.5 py-0 text-xs">
          {status}
        </Badge>
      ))}
      {overflowCount > 0 ? (
        <Badge variant="secondary" className="px-1.5 py-0 text-xs">
          +{overflowCount}
        </Badge>
      ) : null}
    </>
  )
}
