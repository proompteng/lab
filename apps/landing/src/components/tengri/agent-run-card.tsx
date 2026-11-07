'use client'

import { useState } from 'react'
import { z } from 'zod'
import { Button, Card, CardContent } from '@proompteng/design/ui'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { agentRunTerminal, agentRunViewSchema, type AgentRunView } from '@/lib/tengri/agent-runs'

const responseSchema = z.object({ view: agentRunViewSchema, canCancel: z.boolean() })
export function AgentRunCard({ initial, agentId }: { initial: AgentRunView; agentId?: string }) {
  const [view, setView] = useState(initial)
  const [pending, setPending] = useState(false)
  const [canCancel, setCanCancel] = useState(false)
  const [cancelUnconfirmed, setCancelUnconfirmed] = useState(false)
  const [error, setError] = useState('')
  const command = async (operation: 'get_result' | 'cancel_run') => {
    if (!agentId || pending) return
    setPending(true)
    setError('')
    // A failed cancellation reply is uncertain. Never automatically send it again.
    if (operation === 'cancel_run') setCancelUnconfirmed(true)
    try {
      const response = await fetch('/api/tengri/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentId,
          targetId: view.targetId,
          runId: view.run.runId,
          operation,
          operationId: crypto.randomUUID(),
        }),
      })
      if (!response.ok)
        throw new Error(
          operation === 'cancel_run'
            ? 'Cancellation could not be confirmed. Refresh the run to check its status.'
            : 'Could not refresh this run. Check your connection and access.',
        )
      const result = responseSchema.parse(await response.json())
      setView(result.view)
      setCanCancel(result.canCancel)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read the run.')
    } finally {
      setPending(false)
    }
  }
  return (
    <Card size="sm" className="w-full min-w-0 max-w-xl bg-zinc-900/40 ring-white/10" aria-label="Agent run">
      <CardContent>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-label-14 text-zinc-200">Agent run</span>
          <span className="text-label-12 text-zinc-400" role="status">
            {view.run.status}
          </span>
          {agentId && (
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh run"
                disabled={pending}
                onClick={() => void command('get_result')}
              >
                {pending ? (
                  <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
              </Button>
              {canCancel && !agentRunTerminal(view.run.status) && view.run.status !== 'Cancelling' && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending || cancelUnconfirmed}
                  onClick={() => void command('cancel_run')}
                >
                  Cancel run
                </Button>
              )}
            </div>
          )}
        </div>
        {view.run.message && <p className="mt-1 text-copy-13 text-zinc-400">{view.run.message}</p>}
        {view.run.progress?.activeTools?.map((tool, index) => (
          <p key={index} className="mt-1 truncate text-copy-13 text-zinc-400">
            {tool.title}
          </p>
        ))}
        {view.run.result?.responseText && (
          <details className="mt-2 text-copy-13 text-zinc-300">
            <summary className="cursor-pointer rounded focus-visible:outline-2">Result</summary>
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-sans">
              {view.run.result.responseText}
            </pre>
            {view.run.result.responseTruncated && <p className="mt-1 text-zinc-400">Result shortened by the runner.</p>}
          </details>
        )}
        {error && (
          <p role="alert" className="mt-2 text-copy-13 text-amber-300">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
