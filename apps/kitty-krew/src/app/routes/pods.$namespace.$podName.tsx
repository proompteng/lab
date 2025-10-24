import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useId, useState } from 'react'
import { trpc } from '~/app/router.tsx'
import type { Container, ContainerPort } from '~/common/schemas/pod.ts'

export const Route = createFileRoute('/pods/$namespace/$podName')({
  component: PodDetailsComponent,
})

function PodDetailsHeader({ title }: { title: string }) {
  return (
    <div className="flex justify-between items-center mb-6">
      <Link to="/" className="flex items-center text-zinc-400/80 hover:text-zinc-400 transition-colors cursor-default">
        <svg
          className="h-5 w-5 mr-2"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <title>Back Arrow</title>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to Pods
      </Link>
      <h1 className="text-2xl font-bold text-zinc-300">{title}</h1>
    </div>
  )
}

function PodDetailsContainer({ children }: { children: ReactNode }) {
  return <div className="container mx-auto py-6 px-4">{children}</div>
}

function PodDetailsContent({ children }: { children: ReactNode }) {
  return (
    <div className="border border-zinc-700 text-sm overflow-hidden rounded-md h-[calc(100vh-10rem)]">{children}</div>
  )
}

function LogViewer({
  logs,
  isStreaming = false,
  wrapLogs = false,
}: {
  logs: string | string[] | null | undefined
  isStreaming?: boolean
  wrapLogs?: boolean
}) {
  const setLogContainerRef = useCallback((node: HTMLDivElement | null) => {
    if (node) {
      node.scrollTop = node.scrollHeight
    }
  }, [])

  if (!logs || logs.length === 0) {
    return (
      <div className="flex w-full h-full items-center justify-center text-sm text-zinc-400/80">No logs available</div>
    )
  }

  return (
    <div className="relative h-full">
      {isStreaming && (
        <div className="absolute top-2 right-2 bg-zinc-800 text-zinc-200 text-xs px-2 py-1 rounded-full flex items-center gap-1">
          <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
          Streaming
        </div>
      )}
      <div
        ref={setLogContainerRef}
        className={`font-mono text-xs p-4 overflow-y-auto h-[500px] text-zinc-300 ${wrapLogs ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`}
      >
        {Array.isArray(logs)
          ? logs.map((line, i) => <div key={`log-${i}-${line.substring(0, 10)}`}>{line}</div>)
          : logs.split('\n').map((line, i) => <div key={`log-${i}-${line.substring(0, 10)}`}>{line}</div>)}
      </div>
    </div>
  )
}

// Log settings component
function LogSettings({
  tailLines,
  setTailLines,
  timestamps,
  setTimestamps,
  isStreaming,
  setIsStreaming,
  wrapLogs,
  setWrapLogs,
}: {
  tailLines: number
  setTailLines: (lines: number) => void
  timestamps: boolean
  setTimestamps: (show: boolean) => void
  isStreaming: boolean
  setIsStreaming: (streaming: boolean) => void
  wrapLogs: boolean
  setWrapLogs: (wrap: boolean) => void
}) {
  const timestampsId = useId()
  const wrapLogsId = useId()

  return (
    <div className="flex flex-col md:flex-row gap-4 p-4 bg-zinc-800/20 border border-zinc-700 rounded-md mb-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-zinc-400">Lines:</span>
        <select
          value={tailLines}
          onChange={(e) => setTailLines(Number(e.target.value))}
          className="bg-zinc-700 text-zinc-300 text-sm rounded px-2 py-1 border border-zinc-600"
          disabled={isStreaming}
        >
          <option value={50}>50</option>
          <option value={100}>100</option>
          <option value={500}>500</option>
          <option value={1000}>1000</option>
        </select>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id={timestampsId}
          checked={timestamps}
          onChange={(e) => setTimestamps(e.target.checked)}
          className="bg-zinc-700 border-zinc-600"
        />
        <label htmlFor={timestampsId} className="text-sm text-zinc-400">
          Show timestamps
        </label>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id={wrapLogsId}
          checked={wrapLogs}
          onChange={(e) => setWrapLogs(e.target.checked)}
          className="bg-zinc-700 border-zinc-600"
        />
        <label htmlFor={wrapLogsId} className="text-sm text-zinc-400">
          Wrap logs
        </label>
      </div>

      <div className="flex items-center gap-2 ml-auto">
        <button
          type="button"
          onClick={() => setIsStreaming(!isStreaming)}
          className={`px-3 py-1 rounded-md text-sm flex items-center gap-1 ${
            isStreaming
              ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
              : 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
          }`}
        >
          {isStreaming ? (
            <>
              <span className="w-2 h-2 bg-red-500 rounded-full" /> Stop
            </>
          ) : (
            <>
              <span className="w-2 h-2 bg-green-500 rounded-full" /> Stream
            </>
          )}
        </button>
      </div>
    </div>
  )
}

