import { Effect, pipe } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { postEnrichHandlerEffect } from '~/routes/api/enrich'
import { Atlas, type AtlasService } from '~/server/atlas'
import { BumbaWorkflows, type BumbaWorkflowsService } from '~/server/bumba'

const run = (request: Request, atlasService: AtlasService, bumbaService: BumbaWorkflowsService) =>
  Effect.runPromise(
    pipe(
      postEnrichHandlerEffect(request),
      Effect.provideService(Atlas, atlasService),
      Effect.provideService(BumbaWorkflows, bumbaService),
    ),
  )

describe('enrich event dispatch', () => {
  it('does not start bumba workflows directly for event payloads', async () => {
    const atlasService = {
      upsertRepository: vi.fn(() =>
        Effect.succeed({
          id: 'repo-1',
          name: 'proompteng/lab',
          defaultRef: 'main',
          createdAt: new Date().toISOString(),
        }),
      ),
      upsertGithubEvent: vi.fn(() =>
        Effect.succeed({
          id: 'event-1',
          repositoryId: 'repo-1',
          deliveryId: 'delivery-1',
          eventType: 'push',
          repository: 'proompteng/lab',
          installationId: null,
          senderLogin: null,
          payload: {},
          receivedAt: new Date().toISOString(),
          processedAt: null,
        }),
      ),
    } as unknown as AtlasService

    const bumbaService: BumbaWorkflowsService = {
      startEnrichFile: vi.fn(() => Effect.fail(new Error('should not be called'))),
      startEnrichRepository: vi.fn(() => Effect.fail(new Error('should not be called'))),
    }

    const request = new Request('http://localhost/api/enrich', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        metadata: {
          deliveryId: 'delivery-1',
          event: 'push',
          identifiers: { repositoryFullName: 'proompteng/lab' },
          payload: {
            repository: { full_name: 'proompteng/lab', default_branch: 'main' },
            after: 'abc123',
            commits: [{ added: ['src/a.ts'], modified: [] }],
          },
          receivedAt: '2026-02-21T00:00:00.000Z',
        },
      }),
    })

    const response = await run(request, atlasService, bumbaService)
    expect(response.status).toBe(202)

    const json = await response.json()
    expect(json.ok).toBe(true)
    expect(json.workflow).toBeNull()
    expect(json.workflows).toEqual([])

    expect(atlasService.upsertRepository).toHaveBeenCalledTimes(1)
    expect(atlasService.upsertGithubEvent).toHaveBeenCalledTimes(1)
    expect(bumbaService.startEnrichFile).not.toHaveBeenCalled()
    expect(bumbaService.startEnrichRepository).not.toHaveBeenCalled()
  })
})
