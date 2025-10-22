import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import React from 'react'
import { trpc } from '~/app/router.tsx'
import type { Pod } from '~/common/schemas/pod.ts'
import { MultiSelect } from '~/components/multi-select'
import { StatusBadge } from '~/components/status-badge'

interface PodTableProps {
  pods?: Pod[]
  isLoading: boolean
  error: unknown
}

const PodTable = React.memo(({ pods, isLoading, error }: PodTableProps) => {
  const formatCreationTime = React.useCallback((dateInput?: Date | string): string => {
    if (!dateInput) return 'N/A'
    const date = dateInput instanceof Date ? dateInput : new Date(dateInput)
    return `${date.toLocaleDateString()}, ${date.toLocaleTimeString()}`
  }, [])

  if (isLoading)
    return (
      <div className="border border-zinc-700 text-sm overflow-hidden rounded-md h-[calc(100vh-10rem)]">
        <div className="w-full">
          <table className="w-full text-left table-fixed">
            <thead className="bg-zinc-800/50 text-zinc-400/90 border-b border-zinc-700">
              <tr>
                <th className="py-2 px-3 font-medium w-[30%]">Name</th>
                <th className="py-2 px-3 font-medium w-[20%]">Namespace</th>
                <th className="py-2 px-3 font-medium w-[15%]">Status</th>
                <th className="py-2 px-3 font-medium w-[20%]">Created</th>
                <th className="py-2 px-3 font-medium w-[15%]">IP</th>
              </tr>
            </thead>
          </table>
        </div>
        <div className="overflow-y-auto h-[calc(100vh-12rem-6px)]">
          <table className="w-full text-left table-fixed">
            <tbody className="bg-zinc-700/10 text-zinc-400/70">
              {Array.from({ length: 30 }).map(() => (
                <tr
                  key={`skeleton-${Math.random().toString(36).substring(2, 9)}`}
                  className="border-b border-zinc-800 animate-pulse"
                >
                  <td className="py-1.5 px-3 w-[30%]">
                    <div className="h-4 bg-zinc-800 rounded w-4/5" />
                  </td>
                  <td className="py-1.5 px-3 w-[20%]">
                    <div className="h-4 bg-zinc-800 rounded w-2/3" />
                  </td>
                  <td className="py-1.5 px-3 w-[15%]">
                    <div className="h-4 bg-zinc-800 rounded w-1/2" />
                  </td>
                  <td className="py-1.5 px-3 w-[20%]">
                    <div className="h-4 bg-zinc-800 rounded w-3/4" />
                  </td>
                  <td className="py-1.5 px-3 w-[15%]">
                    <div className="h-4 bg-zinc-800 rounded w-2/3" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )

  if (error)
    return (
      <div className="border border-zinc-700 text-sm overflow-hidden rounded-md h-[calc(100vh-10rem)]">
        <div className="w-full py-2 text-sm text-red-400 flex items-center justify-center h-full">
          Error loading pods: {error instanceof Error ? error.message : 'Unknown error'}
        </div>
      </div>
    )

  if (!pods?.length)
    return (
      <div className="border border-zinc-700 text-sm overflow-hidden rounded-md h-[calc(100vh-10rem)]">
        <div className="w-full py-2 text-sm text-zinc-400/80 flex items-center justify-center h-full">
          No pods found
        </div>
      </div>
    )

  return (
    <div className="border border-zinc-700 text-sm overflow-hidden rounded-md h-[calc(100vh-10rem)]">
      <div className="w-full">
        <table className="w-full text-left table-fixed">
          <thead className="bg-zinc-800/50 text-zinc-400/90 border-b border-zinc-700">
            <tr>
              <th className="py-2 px-3 font-medium w-[30%]">Name</th>
              <th className="py-2 px-3 font-medium w-[20%]">Namespace</th>
              <th className="py-2 px-3 font-medium w-[15%]">Status</th>
              <th className="py-2 px-3 font-medium w-[20%]">Created</th>
              <th className="py-2 px-3 font-medium w-[15%]">IP</th>
            </tr>
          </thead>
        </table>
      </div>
      <div className="overflow-y-auto h-[calc(100vh-12rem-6px)]">
        <table className="w-full text-left table-fixed">
          <tbody className="bg-zinc-700/10 text-zinc-400/70">
            {pods.map((pod) => (
              <tr
                key={`${pod.metadata?.namespace}-${pod.metadata?.name}`}
                className="border-b border-zinc-800 hover:bg-zinc-900 transition-colors"
              >
                <td className="py-1.5 px-3 font-medium w-[30%] truncate">
                  {pod.metadata?.name ? (
                    <Link
                      to="/pods/$namespace/$podName"
                      params={{
                        podName: pod.metadata.name,
                        namespace: pod.metadata?.namespace || 'default',
                      }}
                      className="text-zinc-300 hover:text-zinc-400/80 transition-colors cursor-default"
                    >
                      {pod.metadata.name}
                    </Link>
                  ) : (
                    'N/A'
                  )}
                </td>
                <td className="py-1.5 px-3 w-[20%] truncate">{pod.metadata?.namespace || 'N/A'}</td>
                <td className="py-1.5 px-3 w-[15%]">
                  <StatusBadge status={pod.status?.phase} />
                </td>
                <td className="py-1.5 px-3 w-[20%] truncate">{formatCreationTime(pod.metadata?.creationTimestamp)}</td>
                <td className="py-1.5 px-3 w-[15%] truncate">{pod.status?.podIp || 'N/A'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
})

PodTable.displayName = 'PodTable'

export const Route = createFileRoute('/')({
  component: IndexComponent,
})

export function IndexComponent() {
  const { data: pods, isLoading, error } = useQuery(trpc.pod.list.queryOptions())
  const [searchQuery, setSearchQuery] = React.useState('')
  const [namespaceFilter, setNamespaceFilter] = React.useState<string[]>(['*'])

  const handleSearchChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value)
  }, [])

  const handleNamespaceChange = React.useCallback((value: string[]) => {
    setNamespaceFilter(value)
  }, [])

  // Extract unique namespaces for filter dropdown
  const namespaces = React.useMemo(() => {
    if (!pods) return []
    const namespaceSet = new Set<string>()

    for (const pod of pods) {
      if (pod.metadata?.namespace) {
        namespaceSet.add(pod.metadata.namespace)
      }
    }

    return Array.from(namespaceSet).sort()
  }, [pods])

  // Convert namespaces to the format expected by MultiSelect
  const namespaceOptions = React.useMemo(() => {
    return [
      { value: '*', label: 'All namespaces' },
      ...namespaces.map((namespace) => ({ value: namespace, label: namespace })),
    ]
  }, [namespaces])

  // Filter pods based on search query and namespace filter
  const filteredPods = React.useMemo(() => {
    if (!pods) return []
    // If '*' is selected, ignore namespace filtering
    const filterAll = namespaceFilter.includes('*')
    return pods.filter((pod) => {
      if (!filterAll && pod.metadata?.namespace && !namespaceFilter.includes(pod.metadata.namespace)) {
        return false
      }
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase()
        return (
          pod.metadata?.name?.toLowerCase().includes(query) ||
          pod.metadata?.namespace?.toLowerCase().includes(query) ||
          pod.status?.phase?.toLowerCase().includes(query)
        )
      }
      return true
    })
  }, [pods, searchQuery, namespaceFilter])

  return (
    <div className="container mx-auto py-6 px-4">
      <div className="flex justify-between items-center mb-4">
        <div className="flex gap-4 items-center">
          <div className="relative w-64">
            <input
              type="text"
              placeholder="Search pods..."
              value={searchQuery}
              onChange={handleSearchChange}
              className="w-full h-[38px] px-3 py-2 bg-zinc-800 text-zinc-400/90 rounded-md border border-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-600 placeholder:text-zinc-400/50 placeholder:text-sm"
              aria-label="Search pods"
            />
            <svg
              className="absolute right-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-zinc-400"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <title>Search</title>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </div>
          <div className="w-64">
            <MultiSelect
              options={namespaceOptions}
              value={namespaceFilter}
              onChange={handleNamespaceChange}
              placeholder="Filter by namespace"
            />
          </div>
        </div>
        <h1 className="text-2xl font-bold text-zinc-400">Kubernetes Pods</h1>
      </div>
      <div className="w-full">
        <PodTable pods={filteredPods} isLoading={isLoading} error={error} />
      </div>
    </div>
  )
}
