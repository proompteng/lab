import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'bun:test'
import { isMap, isSeq, parseDocument } from 'yaml'

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
const workflow = parseDocument(readFileSync(join(repoRoot, '.github/workflows/nix-oci-build-common.yml'), 'utf8'))
const steps = workflow.getIn(['jobs', 'build-platform', 'steps'])
const environment = workflow.getIn(['jobs', 'build-platform', 'env'])
if (!isSeq(steps) || !isMap(environment)) throw new Error('Missing native image build job')
const warmStep = steps.items.find(
  (step) => isMap(step) && step.get('name') === 'Warm Nix image archive output in Attic',
)
const warmScript = isMap(warmStep) ? warmStep.get('run') : undefined
if (typeof warmScript !== 'string') throw new Error('Missing image cache upload command')
const stepEnvironment = isMap(warmStep) ? warmStep.get('env') : undefined
if (!isMap(stepEnvironment)) throw new Error('Missing image cache upload environment')
const workflowEnv = Object.fromEntries(
  [...environment.items, ...stepEnvironment.items].map(({ key, value }) => [String(key), String(value)]),
)

it.each([0, 17])('attempts a multi-GiB archive upload and records Attic exit status %i', (uploadStatus) => {
  const dir = mkdtempSync(join(tmpdir(), 'nix-image-cache-'))
  try {
    const bin = join(dir, 'bin')
    const logs = join(dir, 'logs')
    const archive = join(dir, 'image.tar.gz')
    const pushed = join(dir, 'pushed.txt')
    mkdirSync(bin)
    mkdirSync(logs)
    writeFileSync(archive, '')
    truncateSync(archive, 3 * 1024 ** 3)
    writeFileSync(join(logs, 'image-paths-amd64.txt'), `${archive}\n`)
    writeFileSync(
      join(bin, 'attic'),
      '#!/usr/bin/env bash\nif [[ "$1" == login ]]; then exit 0; fi\nprintf "%s\\n" "$@" > "$ATTIC_TEST_PUSHED"\nexit "$ATTIC_TEST_STATUS"\n',
      { mode: 0o755 },
    )
    const result = Bun.spawnSync(['bash', '-c', warmScript], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...workflowEnv,
        PATH: `${bin}:${process.env.PATH}`,
        ARCH: 'amd64',
        ATTIC_TOKEN: 'test-token',
        ATTIC_TEST_PUSHED: pushed,
        ATTIC_TEST_STATUS: String(uploadStatus),
        NIX_OCI_LOG_DIR: logs,
      },
      timeout: 10_000,
    })
    expect(result.exitCode).toBe(0)
    expect(readFileSync(join(logs, 'image-cache-push-status-amd64.txt'), 'utf8')).toBe(
      uploadStatus === 0 ? 'succeeded\t0\n' : `failed\t${uploadStatus}\n`,
    )
    expect(readFileSync(pushed, 'utf8').split('\n')).toEqual([
      'push',
      '--jobs',
      '1',
      '--no-closure',
      'lab-ci:lab',
      archive,
      '',
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
