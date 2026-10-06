'use client'

import DOMPurify from 'dompurify'
import { useEffect, useId, useState, type ReactNode } from 'react'

import { CodexCopyButton } from './codex-copy-button'

async function loadMermaid() {
  const { default: mermaid } = await import('mermaid')
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'dark',
    fontFamily: 'Arial, sans-serif',
    htmlLabels: false,
    // Diagram directives must not relax the application's rendering policy.
    secure: [
      'secure',
      'securityLevel',
      'startOnLoad',
      'maxTextSize',
      'maxEdges',
      'suppressErrorRendering',
      'dompurifyConfig',
      'htmlLabels',
      'flowchart',
    ],
    flowchart: { htmlLabels: false },
  })
  return mermaid
}

let mermaidPromise: ReturnType<typeof loadMermaid> | undefined
let renderQueue = Promise.resolve()

function getMermaid() {
  return (mermaidPromise ??= loadMermaid().catch((error) => {
    mermaidPromise = undefined
    throw error
  }))
}

export function CodexMermaid({ source, children }: { source: string; children: ReactNode }) {
  const reactId = useId()
  const id = `tengri-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [result, setResult] = useState<{ source: string; svg: string | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    const render = async () => {
      if (cancelled) return
      try {
        const mermaid = await getMermaid()
        if (cancelled) return
        // Mermaid fetches image nodes during layout, before SVG sanitization.
        const diagram = await mermaid.mermaidAPI.getDiagramFromText(source)
        const data = (diagram.db as { getData?: () => { nodes?: { img?: unknown }[] } }).getData?.()
        if (Array.isArray(data?.nodes) && data.nodes.some((node) => node.img)) {
          throw new Error('Diagram images are disabled')
        }
        if (cancelled) return
        const { svg } = await mermaid.render(id, source)
        if (cancelled) return
        const sanitized = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
          ADD_TAGS: ['style'],
          FORBID_TAGS: ['foreignObject', 'a', 'image'],
        })
        setResult({ source, svg: sanitized })
      } catch {
        if (!cancelled) setResult({ source, svg: null })
      }
    }
    // Coalesce streaming bursts and skip obsolete work before Mermaid queues a layout.
    const timer = setTimeout(() => {
      renderQueue = renderQueue.then(render)
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [id, source])

  const current = result?.source === source ? result : null
  if (!current?.svg) {
    return (
      <div>
        <p className="mt-3 text-xs text-zinc-400" role="status">
          {current ? 'Diagram unavailable; showing source.' : 'Rendering diagram…'}
        </p>
        {children}
      </div>
    )
  }

  return (
    <figure className="my-4 overflow-hidden rounded-lg border border-zinc-700/60 bg-zinc-950/50">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1 text-xs text-zinc-400">
        <span>Mermaid</span>
        <CodexCopyButton label="Copy diagram source" value={() => source} />
      </div>
      <div
        aria-label="Mermaid diagram"
        role="img"
        className="overflow-auto p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: current.svg }}
      />
    </figure>
  )
}
