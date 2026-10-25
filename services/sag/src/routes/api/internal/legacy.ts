import { createFileRoute } from '@tanstack/react-router'
import { listLiveAgentRuns } from '~/server/kubernetes'

export const Route = createFileRoute('/api/internal/legacy')({
  server: {
    handlers: {
      GET: async () => {
        const runs = await listLiveAgentRuns(25)
        const lines = runs.map((run, index) =>
          [
            String(index + 1).padStart(3, '0'),
            run?.namespace ?? 'agents',
            run?.name ?? 'agentrun',
            run?.agent ?? 'agent',
            String(run?.requestedSecrets?.length ?? 0),
          ].join('|'),
        )
        return new Response(`${lines.join('\n')}\n`, {
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        })
      },
    },
  },
})
