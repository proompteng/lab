import { useCallback, useEffect, useRef, useState } from 'react'

import { Layout } from './components/Layout'

const spinner = (
  <svg className="h-4 w-4 animate-spin text-sky-300" viewBox="0 0 24 24" role="img">
    <title>Loading</title>
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
  </svg>
)

type Bridge = typeof window.kubeBridge

type PodRow = { name: string; phase: string; node: string }

type LoadState = 'idle' | 'loading'

function useStatusAnnouncer() {
  const ref = useRef<HTMLSpanElement | null>(null)
  const announce = useCallback((message: string) => {
    if (ref.current) ref.current.textContent = message
  }, [])
  return { ref, announce } as const
}

export default function App() {
  const bridge: Bridge | null = typeof window !== 'undefined' ? window.kubeBridge : null

  const [kubeconfigPath, setKubeconfigPath] = useState<string>('')
  const [kubeconfigContent, setKubeconfigContent] = useState<string>('')
  const [namespaces, setNamespaces] = useState<string[]>([])
  const [selectedNamespace, setSelectedNamespace] = useState<string | null>(null)
  const [pods, setPods] = useState<PodRow[]>([])

  const [nsState, setNsState] = useState<LoadState>('idle')
  const [podsState, setPodsState] = useState<LoadState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [podsError, setPodsError] = useState<string | null>(null)
  const { ref: statusRef, announce } = useStatusAnnouncer()

  const loadNamespaces = useCallback(
    async (content: string, label: string) => {
      if (!bridge) return
      setNsState('loading')
      setError(null)
      try {
        const list = await bridge.listNamespaces(content)
        setNamespaces(list)
        setKubeconfigContent(content)
        setKubeconfigPath(label)
        announce(`Loaded ${list.length} namespaces`)
        setSelectedNamespace(list[0] ?? null)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to load namespaces'
        setError(message)
        announce(message)
      } finally {
        setNsState('idle')
      }
    },
    [announce, bridge],
  )

  const handleSelectKubeconfig = useCallback(async () => {
    if (!bridge) return
    setError(null)
    setNsState('loading')
    try {
      const result = await bridge.selectKubeconfig()
      if (!result) {
        announce('File picker closed')
        return
      }
      await loadNamespaces(result.content, result.path)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to read kubeconfig file'
      setError(message)
      announce(message)
    } finally {
      setNsState('idle')
    }
  }, [announce, bridge, loadNamespaces])

  useEffect(() => {
    const loadPods = async () => {
      if (!bridge || !kubeconfigContent || !selectedNamespace) return
      setPodsState('loading')
      setPodsError(null)
      try {
        const list = await bridge.listPods(kubeconfigContent, selectedNamespace)
        setPods(list)
        announce(`Loaded ${list.length} pods`)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to load pods'
        setPodsError(message)
        announce(message)
      } finally {
        setPodsState('idle')
      }
    }
    loadPods()
  }, [announce, bridge, kubeconfigContent, selectedNamespace])

  const sidebar = (
    <div className="space-y-2 flex flex-col h-full min-h-0">
      <span className="sr-only" aria-live="polite" ref={statusRef} />
      <button
        type="button"
        onClick={handleSelectKubeconfig}
        disabled={nsState === 'loading' || !bridge}
        className="w-full inline-flex items-center justify-center gap-2 rounded-sm bg-gradient-to-br from-sky-400 to-cyan-500 px-3 py-3 text-xs font-semibold text-slate-900 shadow-lg transition hover:shadow-xl focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      >
        {nsState === 'loading' ? spinner : null}
        {kubeconfigPath ? 'Change kubeconfig' : 'Load kubeconfig'}
      </button>

      <div className="rounded-sm border border-white/10 bg-slate-900/70 flex-1 min-h-0 overflow-hidden">
        <div className="px-3 py-3 text-xs uppercase tracking-wide text-slate-400">Namespaces</div>
        <div className="h-full overflow-y-auto divide-y divide-white/10">
          {namespaces.map((ns) => (
            <button
              key={ns}
              type="button"
              onClick={() => setSelectedNamespace(ns)}
              className={`w-full px-3 py-2.5 text-left text-sm transition hover:bg-slate-900/60 border-l ${selectedNamespace === ns ? 'bg-slate-900/70 text-sky-200 border-sky-300/70' : 'text-slate-200 border-transparent'}`}
            >
              {ns}
            </button>
          ))}
        </div>
      </div>
    </div>
  )

  const header = (
    <div className="grid grid-cols-[16rem_1fr] gap-x-2 items-center text-sm text-slate-200">
      <span className="text-xs uppercase tracking-[0.3em] text-sky-300/80">Kabina</span>
      <div className="flex items-center gap-4 px-3">
        <span className="text-sm text-slate-200 truncate" title={selectedNamespace ?? undefined}>
          {selectedNamespace ?? ''}
        </span>
        <span className="ml-auto text-sm text-slate-200" aria-live="polite">
          {podsState === 'loading' && selectedNamespace ? 'Loading…' : selectedNamespace ? `${pods.length} pods` : ''}
        </span>
      </div>
    </div>
  )

  const content = (
    <div className="space-y-2 flex flex-col flex-1 min-h-0">
      {error ? (
        <div className="rounded-sm border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-100" role="alert">
          {error}
        </div>
      ) : null}

      {podsError ? (
        <div className="rounded-sm border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-100" role="alert">
          {podsError}
        </div>
      ) : null}

      {podsState === 'loading' ? <div className="text-xs text-slate-400">Loading pods…</div> : null}

      {selectedNamespace && pods.length > 0 ? (
        <div className="flex-1 overflow-auto rounded-sm border border-white/10">
          <table className="w-full text-sm text-slate-200 select-none">
            <thead className="sticky top-0 z-10 bg-slate-900/80 backdrop-blur text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th scope="col" className="px-3 py-2.5 text-left font-medium">
                  Name
                </th>
                <th scope="col" className="px-3 py-2.5 text-left font-medium">
                  Phase
                </th>
                <th scope="col" className="px-3 py-2.5 text-left font-medium">
                  Node
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {pods.map((pod) => (
                <tr key={pod.name} className="hover:bg-slate-900/40 select-none">
                  <td className="px-3 py-2.5 text-slate-200">{pod.name}</td>
                  <td className="px-3 py-2.5 text-slate-200">{pod.phase}</td>
                  <td className="px-3 py-2.5 text-slate-200">{pod.node}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : selectedNamespace && podsState === 'idle' ? (
        <div className="text-xs text-slate-400">No pods found.</div>
      ) : null}
    </div>
  )

  return <Layout header={header} sidebar={sidebar} content={content} />
}
