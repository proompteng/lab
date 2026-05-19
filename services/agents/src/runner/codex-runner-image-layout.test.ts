import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

const dockerfile = () => readFileSync(new URL('../../Dockerfile.codex-runner', import.meta.url), 'utf8')
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const execFileAsync = promisify(execFile)

const finalStage = () => {
  const content = dockerfile()
  const start = content.lastIndexOf('\nFROM ')
  expect(start).toBeGreaterThanOrEqual(0)
  return content.slice(start + 1)
}

describe('Agents Codex runner image layout', () => {
  it('does not use the OpenAI universal image or Jangar runner scripts', () => {
    const content = dockerfile()

    expect(content).not.toContain('ghcr.io/openai/codex-universal')
    expect(content).not.toContain('services/jangar')
    expect(content).not.toContain('codex-implement')
  })

  it('keeps native build tooling out of the final runtime stage', () => {
    const content = finalStage()

    expect(content).not.toContain('build-essential')
    expect(content).not.toContain('pkg-config')
    expect(content).not.toContain('node-gyp')
  })

  it('copies only built runner and Codex package payloads into the final image', () => {
    const content = finalStage()

    expect(content).toContain(
      'COPY --from=codex-cli /usr/local/lib/node_modules/@openai/codex /usr/local/lib/node_modules/@openai/codex',
    )
    expect(content).toContain(
      'COPY --from=agents-runner-build /opt/agents-runner/agent-runner.js /app/services/agents/scripts/codex/agent-runner.js',
    )
    expect(content).toContain(
      'COPY --from=codex-package-build /opt/proompteng/packages/codex/dist /app/node_modules/@proompteng/codex/dist',
    )
    expect(content).not.toContain('COPY --from=codex-cli /usr/local/lib/node_modules /usr/local/lib/node_modules')
    expect(content).not.toContain('COPY services/agents /app/services/agents')
    expect(content).not.toContain('COPY packages/codex /opt/proompteng/packages/codex')
    expect(content).not.toContain('cp -R /opt/proompteng/packages/codex')
  })

  it('does not ship npm or npx in the final runtime stage', () => {
    const content = finalStage()

    expect(content).not.toContain('/usr/local/bin/npm')
    expect(content).not.toContain('/usr/local/bin/npx')
    expect(content).not.toContain('npm/bin/npm-cli.js')
    expect(content).not.toContain('npm/bin/npx-cli.js')
  })

  it('bundles the runner without runtime-resolving Effect or source TS modules', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'agents-runner-bundle-'))
    const outfile = join(outDir, 'agent-runner.js')

    try {
      const { stdout, stderr } = await execFileAsync(
        'bun',
        ['build', 'services/agents/scripts/codex/agent-runner.ts', '--target', 'bun', '--outfile', outfile],
        {
          cwd: repoRoot,
          maxBuffer: 10 * 1024 * 1024,
        },
      )

      expect(`${stderr}\n${stdout}`).toContain('agent-runner.js')

      const bundle = await readFile(outfile, 'utf8')
      expect(bundle).toContain('// services/agents/src/runner/codex-app-server.ts')
      expect(bundle).not.toMatch(/from ["']effect["']/)
      expect(bundle).not.toMatch(/require\(["']effect["']\)/)
      expect(bundle).not.toMatch(/import\(["']effect["']\)/)
      expect(bundle).not.toMatch(/from ["']\.\.\/\.\.\/src\/runner\/codex-app-server["']/)
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })
})
