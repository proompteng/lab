import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'bun:test'
import { z } from 'zod'

test('unauthenticated login and step-up reach the edge rate limiter before allocating OAuth state', () => {
  const documents: unknown[] = readFileSync(
    path.resolve(import.meta.dir, '../../../../../argocd/applications/proompteng/ingressroute.yaml'),
    'utf8',
  )
    .split(/^---$/m)
    .map((source) => Bun.YAML.parse(source))
  const routeSchema = z.object({
    match: z.string(),
    priority: z.number().default(0),
    middlewares: z.array(z.object({ name: z.string() })).default([]),
  })
  const router = z
    .object({
      kind: z.literal('IngressRoute'),
      spec: z.object({ routes: z.array(routeSchema) }),
    })
    .parse(documents.find((document) => z.object({ kind: z.literal('IngressRoute') }).safeParse(document).success))
  const route = router.spec.routes.find(
    (candidate) =>
      candidate.match.includes('Method(`POST`)') &&
      ['/api/auth/login', '/api/auth/step-up'].every((pathname) => candidate.match.includes(`Path(\`${pathname}\`)`)),
  )
  expect(route).toBeDefined()
  expect(route?.priority).toBeGreaterThan(
    Math.max(...router.spec.routes.filter((candidate) => candidate !== route).map((candidate) => candidate.priority)),
  )
  const limiter = z
    .object({
      metadata: z.object({ name: z.string() }),
      spec: z.object({
        rateLimit: z.object({
          average: z.number().positive().max(6),
          burst: z.number().positive().max(6),
          period: z.literal('1m'),
          sourceCriterion: z.undefined().optional(),
        }),
      }),
    })
    .parse(
      documents.find((document) => {
        const parsed = z
          .object({ kind: z.literal('Middleware'), metadata: z.object({ name: z.string() }) })
          .safeParse(document)
        return parsed.success && route?.middlewares.some((entry) => entry.name === parsed.data.metadata.name)
      }),
    )
  expect(route?.middlewares.map((entry) => entry.name)).toContain(limiter.metadata.name)
})