export function PodDetailsComponent() {
  const { podName, namespace } = Route.useParams()
  const [selectedContainer, setSelectedContainer] = useState<string>('')
  const [tailLines, setTailLines] = useState<number>(100)
  const [timestamps, setTimestamps] = useState<boolean>(false)
  const [isStreaming, setIsStreaming] = useState<boolean>(false)
  const [streamedLogs, setStreamedLogs] = useState<string[]>([])
  const [wrapLogs, setWrapLogs] = useState(false)

  const {
    data: pod,
    isLoading,
    error,
  } = useQuery(
    trpc.pod.byName.queryOptions({
      podName,
      namespace,
    }),
  )

  // Set first container as default when pod data loads
  useEffect(() => {
    if (pod?.spec?.containers && pod.spec.containers.length > 0) {
      // Always set to first container when pod data loads, regardless of previous selection
      setSelectedContainer(pod.spec.containers[0].name)
    }
  }, [pod?.spec?.containers])

  // Reset streaming logs when changing containers
  useEffect(() => {
    if (selectedContainer) {
      setStreamedLogs([])
    }
  }, [selectedContainer])

  // Create a custom streaming logs implementation
  useEffect(() => {
    if (!isStreaming || !selectedContainer || !pod?.metadata) return

    const namespace = pod.metadata.namespace || ''
    const podName = pod.metadata.name || ''

    // Clear previous logs before starting streaming
    setStreamedLogs([])

    // Use EventSource for Server-Sent Events instead of fetch API
    const eventSource = new EventSource(
      `/trpc/pod.logsStream?input=${encodeURIComponent(
        JSON.stringify({
          namespace,
          podName,
          container: selectedContainer,
          tailLines,
          timestamps,
        }),
      )}`,
    )

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.result?.data) {
          setStreamedLogs((prev) => [...prev, data.result.data])
        }
      } catch (e) {
        console.error('Failed to parse event data:', e)
      }
    }

    eventSource.onerror = () => {
      console.error('EventSource failed')
      setIsStreaming(false)
      eventSource.close()
    }

    return () => {
      eventSource.close()
    }
  }, [isStreaming, selectedContainer, pod, tailLines, timestamps])

  const {
    data: logs,
    isLoading: isLoadingLogs,
    error: logsError,
  } = useQuery({
    ...trpc.pod.logs.queryOptions({
      podName,
      namespace,
      container: selectedContainer,
      tailLines,
      timestamps,
      follow: false,
    }),
    enabled: !!selectedContainer && !isStreaming,
  })

  if (isLoading) {
    return (
      <PodDetailsContainer>
        <PodDetailsHeader title="Pod Details" />
        <PodDetailsContent>
          <div className="w-full py-2 text-sm text-zinc-400/80 flex items-center justify-center h-full">
            Loading pod details...
          </div>
        </PodDetailsContent>
      </PodDetailsContainer>
    )
  }

  if (error || !pod) {
    return (
      <PodDetailsContainer>
        <PodDetailsHeader title="Pod Details" />
        <PodDetailsContent>
          <div className="w-full py-2 text-red-400 flex items-center justify-center h-full">
            {error instanceof Error ? error.message : 'Failed to load pod details'}
          </div>
        </PodDetailsContent>
      </PodDetailsContainer>
    )
  }

  return (
    <PodDetailsContainer>
      <PodDetailsHeader title={`Pod: ${pod.metadata?.name || 'Unknown'}`} />
      <PodDetailsContent>
        <div className="p-6 overflow-y-auto h-full">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
            <div className="bg-zinc-700/10 p-4 rounded-md border border-zinc-700">
              <h2 className="text-lg font-medium text-zinc-300 mb-3">Metadata</h2>
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-4">
                  <span className="text-zinc-400/70">Namespace:</span>
                  <span className="text-zinc-300 text-right">{pod.metadata?.namespace || 'N/A'}</span>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <span className="text-zinc-400/70">Created:</span>
                  <span className="text-zinc-300 text-right">
                    {pod.metadata?.creationTimestamp
                      ? new Date(pod.metadata.creationTimestamp).toLocaleString()
                      : 'N/A'}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <span className="text-zinc-400/70">UID:</span>
                  <span className="text-zinc-300 text-right">{pod.metadata?.uid || 'N/A'}</span>
                </div>
              </div>
            </div>

            <div className="bg-zinc-700/10 p-4 rounded-md border border-zinc-700">
              <h2 className="text-lg font-medium text-zinc-300 mb-3">Status</h2>
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-4">
                  <span className="text-zinc-400/70">Phase:</span>
                  <span className="text-zinc-300 text-right">{pod.status?.phase || 'N/A'}</span>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <span className="text-zinc-400/70">Pod IP:</span>
                  <span className="text-zinc-300 text-right">{pod.status?.podIp || 'N/A'}</span>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <span className="text-zinc-400/70">Host IP:</span>
                  <span className="text-zinc-300 text-right">{pod.status?.hostIp || 'N/A'}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-zinc-700/10 p-4 rounded-md border border-zinc-700 mb-6">
            <h2 className="text-lg font-medium text-zinc-300 mb-3">Spec</h2>
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-4">
                <span className="text-zinc-400/70">Node Name:</span>
                <span className="text-zinc-300 text-right">{pod.spec?.nodeName || 'N/A'}</span>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <span className="text-zinc-400/70">Restart Policy:</span>
                <span className="text-zinc-300 text-right">{pod.spec?.restartPolicy || 'N/A'}</span>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <span className="text-zinc-400/70">Service Account:</span>
                <span className="text-zinc-300 text-right">{pod.spec?.serviceAccountName || 'N/A'}</span>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <span className="text-zinc-400/70">DNS Policy:</span>
                <span className="text-zinc-300 text-right">{pod.spec?.dnsPolicy || 'N/A'}</span>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <span className="text-zinc-400/70">Priority:</span>
                <span className="text-zinc-300 text-right">
                  {pod.spec?.priority !== undefined ? pod.spec.priority : 'N/A'}
                </span>
              </div>
            </div>
          </div>

          {pod.spec?.containers && (
            <div className="bg-zinc-700/10 p-4 rounded-md border border-zinc-700">
              <h2 className="text-lg font-medium text-zinc-300 mb-3">Containers</h2>
              <div className="space-y-4">
                {pod.spec.containers.map((container: Container) => (
                  <div key={container.name} className="bg-zinc-700/10 p-4 rounded-md border border-zinc-700">
                    <h3 className="text-md font-medium text-zinc-300 mb-2">{container.name}</h3>
                    <div className="space-y-2">
                      <div className="space-y-2">
                        <div className="grid grid-cols-2 gap-4">
                          <span className="text-zinc-400/70">Image:</span>
                          <span className="text-zinc-300 text-right">{container.image || 'N/A'}</span>
                        </div>
                        {container.ports && container.ports.length > 0 && (
                          <div>
                            <span className="text-zinc-400/70">Ports:</span>
                            <div className="mt-1 flex flex-wrap gap-2">
                              {container.ports.map((port: ContainerPort) => (
                                <span
                                  key={`${port.containerPort}-${port.protocol || 'TCP'}`}
                                  className="px-2 py-1 bg-zinc-800 rounded text-xs text-zinc-400/80"
                                >
                                  {port.containerPort}
                                  {port.protocol ? `/${port.protocol}` : ''}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="bg-zinc-700/10 p-4 rounded-md border border-zinc-700 mt-6">
            <h2 className="text-lg font-medium text-zinc-300 mb-3">Logs</h2>

            {pod?.spec?.containers && pod.spec.containers.length > 0 ? (
              <div>
                <div className="flex border-b border-zinc-700 mb-4">
                  {pod.spec.containers.map((container: Container) => (
                    <button
                      key={container.name}
                      type="button"
                      onClick={() => setSelectedContainer(container.name)}
                      className={`px-4 py-2 text-sm font-medium ${
                        selectedContainer === container.name
                          ? 'text-zinc-200 border-b-2 border-zinc-400 -mb-px'
                          : 'text-zinc-400/70 hover:text-zinc-300'
                      }`}
                    >
                      {container.name}
                    </button>
                  ))}
                </div>

                {!selectedContainer ? (
                  <div className="text-zinc-400/80">Select a container to view logs</div>
                ) : (
                  <>
                    <LogSettings
                      tailLines={tailLines}
                      setTailLines={setTailLines}
                      timestamps={timestamps}
                      setTimestamps={setTimestamps}
                      isStreaming={isStreaming}
                      setIsStreaming={setIsStreaming}
                      wrapLogs={wrapLogs}
                      setWrapLogs={setWrapLogs}
                    />

                    {isStreaming ? (
                      streamedLogs.length === 0 ? (
                        <div className="text-zinc-400/80 py-4">Waiting for logs...</div>
                      ) : (
                        <LogViewer logs={streamedLogs} isStreaming={true} wrapLogs={wrapLogs} />
                      )
                    ) : isLoadingLogs ? (
                      <div className="text-zinc-400/80 py-4">Loading logs...</div>
                    ) : logsError ? (
                      <div className="text-red-400 py-4">
                        {logsError instanceof Error ? logsError.message : 'Failed to load logs'}
                      </div>
                    ) : (
                      <LogViewer logs={logs} wrapLogs={wrapLogs} />
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className="text-zinc-400/80">No containers found</div>
            )}
          </div>
        </div>
      </PodDetailsContent>
    </PodDetailsContainer>
  )
}
