import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
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
const buildStep = steps.items.find((step) => isMap(step) && step.get('name') === 'Build Nix image archive')
const buildScript = isMap(buildStep) ? buildStep.get('run') : undefined
const setupStep = steps.items.find((step) => isMap(step) && step.get('name') === 'Set up Nix toolchain')
const nixConfig = isMap(setupStep) ? setupStep.getIn(['with', 'extra-nix-config']) : undefined
if (typeof buildScript !== 'string' || typeof nixConfig !== 'string') throw new Error('Missing Nix image build')

it.each([
  { mode: 'cache-error', status: 1 },
  { mode: 'compile-error', status: 23 },
  { mode: 'stall', status: 124 },
  { mode: 'success', status: 0 },
])('runs one bounded image build for $mode without a source fallback', ({ mode, status }) => {
  const dir = mkdtempSync(join(tmpdir(), 'nix-image-build-'))
  try {
    const bin = join(dir, 'bin')
    const logs = join(dir, 'logs')
    const archive = join(dir, 'image.tar.gz')
    const calls = join(dir, 'calls')
    const compiler = join(dir, 'compiler-started')
    const output = join(dir, 'github-output')
    mkdirSync(bin)
    mkdirSync(logs)
    mkdirSync(join(dir, 'nix'))
    writeFileSync(join(dir, 'nix/ci-run-timed.sh'), readFileSync(join(repoRoot, 'nix/ci-run-timed.sh')))
    writeFileSync(archive, 'image archive')
    writeFileSync(output, '')
    writeFileSync(
      join(bin, 'nix'),
      `#!/usr/bin/env bash
set -euo pipefail
printf 'build\\n' >> "$NIX_TEST_CALLS"
fallback="$(printf '%s\\n' "$NIX_CONFIG" | awk '$1 == "fallback" { print $3 }')"
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --option)
      if [[ "$2" == fallback ]]; then fallback="$3"; fi
      shift 3 ;;
    --out-link) out_link="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "$NIX_TEST_MODE" in
  cache-error)
    if [[ "$fallback" != true ]]; then
      echo 'error: unable to download cached NAR: HTTP 503' >&2
      exit 1
    fi
    printf 'compiler bootstrap\\n' > "$NIX_TEST_COMPILER" ;;
  compile-error) exit 23 ;;
  stall) sleep 10 ;;
esac
ln -s "$NIX_TEST_ARCHIVE" "$out_link"
`,
      { mode: 0o755 },
    )
    const result = Bun.spawnSync(['bash', '-c', buildScript.replaceAll('${{ matrix.platform }}', 'linux/amd64')], {
      cwd: dir,
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(workflowEnv).map(([key, value]) => [key, key.startsWith('NIX_IMAGE_BUILD_') ? '1s' : value]),
        ),
        PATH: `${bin}:${process.env.PATH}`,
        NIX_CONFIG: nixConfig,
        PACKAGE_ATTR: 'fixture-image',
        ARCH: 'amd64',
        NIX_OCI_LOG_DIR: logs,
        NIX_TEST_MODE: mode,
        NIX_TEST_CALLS: calls,
        NIX_TEST_COMPILER: compiler,
        NIX_TEST_ARCHIVE: archive,
        GITHUB_OUTPUT: output,
      },
      timeout: 10_000,
    })
    expect(result.exitCode).toBe(status)
    expect(existsSync(compiler)).toBe(false)
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1)
    expect(readFileSync(output, 'utf8')).toBe(status === 0 ? `image_tar=${realpathSync(archive)}\n` : '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each([0, 17, 'stall'])('bounds a multi-GiB archive upload and records Attic result %s', (uploadStatus) => {
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
      '#!/usr/bin/env bash\nif [[ "$1" == login ]]; then exit 0; fi\nprintf "%s\\n" "$@" > "$ATTIC_TEST_PUSHED"\nif [[ "$ATTIC_TEST_STATUS" == stall ]]; then sleep 10; fi\nexit "$ATTIC_TEST_STATUS"\n',
      { mode: 0o755 },
    )
    const result = Bun.spawnSync(['bash', '-c', warmScript], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...workflowEnv,
        NIX_IMAGE_CACHE_WARM_TIMEOUT: uploadStatus === 'stall' ? '1s' : workflowEnv.NIX_IMAGE_CACHE_WARM_TIMEOUT,
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
      uploadStatus === 0 ? 'succeeded\t0\n' : `failed\t${uploadStatus === 'stall' ? 124 : uploadStatus}\n`,
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
