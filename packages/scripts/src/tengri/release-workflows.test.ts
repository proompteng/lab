import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import YAML from 'yaml'

const repositoryRoot = resolve(import.meta.dir, '../../../..')
const imagesPath = resolve(repositoryRoot, '.github/workflows/tengri-images.yml')
const nanoagentDockerfilePath = resolve(repositoryRoot, 'services/nanoagent/Dockerfile')
const tengriDockerfilePath = resolve(repositoryRoot, 'services/tengri/Dockerfile')

describe('Tengri image workflow', () => {
  it('validates Nanoagent once without losing protobuf or guest checks', () => {
    const validation = readFileSync(imagesPath, 'utf8').match(/validate-nanoagent:\n[\s\S]*?\n  build:/)?.[0]

    expect(existsSync(resolve(repositoryRoot, '.github/workflows/nanoagent.yaml'))).toBe(false)
    expect(validation).toContain('buf lint ../tengri/proto')
    expect(validation).toContain('buf format ../tengri/proto')
    expect(validation).toContain('bash generate-proto.sh')
    expect(validation).toContain('git diff --exit-code -- internal/guestpb')
    expect(validation).toContain('bash validate-rootfs.test.sh')
    expect(validation).toContain('bash bootstrap-codex.sh --validate-manifest')
    expect(validation).toContain('GOWORK=off go test -race ./...')
    expect(validation).toContain('GOWORK=off go vet ./...')
  })

  it('uses three release cycles and reserves fifty cycles for explicit benchmarking', () => {
    const workflow = YAML.parse(readFileSync(imagesPath, 'utf8')) as {
      on: { workflow_dispatch: { inputs: { kvm_samples: { options: string[]; default: string } } } }
      jobs: {
        'validate-kvm': { steps: Array<{ name?: string; env?: Record<string, string> }> }
        publish: { needs: string[] }
      }
    }
    const input = workflow.on.workflow_dispatch.inputs.kvm_samples
    expect(input.options).toEqual(['3', '50'])
    expect(input.default).toBe('3')
    const test = workflow.jobs['validate-kvm'].steps.find(
      (step) => step.name === 'Verify real guest administration and snapshot lifecycle',
    )
    expect(test?.env?.TENGRI_KVM_SAMPLES).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.kvm_samples || '3' }}",
    )
    expect(workflow.jobs.publish.needs).toContain('validate-kvm')
  })

  it('exports registry caches only on main and reuses the native harness cache', () => {
    const workflow = YAML.parse(readFileSync(imagesPath, 'utf8')) as {
      jobs: Record<
        string,
        { steps: Array<{ name?: string; with?: Record<string, unknown>; 'continue-on-error'?: boolean }> }
      >
    }
    const runtime = workflow.jobs.build?.steps.find((step) => step.name === 'Build native image')
    expect(runtime?.with?.['cache-to']).toContain("github.event_name != 'pull_request'")
    expect(runtime?.with?.['cache-to']).toContain('mode=max')
    expect(runtime?.with?.['cache-to']).toContain('ignore-error=true')
    expect(runtime?.['continue-on-error']).not.toBe(true)
    const harness = workflow.jobs['validate-kvm']?.steps.find((step) => step.name === 'Build native KVM test harness')
    expect(harness?.with?.['cache-from']).toContain(':cache-kvm-')
    expect(harness?.with?.['cache-to']).toContain(':cache-kvm-')
    expect(harness?.with?.['cache-to']).toContain('ignore-error=true')
    expect(harness?.['continue-on-error']).not.toBe(true)
    expect(harness?.with?.load).toBe(true)
    expect(harness?.with?.push).not.toBe(true)
  })

  it('reuses the runtime release compilation for the native fixture without shipping test binaries', () => {
    const workflow = YAML.parse(readFileSync(imagesPath, 'utf8')) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string; with?: Record<string, unknown> }> }>
    }
    const dockerfile = readFileSync(tengriDockerfilePath, 'utf8')
    const runtime = dockerfile.split(' AS runtime\n')[1]?.split('\nFROM runtime AS kvm-test')[0]
    const fixture = dockerfile.split('\nFROM runtime AS kvm-test\n')[1]?.split('\nFROM runtime AS release')[0]
    expect(dockerfile).toContain('cargo test --locked --release --all-targets')
    expect(dockerfile).toContain('/out-kvm-test --list --ignored | grep -Fx')
    expect(runtime).toContain('COPY --from=build /out-tengri /usr/local/bin/tengri')
    expect(runtime).not.toContain('/out-kvm-test')
    expect(fixture).toContain('COPY --from=build /out-kvm-test /fixture/kvm-test')
    expect(fixture).not.toContain('cargo ')
    expect(existsSync(resolve(repositoryRoot, 'services/tengri/Dockerfile.kvm-test'))).toBe(false)
    const harness = workflow.jobs['validate-kvm'].steps.find((step) => step.name === 'Build native KVM test harness')
    expect(harness?.with?.file).toBe('services/tengri/Dockerfile')
    expect(harness?.with?.target).toBe('kvm-test')
    expect(harness?.with?.['cache-from']).toContain(
      'type=registry,ref=${{ env.TENGRI_IMAGE }}:cache-${{ matrix.architecture }}',
    )
    const prFixture = workflow.jobs.build.steps.find((step) => step.name === 'Build isolated KVM test image')
    expect(prFixture?.run).toContain('docker buildx build --load')
    expect(prFixture?.run).toContain('--cache-from "type=registry,ref=${NANOAGENT_IMAGE}:cache-amd64"')
    expect(prFixture?.run).toContain('--cache-from "type=registry,ref=${TENGRI_IMAGE}:cache-amd64"')
    expect(prFixture?.run).toContain('--cache-from "type=registry,ref=${TENGRI_IMAGE}:cache-kvm-amd64"')
    expect(prFixture?.run).not.toContain('--builder default')
  })

  it.each(['0', '1', '2', 'invalid'])(
    'rejects insufficient lifecycle samples %s before touching devices',
    (samples) => {
      const fixture = mkdtempSync(resolve(tmpdir(), 'tengri-kvm-samples-'))
      const calls = resolve(fixture, 'calls')
      try {
        writeFileSync(resolve(fixture, 'ip'), '#!/bin/sh\nprintf called > "$CALLS"\nexit 42\n', { mode: 0o755 })
        const result = Bun.spawnSync(['bash', resolve(repositoryRoot, 'services/tengri/test-kvm.sh')], {
          env: {
            ...process.env,
            PATH: `${fixture}:${process.env.PATH}`,
            CALLS: calls,
            TENGRI_KVM_TEST_IMAGE: 'private-fixture',
            TENGRI_KVM_GUEST_IMAGE: 'private-guest',
            TENGRI_KVM_OUTPUT: fixture,
            TENGRI_KVM_SAMPLES: samples,
          },
        })
        expect(result.exitCode).not.toBe(0)
        expect(existsSync(calls)).toBe(false)
      } finally {
        rmSync(fixture, { recursive: true, force: true })
      }
    },
  )

  it.each(['missing', 'empty', 'present'])(
    'requires a retained lifecycle receipt when the fixture exits successfully: %s',
    (receipt) => {
      const fixture = mkdtempSync(resolve(tmpdir(), 'tengri-kvm-receipt-'))
      try {
        writeFileSync(resolve(fixture, 'ip'), '#!/bin/sh\nprintf "1.1.1.1 dev fixture0\\n"\n', { mode: 0o755 })
        writeFileSync(resolve(fixture, 'cat'), '#!/bin/sh\nprintf "1500\\n"\n', { mode: 0o755 })
        writeFileSync(
          resolve(fixture, 'docker'),
          `#!/bin/sh
if [ "$1" = cp ]; then
  case "$2" in *:/work/result.json)
  case "$RECEIPT" in
    empty) : > "$3" ;;
    present) printf '{"resumeSamples":3}\\n' > "$3" ;;
  esac
  ;; esac
fi
exit 0
`,
          { mode: 0o755 },
        )
        const result = Bun.spawnSync(['bash', resolve(repositoryRoot, 'services/tengri/test-kvm.sh')], {
          env: {
            ...process.env,
            PATH: `${fixture}:${process.env.PATH}`,
            RECEIPT: receipt,
            TENGRI_KVM_TEST_IMAGE: 'private-fixture',
            TENGRI_KVM_GUEST_IMAGE: 'private-guest',
            TENGRI_KVM_OUTPUT: fixture,
            TENGRI_KVM_SAMPLES: '3',
          },
        })
        expect(result.exitCode === 0).toBe(receipt === 'present')
      } finally {
        rmSync(fixture, { recursive: true, force: true })
      }
    },
  )

  it.each([false, true])('requires the exact native test before configuring the fixture: %s', (present) => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'tengri-kvm-test-list-'))
    const calls = resolve(fixture, 'calls')
    const testName =
      'slot::kvm_test::real_guest_restores_files_codex_and_the_same_shell_without_resident_snapshot_pages'
    try {
      const entry = readFileSync(resolve(repositoryRoot, 'services/tengri/test-kvm-entry.sh'), 'utf8')
        .replaceAll('/fixture/kvm-test', resolve(fixture, 'kvm-test'))
        .replaceAll('/usr/local/bin/tengri-network', resolve(fixture, 'network'))
      writeFileSync(resolve(fixture, 'entry'), entry)
      writeFileSync(resolve(fixture, 'kvm-test'), '#!/bin/sh\nprintf "%s\\n" "$TEST_LIST"\n', { mode: 0o755 })
      writeFileSync(resolve(fixture, 'stat'), '#!/bin/sh\nprintf "65532\\n"\n', { mode: 0o755 })
      for (const command of ['ip', 'network', 'chmod', 'setpriv']) {
        writeFileSync(resolve(fixture, command), `#!/bin/sh\nprintf '${command}\\n' >> "$CALLS"\n`, {
          mode: 0o755,
        })
      }
      const result = Bun.spawnSync(['sh', resolve(fixture, 'entry')], {
        env: {
          ...process.env,
          PATH: `${fixture}:${process.env.PATH}`,
          CALLS: calls,
          TEST_LIST: present ? `${testName}: test` : '',
          TENGRI_KVM_NETWORK_MTU: '1500',
        },
      })
      expect(result.exitCode === 0).toBe(present)
      expect(existsSync(calls)).toBe(present)
      if (present) expect(readFileSync(calls, 'utf8')).toContain('setpriv')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('publishes signed multi-architecture images for Kargo discovery', () => {
    const source = readFileSync(imagesPath, 'utf8')
    const workflow = YAML.parse(source) as {
      jobs?: {
        publish?: { needs?: string[]; steps?: Array<{ name?: string; run?: string }> }
      }
    }

    expect(YAML.parse(source).name).toBe('Tengri images')
    expect(source).not.toContain('tengri-release.yml')
    expect(source).toContain('service: tengri')
    expect(source).toContain('service: nanoagent')
    expect(source).toContain('architecture: amd64')
    expect(source).toContain('architecture: arm64')
    expect(source).toContain('cosign sign --yes')
    expect(source).toContain("--format '{{json .Manifest}}'")
    expect(source).toContain("jq -er '.digest'")
    expect(source).toContain('org.opencontainers.image.created=${SOURCE_TIMESTAMP}')
    expect(source).toContain('org.opencontainers.image.revision=${SOURCE_SHA}')
    expect(source).toContain('crane mutate --platform "linux/${architecture}"')
    expect(source).toContain('crane config --platform "linux/${architecture}"')
    expect(source).toContain('--annotation "index:org.opencontainers.image.source=${SOURCE_URL}"')
    expect(source).toContain('--annotation "index:org.opencontainers.image.revision=${SOURCE_SHA}"')
    expect(source).toContain('.annotations["org.opencontainers.image.source"] == $source_url')
    expect(source).toContain('.annotations["org.opencontainers.image.revision"] == $source_sha')
    expect(source).toContain('kargo-sha-${SOURCE_SHA}')
    expect(source.match(/crane digest "\$\{kargo_reference\}"/g)).toHaveLength(2)
    expect(source).not.toMatch(
      /docker buildx imagetools inspect[\s\\]+--format '\{\{json \.Manifest\}\}'[\s\\]+"\$\{kargo_reference\}"/,
    )
    expect(source).toContain("if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'")
    expect(source).not.toContain(':latest')
    expect(source).not.toContain('latest_digest')
    expect(source).not.toContain('sha256sum "${index_path}"')
    expect(source).not.toContain('release-contract.json')
    expect(workflow.jobs?.publish?.needs).toEqual(['build', 'validate-tengri', 'validate-nanoagent', 'validate-kvm'])
    expect(existsSync(resolve(repositoryRoot, 'argocd/applications/kargo'))).toBe(true)
  })

  it('gates the publisher on full controller and guest validation', () => {
    const images = YAML.parse(readFileSync(imagesPath, 'utf8')) as {
      jobs?: {
        'validate-tengri'?: { steps?: Array<{ run?: string }> }
        'validate-nanoagent'?: { steps?: Array<{ run?: string }> }
        publish?: { needs?: string[] }
      }
    }
    const controllerValidation = images.jobs?.['validate-tengri']?.steps?.map((step) => step.run ?? '').join('\n')
    const guestValidation = images.jobs?.['validate-nanoagent']?.steps?.map((step) => step.run ?? '').join('\n')

    expect(controllerValidation).toContain('cargo fmt --check')
    expect(controllerValidation).toContain('cargo clippy --locked --all-targets -- -D warnings')
    expect(controllerValidation).toContain('cargo test --locked --all-targets')
    expect(controllerValidation).toContain('diff -u /tmp/tengri-crd.yaml ../../argocd/applications/tengri/crd.yaml')
    expect(guestValidation).toContain('GOWORK=off go test -race ./...')
    expect(guestValidation).toContain('GOWORK=off go vet ./...')
    expect(guestValidation).toContain('bash validate-rootfs.test.sh')
    expect(images.jobs?.publish?.needs).toContain('validate-tengri')
    expect(images.jobs?.publish?.needs).toContain('validate-nanoagent')
    expect(images.jobs?.publish?.needs).toContain('validate-kvm')
  })

  it('withholds Kargo aliases until both images and their retained indexes succeed', () => {
    const images = YAML.parse(readFileSync(imagesPath, 'utf8')) as {
      jobs: {
        publish: {
          steps: Array<{
            id?: string
            name?: string
            uses?: string
            run?: string
            with?: { path?: string; 'include-hidden-files'?: boolean }
          }>
        }
      }
    }
    const steps = images.jobs.publish.steps
    const prepared = steps.findIndex((step) => step.id === 'images')
    const retained = steps.findIndex((step) => step.uses === 'actions/upload-artifact@v4')
    const exposed = steps.findIndex((step) => step.name === 'Expose both verified images to Kargo')
    expect(prepared).toBeGreaterThanOrEqual(0)
    expect(retained).toBeGreaterThan(prepared)
    expect(exposed).toBeGreaterThan(retained)
    expect(steps[retained]?.with?.path).toBe('.artifacts/tengri/*-index.json')
    expect(steps[retained]?.with?.['include-hidden-files']).toBe(true)
    expect(steps[prepared]?.run).toContain('nanoagent_digest="$(publish_image "${NANOAGENT_IMAGE}")"')
    expect(steps[prepared]?.run).not.toContain('kargo-sha-')
    expect(steps[exposed]?.run).toContain('publish_kargo_alias "${TENGRI_IMAGE}" "${TENGRI_DIGEST}"')
    expect(steps[exposed]?.run).toContain('publish_kargo_alias "${NANOAGENT_IMAGE}" "${NANOAGENT_DIGEST}"')
  })

  it('holds automatic discovery until prepared-slot cutover is explicitly ready', () => {
    const images = YAML.parse(readFileSync(imagesPath, 'utf8')) as {
      jobs: { publish: { steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> } }
    }
    const exposed = images.jobs.publish.steps.find((step) => step.name === 'Expose both verified images to Kargo')
    if (!exposed?.run) throw new Error('Kargo exposure step is missing')
    const fixture = mkdtempSync(resolve(tmpdir(), 'tengri-cutover-hold-'))
    const calls = resolve(fixture, 'calls')
    const summary = resolve(fixture, 'summary')
    try {
      for (const command of ['crane', 'docker']) {
        writeFileSync(resolve(fixture, command), '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$CALLS"\nexit 42\n', {
          mode: 0o755,
        })
      }
      for (const ready of ['', 'false', 'TRUE', 'true']) {
        const result = Bun.spawnSync(['bash', '-c', exposed.run], {
          cwd: fixture,
          env: {
            ...process.env,
            PATH: `${fixture}:${process.env.PATH}`,
            CALLS: calls,
            GITHUB_STEP_SUMMARY: summary,
            TENGRI_PREPARED_SLOT_CUTOVER_READY: ready,
            SOURCE_SHA: '1'.repeat(40),
            GITHUB_SHA: '1'.repeat(40),
            TENGRI_DIGEST: `sha256:${'2'.repeat(64)}`,
            NANOAGENT_DIGEST: `sha256:${'3'.repeat(64)}`,
            TENGRI_IMAGE: 'registry.example.test/tengri',
            NANOAGENT_IMAGE: 'registry.example.test/nanoagent',
          },
        })
        if (ready === 'true') {
          expect(result.exitCode).not.toBe(0)
          expect(readFileSync(calls, 'utf8')).toContain('crane digest registry.example.test/tengri:kargo-sha-')
        } else {
          expect(result.exitCode).toBe(0)
          expect(existsSync(calls)).toBe(false)
          expect(readFileSync(summary, 'utf8')).toContain('publication held')
        }
      }
      expect(exposed.env?.TENGRI_PREPARED_SLOT_CUTOVER_READY).toBe(
        "${{ vars.TENGRI_PREPARED_SLOT_CUTOVER_READY || 'false' }}",
      )
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('propagates an image preparation failure out of command substitution', () => {
    const images = YAML.parse(readFileSync(imagesPath, 'utf8')) as {
      jobs: { publish: { steps: Array<{ id?: string; run?: string }> } }
    }
    const run = images.jobs.publish.steps.find((step) => step.id === 'images')?.run ?? ''
    const start = run.indexOf('publish_image() {')
    const end = run.indexOf('\ntengri_digest=', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const fixture = mkdtempSync(resolve(tmpdir(), 'tengri-publish-failure-'))
    try {
      mkdirSync(resolve(fixture, '.artifacts/tengri'), { recursive: true })
      for (const command of ['crane', 'docker', 'cosign', 'jq']) {
        writeFileSync(
          resolve(fixture, command),
          command === 'crane' ? '#!/bin/sh\nexit 42\n' : '#!/bin/sh\nprintf "sha256:%064d\\n" 0\n',
          { mode: 0o755 },
        )
      }
      const result = Bun.spawnSync(
        [
          'bash',
          '-c',
          `set -euo pipefail\n${run.slice(start, end)}\nresult="$(publish_image registry.example.test/tengri)"\nprintf '%s' "$result"`,
        ],
        {
          cwd: fixture,
          env: {
            ...process.env,
            PATH: `${fixture}:${process.env.PATH}`,
            SOURCE_SHA: '0'.repeat(40),
            SOURCE_TIMESTAMP: '2026-09-08T00:00:00Z',
            SOURCE_URL: 'https://github.com/proompteng/lab',
            SIGNING_IDENTITY: 'https://github.com/proompteng/lab/test',
            tag: 'sha-test',
          },
        },
      )
      expect(result.exitCode).toBe(42)
      expect(result.stdout.toString()).toBe('')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('validates the controller once without losing Rust, authorization, interoperability, or CRD checks', () => {
    const validation = readFileSync(imagesPath, 'utf8').match(/validate-tengri:\n[\s\S]*?\n  validate-nanoagent:/)?.[0]

    expect(existsSync(resolve(repositoryRoot, '.github/workflows/tengri-controller.yaml'))).toBe(false)
    expect(validation).toContain('cargo fmt --check')
    expect(validation).toContain('cargo clippy --locked --all-targets -- -D warnings')
    expect(validation).toContain('cargo test --locked --all-targets')
    expect(validation).toContain('bash test-authz.sh')
    expect(validation).toContain('bash test-rpc-interop.sh')
    expect(validation).toContain('cargo run --locked --quiet --bin crdgen')
    expect(validation).toContain('diff -u /tmp/tengri-crd.yaml crd.yaml')
    expect(validation).toContain('diff -u /tmp/tengri-crd.yaml ../../argocd/applications/tengri/crd.yaml')
  })

  it.each(['save', 'config', 'portable'])('verifies the saved configuration for fixture %s', (scenario) => {
    const workflow = YAML.parse(readFileSync(imagesPath, 'utf8')) as {
      jobs: { build: { steps: Array<{ name?: string; if?: string; run?: string }> } }
    }
    const steps = workflow.jobs.build.steps
    const exported = steps.find((step) => step.name === 'Export native KVM fixture image')
    const retained = steps.find((step) => step.name === 'Retain native KVM fixture image')
    expect(exported?.if).toBe("${{ github.event_name == 'pull_request' && matrix.architecture == 'amd64' }}")
    expect(retained?.if).toBe(exported?.if)
    expect(exported?.run).not.toMatch(/--device|--cap-add|bash services\/tengri\/test-kvm.sh/)

    const fixture = mkdtempSync(resolve(tmpdir(), 'tengri-fixture-export-failure-'))
    try {
      const image = `registry.example.test/nanoagent:sha-${'1'.repeat(40)}-amd64`
      const config = JSON.stringify({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [] } })
      const digest = createHash('sha256').update(config).digest('hex')
      const configPath = `blobs/sha256/${digest}`
      mkdirSync(resolve(fixture, 'blobs/sha256'), { recursive: true })
      writeFileSync(
        resolve(fixture, 'manifest.json'),
        JSON.stringify([{ Config: configPath, RepoTags: [image], Layers: [] }]),
      )
      const archive = resolve(fixture, 'image.tar')
      const archiveFiles = ['manifest.json']
      if (scenario !== 'config') {
        writeFileSync(resolve(fixture, configPath), config)
        archiveFiles.push(configPath)
      }
      const saved = Bun.spawnSync(['tar', '-cf', archive, '-C', fixture, ...archiveFiles])
      expect(saved.exitCode).toBe(0)
      writeFileSync(
        resolve(fixture, 'docker'),
        '#!/bin/sh\nif [ "$1" = save ]; then cat "$FIXTURE_ARCHIVE"; exit "$SAVE_EXIT"; fi\nprintf "sha256:%s\\n" "$MANIFEST_DIGEST"\n',
        { mode: 0o755 },
      )
      const result = Bun.spawnSync(['bash', '-c', exported?.run ?? ''], {
        cwd: fixture,
        env: {
          ...process.env,
          PATH: `${fixture}:${process.env.PATH}`,
          SERVICE: 'nanoagent',
          IMAGE_REPOSITORY: 'registry.example.test/nanoagent',
          GITHUB_SHA: '1'.repeat(40),
          PR_HEAD_REVISION: '2'.repeat(40),
          FIXTURE_ARCHIVE: archive,
          SAVE_EXIT: scenario === 'save' ? '42' : '0',
          MANIFEST_DIGEST: 'f'.repeat(64),
        },
      })
      const receiptPath = resolve(fixture, '.artifacts/kvm-fixture/nanoagent.json')
      const checksumsPath = resolve(fixture, '.artifacts/kvm-fixture/nanoagent-SHA256SUMS')
      if (scenario === 'portable') {
        expect(result.exitCode).toBe(0)
        const receipt: unknown = JSON.parse(readFileSync(receiptPath, 'utf8'))
        expect(receipt).toEqual({
          sourceRevision: '1'.repeat(40),
          prHeadRevision: '2'.repeat(40),
          image,
          configDigest: `sha256:${digest}`,
        })
        expect(existsSync(checksumsPath)).toBe(true)
      } else {
        if (scenario === 'save') expect(result.exitCode).toBe(42)
        else expect(result.exitCode).not.toBe(0)
        expect(existsSync(receiptPath)).toBe(false)
        expect(existsSync(checksumsPath)).toBe(false)
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('uses the repository mirror instead of anonymous Docker Hub base pulls', () => {
    const nanoagent = readFileSync(nanoagentDockerfilePath, 'utf8')
    const tengri = readFileSync(tengriDockerfilePath, 'utf8')

    for (const dockerfile of [nanoagent, tengri]) {
      expect(dockerfile).toStartWith('# syntax=mirror.gcr.io/docker/dockerfile:1.7')
      expect(dockerfile).not.toContain('docker.io/')
    }
    expect(nanoagent).toContain('ARG GO_BASE_IMAGE=mirror.gcr.io/golang')
    expect(nanoagent).toContain('FROM ${GO_BASE_IMAGE}:${GO_VERSION}-bookworm AS go-runtime')
    expect(nanoagent).toContain('COPY --from=go-runtime /usr/local/go /bundle/go')
    expect(nanoagent).not.toContain('COPY --from=build /usr/local/go /bundle/go')
    expect(nanoagent).toContain('ARG BUN_BASE_IMAGE=mirror.gcr.io/oven/bun')
    expect(nanoagent).toContain('ARG NODE_BASE_IMAGE=mirror.gcr.io/node')
    expect(nanoagent).toContain('ARG UBUNTU_BASE_IMAGE=mirror.gcr.io/ubuntu')
    expect(nanoagent).toContain('ln -s /home/nanoagent/workspace /workspace')
    expect(nanoagent).toContain('bootstrap-toolchain --install-only')
    expect(nanoagent).toContain(
      'COPY --from=toolchain-smoke /tmp/toolchain-version /usr/share/nanoagent/toolchain-version',
    )
    expect(nanoagent).toContain('TOOLCHAIN_BOOTSTRAP_COMMAND=/usr/local/bin/bootstrap-toolchain')
    expect(nanoagent).toContain('BUN_INSTALL=/home/nanoagent/.local')
    expect(nanoagent).toContain('NPM_CONFIG_PREFIX=/home/nanoagent/.local')
    expect(nanoagent).toContain('test "$(npm config get prefix)" = "$HOME/.local"')
    expect(nanoagent).toContain('test "$(bun pm bin --global)" = "$HOME/.local/bin"')
    expect(nanoagent).toContain('cargo new --quiet --lib /tmp/cargo-library-smoke')
    expect(nanoagent).toContain('(cd /tmp/cargo-library-smoke && cargo test --quiet)')
    expect(nanoagent).not.toContain('/bundle/rust/bin/rustdoc;')
    expect(nanoagent).toContain('COPY --from=boot-artifacts /guest /guest')
    expect(nanoagent).toContain('build-boot-artifacts "$TARGETARCH"')
    expect(tengri).toContain('ARG DEBIAN_BASE_IMAGE=mirror.gcr.io/debian')
    expect(tengri).toContain('ARG RUST_BASE_IMAGE=mirror.gcr.io/rust')
  })

  it('removes the retired release-PR workflow', () => {
    expect(existsSync(resolve(repositoryRoot, '.github/workflows/tengri-release.yml'))).toBe(false)
  })
})
