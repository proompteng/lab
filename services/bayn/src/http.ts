import { Effect } from 'effect'

import { checkDependencies, type DependencyRegistryService } from './dependencies'
import type { LifecycleService } from './lifecycle'

const jsonResponse = (body: unknown, status: number): Response =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
    },
  })

export const handleRequest = (
  request: Request,
  lifecycle: LifecycleService,
  dependencies: DependencyRegistryService,
): Effect.Effect<Response> => {
  const { pathname } = new URL(request.url)

  if (request.method !== 'GET') {
    return Effect.succeed(jsonResponse({ service: 'bayn', status: 'not-found' }, 404))
  }

  if (pathname === '/livez') {
    return Effect.succeed(jsonResponse({ service: 'bayn', status: 'live' }, 200))
  }

  if (pathname === '/readyz') {
    return Effect.all({
      phase: lifecycle.phase,
      dependencies: checkDependencies(dependencies),
    }).pipe(
      Effect.map(({ phase, dependencies: dependencyStatuses }) => {
        const dependenciesReady = dependencyStatuses.every(({ status }) => status === 'ready')
        const ready = phase === 'ready' && dependenciesReady

        return jsonResponse(
          {
            service: 'bayn',
            status: ready ? 'ready' : 'not-ready',
            phase,
            dependencies: dependencyStatuses,
          },
          ready ? 200 : 503,
        )
      }),
    )
  }

  return Effect.succeed(jsonResponse({ service: 'bayn', status: 'not-found' }, 404))
}
