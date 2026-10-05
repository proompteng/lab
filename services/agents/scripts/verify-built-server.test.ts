import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const verifier = fileURLToPath(new URL('./verify-built-server.ts', import.meta.url))

describe('built Agents server verification', () => {
  for (const mode of ['healthy', 'http-error', 'wrong-service', 'crash'] as const) {
    it(`checks the bundled HTTP server when it is ${mode}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'agents-bundle-smoke-'))
      try {
        await mkdir(join(root, '.output/server'), { recursive: true })
        await writeFile(
          join(root, '.output/server/index.mjs'),
          mode === 'crash'
            ? `console.error('bundle initialization failed'); process.exit(1)`
            : `
if (process.env.VERIFY_BUNDLE_MUST_NOT_INHERIT) throw Error('Unexpected inherited environment')
Bun.serve({
  hostname: process.env.HOST,
  port: Number(process.env.PORT),
  fetch: () => Response.json({
    status: 'ok',
    service: ${JSON.stringify(mode === 'wrong-service' ? 'other-service' : 'agents')},
    agentsController: { enabled: false, extraHealthDetail: true },
  }, {status: ${mode === 'http-error' ? 500 : 200}}),
})`,
        )
        const result = run('bun', [verifier, root], {
          env: { ...process.env, VERIFY_BUNDLE_MUST_NOT_INHERIT: 'smoke-test-marker' },
          timeout: 25_000,
        })
        if (mode === 'healthy') {
          expect((await result).stdout).toContain('"status":200,"service":"agents"')
        } else {
          await expect(result).rejects.toThrow(
            mode === 'crash'
              ? 'bundle initialization failed'
              : mode === 'http-error'
                ? 'Bundled server /health failed'
                : 'other-service',
          )
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
})
