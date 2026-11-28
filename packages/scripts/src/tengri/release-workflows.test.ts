import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

import YAML from 'yaml'

const repositoryRoot = resolve(import.meta.dir, '../../../..')
const imagesPath = resolve(repositoryRoot, '.github/workflows/tengri-images.yml')
const validationPath = resolve(repositoryRoot, '.github/workflows/tengri-validation.yml')
const nanoagentDockerfilePath = resolve(repositoryRoot, 'services/nanoagent/Dockerfile')
const tengriDockerfilePath = resolve(repositoryRoot, 'services/tengri/Dockerfile')

describe('Tengri image workflow', () => {
  it('validates Nanoagent once without losing protobuf or guest checks', () => {
    const validation = readFileSync(validationPath, 'utf8').split('\n  validate-nanoagent:\n')[1]

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

  it('builds the two native images independently and verifies the pushed guest artifacts', () => {
    const workflow = YAML.parse(readFileSync(imagesPath, 'utf8')) as {
      on: Record<string, unknown>
      jobs: Record<
        string,
        {
          if?: string
          needs?: string
          uses?: string
          'runs-on'?: string
          strategy?: { matrix: { architecture: string[]; image: string[]; include: unknown[] } }
          steps: Array<{
            name?: string
            if?: string
            uses?: string
            run?: string
            with?: Record<string, unknown>
            'continue-on-error'?: boolean
          }>
        }
      >
    }
    const mainPublication =
      "(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main'"
    expect(workflow.on).not.toHaveProperty('merge_group')
    expect(workflow.jobs.build?.needs).toBe('changes')
    expect(workflow.jobs.publish?.if).toBe(mainPublication)
    expect(workflow.jobs.build?.['runs-on']).toBe('${{ matrix.runner }}')
    expect(workflow.jobs.publish?.['runs-on']).toBe('arc-amd64')
    expect(workflow.jobs.build?.strategy?.matrix).toEqual({
      architecture: ['amd64', 'arm64'],
      image: ['nanoagent', 'tengri'],
      include: [
        { architecture: 'amd64', runner: 'ubuntu-24.04' },
        { architecture: 'arm64', runner: 'ubuntu-24.04-arm' },
        {
          image: 'tengri',
          build_contexts: 'ofz-proto=proto\nofz-catalog=services/ofz\nnanoagent-src=services/nanoagent\n',
        },
      ],
    })
    expect(workflow.jobs['validate-kvm']).toBeUndefined()
    expect(workflow.jobs.validate?.needs).toBe('changes')
    for (const [event_name, ref, action, baseChanged, result, changed, validate, build] of [
      ['pull_request', 'refs/pull/42/merge', 'synchronize', false, 'skipped', '', true, false],
      ['pull_request', 'refs/pull/42/merge', 'edited', false, 'skipped', '', false, false],
      ['pull_request', 'refs/pull/42/merge', 'edited', true, 'skipped', '', true, false],
      ['push', 'refs/heads/main', '', false, 'success', 'false', false, false],
      ['push', 'refs/heads/main', '', false, 'success', 'true', true, true],
      ['workflow_dispatch', 'refs/heads/main', '', false, 'success', 'true', true, true],
      ['workflow_dispatch', 'refs/heads/topic', '', false, 'success', 'true', true, false],
    ] as const) {
      const context = {
        github: { event_name, ref, event: { action, changes: { base: baseChanged } } },
        needs: { changes: { result, outputs: { changed } } },
        cancelled: () => false,
      }
      expect(runInNewContext(workflow.jobs.validate.if ?? '', context)).toBe(validate)
      expect(runInNewContext(workflow.jobs.build.if ?? '', context)).toBe(build)
    }
    expect(workflow.jobs.validate?.uses).toBe('./.github/workflows/tengri-validation.yml')
    const steps = workflow.jobs.build.steps
    const publisher = workflow.jobs.publish.steps
    expect(steps.filter((step) => step.uses === './.github/actions/setup-buildkit')).toHaveLength(1)
    const build = steps.find((step) => step.uses === 'docker/build-push-action@v6')
    const upload = steps.find((step) => step.uses === 'actions/upload-artifact@v4')
    const importImages = publisher.find((step) => step.name === 'Import native images into the private registry')
    const pairedBoot = publisher.find((step) => step.name === 'Verify paired boot artifact checksums')
    const sign = publisher.find((step) => step.name === 'Publish, verify, and sign multi-architecture images')
    if (!build || !upload || !importImages || !pairedBoot || !sign) {
      throw new Error('Native image handoff or publication step is missing')
    }
    expect(build.with?.context).toBe('services/${{ matrix.image }}')
    expect(build.with?.outputs).toBe(
      'type=oci,dest=${{ runner.temp }}/${{ matrix.image }}-${{ matrix.architecture }}.tar',
    )
    expect(build.with?.push).toBeUndefined()
    expect(build.with?.['cache-to']).toBeUndefined()
    expect(build.with?.sbom).toBe(true)
    expect(build.with?.provenance).toBe('mode=max')
    expect(build.with?.['build-contexts']).toBe('${{ matrix.build_contexts }}')
    expect(build.with?.['build-args']).toContain(
      "matrix.image == 'tengri' && format('SOURCE_REVISION={0}', github.sha)",
    )
    expect(build['continue-on-error']).not.toBe(true)
    expect(upload.with?.['if-no-files-found']).toBe('error')
    expect(upload.with?.['compression-level']).toBe(0)
    expect(publisher.indexOf(pairedBoot)).toBeGreaterThan(publisher.indexOf(importImages))
    expect(publisher.indexOf(sign)).toBeGreaterThan(publisher.indexOf(pairedBoot))
    expect(pairedBoot.run).toContain('crane export --platform "linux/$architecture" "$guest" - | tar -xf -')
    expect(pairedBoot.run).toContain('sha256sum --check SHA256SUMS')
    expect(steps.some((step) => step.name === 'Build native KVM test harness')).toBe(false)

    const ofz = YAML.parse(readFileSync(resolve(repositoryRoot, '.github/workflows/ofz.yaml'), 'utf8'))
    expect(ofz.on).toHaveProperty('workflow_call')
    expect(ofz.on).not.toHaveProperty('merge_group')
    expect(ofz.jobs['build-ofz'].needs).toBe('validate')
    expect(ofz.jobs.validate.needs).toBe('changes')
    const ofzChecks = ofz.jobs.validate.steps.map((step: { run?: string }) => step.run ?? '').join('\n')
    expect(ofzChecks).not.toMatch(/bash services\/ofz\/test-control\.sh control\b/)
    expect(ofzChecks.match(/bash services\/tengri\/test-database-failover\.sh\b/g)).toHaveLength(1)
    const promotion = readFileSync(resolve(repositoryRoot, 'services/tengri/test-database-failover.sh'), 'utf8')
    expect(promotion).toContain('ofz/test-control.sh" failover')
    const control = readFileSync(resolve(repositoryRoot, 'services/ofz/test-control.sh'), 'utf8')
    expect(control).toMatch(
      /if \[\[ "\$fixture_mode" == failover \]\]; then\s+cargo test --locked --lib control_integration/,
    )
    expect(control).toContain(
      'runtime_state_test::physical_database_promotion_preserves_authority_and_consumed_capabilities',
    )
    const products = YAML.parse(
      readFileSync(resolve(repositoryRoot, '.github/workflows/product-nix-images.yml'), 'utf8'),
    )
    const releaseOnly = "github.event_name != 'pull_request' && github.ref == 'refs/heads/main'"
    for (const service of ['proompteng', 'app', 'synthesis', 'docs']) {
      expect(products.jobs[`build-${service}`].if).toBe(
        service === 'app'
          ? `!cancelled() && ${releaseOnly} && needs.changes.result == 'success' && needs.changes.outputs.app == 'true' && (needs.verify-app-dependency-closure.result == 'success' || (needs.changes.outputs.app_dependencies != 'true' && needs.verify-app-dependency-closure.result == 'skipped'))`
          : `${releaseOnly} && needs.changes.outputs.${service} == 'true'`,
      )
      expect(products.jobs[`build-${service}`].with.pr_number).toBeUndefined()
    }
    expect(products.jobs['verify-app-dependency-closure'].if).toBe(
      "needs.changes.outputs.app_dependencies == 'true' && (github.event_name == 'pull_request' || needs.changes.outputs.app == 'true')",
    )
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
    expect(source).toContain('cosign sign --yes')
    expect(source).toContain("--format '{{json .Manifest}}'")
    expect(source).toContain("jq -er '.digest'")
    expect(source).toContain('org.opencontainers.image.created=${{ steps.source.outputs.timestamp }}')
    expect(source).toContain('org.opencontainers.image.revision=${{ github.sha }}')
    expect(source).not.toContain('crane mutate')
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
    expect(source).not.toContain(':latest')
    expect(source).not.toContain('latest_digest')
    expect(source).not.toContain('sha256sum "${index_path}"')
    expect(source).not.toContain('release-contract.json')
    expect(workflow.jobs?.publish?.needs).toEqual(['build', 'validate'])
    expect(existsSync(resolve(repositoryRoot, 'argocd/applications/kargo'))).toBe(true)
  })

  it('runs the full controller and guest validation with read-only permissions', () => {
    const validation = YAML.parse(readFileSync(validationPath, 'utf8')) as {
      on: Record<string, unknown>
      permissions: Record<string, string>
      jobs?: {
        'validate-tengri'?: { steps?: Array<{ run?: string }> }
        'validate-nanoagent'?: { steps?: Array<{ run?: string }> }
      }
    }
    const controllerValidation = validation.jobs?.['validate-tengri']?.steps?.map((step) => step.run ?? '').join('\n')
    const guestValidation = validation.jobs?.['validate-nanoagent']?.steps?.map((step) => step.run ?? '').join('\n')

    expect(Object.keys(validation.on)).toEqual(['workflow_call'])
    expect(validation.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(validation.jobs ?? {}).sort()).toEqual(['validate-nanoagent', 'validate-tengri'])
    expect(controllerValidation).toContain('cargo fmt --check')
    expect(controllerValidation).toContain('cargo clippy --locked --all-targets -- -D warnings')
    expect(controllerValidation).toContain('cargo test --locked --all-targets')
    expect(controllerValidation).toContain('diff -u /tmp/tengri-crd.yaml ../../argocd/applications/tengri/crd.yaml')
    expect(guestValidation).toContain('GOWORK=off go test -race ./...')
    expect(guestValidation).toContain('GOWORK=off go vet ./...')
    expect(guestValidation).toContain('bash validate-rootfs.test.sh')
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

  it('holds automatic discovery until the enrolled guest protocol matches the release', () => {
    const images = YAML.parse(readFileSync(imagesPath, 'utf8')) as {
      jobs: { publish: { steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> } }
    }
    const exposed = images.jobs.publish.steps.find((step) => step.name === 'Expose both verified images to Kargo')
    if (!exposed?.run) throw new Error('Kargo exposure step is missing')
    const fixture = mkdtempSync(resolve(tmpdir(), 'tengri-cutover-hold-'))
    const calls = resolve(fixture, 'calls')
    const summary = resolve(fixture, 'summary')
    try {
      mkdirSync(resolve(fixture, 'services/tengri/src'), { recursive: true })
      for (const command of ['crane', 'docker']) {
        writeFileSync(resolve(fixture, command), '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$CALLS"\nexit 42\n', {
          mode: 0o755,
        })
      }
      for (const protocol of [9, 10]) {
        writeFileSync(
          resolve(fixture, 'services/tengri/src/lib.rs'),
          `pub const GUEST_API_PROTOCOL_VERSION: u32 = ${protocol};\n`,
        )
        for (const enrolled of ['', 'false', 'true', '8', '9', '10', '09']) {
          rmSync(calls, { force: true })
          const result = Bun.spawnSync(['bash', '-c', exposed.run], {
            cwd: fixture,
            env: {
              ...process.env,
              PATH: `${fixture}:${process.env.PATH}`,
              CALLS: calls,
              GITHUB_STEP_SUMMARY: summary,
              TENGRI_PREPARED_SLOT_CUTOVER_READY: 'true',
              TENGRI_PREPARED_SLOT_GUEST_API_VERSION: enrolled,
              SOURCE_SHA: '1'.repeat(40),
              GITHUB_SHA: '1'.repeat(40),
              TENGRI_DIGEST: `sha256:${'2'.repeat(64)}`,
              NANOAGENT_DIGEST: `sha256:${'3'.repeat(64)}`,
              TENGRI_IMAGE: 'registry.example.test/tengri',
              NANOAGENT_IMAGE: 'registry.example.test/nanoagent',
            },
          })
          if (enrolled === String(protocol)) {
            expect(result.exitCode).not.toBe(0)
            expect(readFileSync(calls, 'utf8')).toContain('crane digest registry.example.test/tengri:kargo-sha-')
          } else {
            expect(result.exitCode).toBe(0)
            expect(existsSync(calls)).toBe(false)
            expect(readFileSync(summary, 'utf8')).toContain('publication held')
          }
        }
      }
      expect(exposed.env?.TENGRI_PREPARED_SLOT_GUEST_API_VERSION).toBe(
        "${{ vars.TENGRI_PREPARED_SLOT_GUEST_API_VERSION || '' }}",
      )
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('uses the same enrolled protocol to gate the web image', () => {
    const products = YAML.parse(
      readFileSync(resolve(repositoryRoot, '.github/workflows/product-nix-images.yml'), 'utf8'),
    ) as {
      jobs: { changes: { steps: Array<{ id?: string; run?: string; env?: Record<string, string> }> } }
    }
    const gate = products.jobs.changes.steps.find((step) => step.id === 'cutover')
    if (!gate?.run) throw new Error('Product cutover gate is missing')
    const fixture = mkdtempSync(resolve(tmpdir(), 'tengri-web-cutover-'))
    const output = resolve(fixture, 'output')
    try {
      mkdirSync(resolve(fixture, 'services/tengri/src'), { recursive: true })
      for (const protocol of [9, 10]) {
        writeFileSync(
          resolve(fixture, 'services/tengri/src/lib.rs'),
          `pub const GUEST_API_PROTOCOL_VERSION: u32 = ${protocol};\n`,
        )
        for (const enrolled of ['', 'true', '8', '9', '10', '09']) {
          rmSync(output, { force: true })
          const result = Bun.spawnSync(['bash', '-c', gate.run], {
            cwd: fixture,
            env: {
              ...process.env,
              GITHUB_OUTPUT: output,
              TENGRI_PREPARED_SLOT_CUTOVER_READY: 'true',
              TENGRI_PREPARED_SLOT_GUEST_API_VERSION: enrolled,
            },
          })
          expect(result.exitCode).toBe(0)
          expect(readFileSync(output, 'utf8').trim()).toBe(`cutover_ready=${enrolled === String(protocol)}`)
        }
      }
      expect(gate.env?.TENGRI_PREPARED_SLOT_GUEST_API_VERSION).toBe(
        "${{ vars.TENGRI_PREPARED_SLOT_GUEST_API_VERSION || '' }}",
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
    const validation = readFileSync(validationPath, 'utf8').split('\n  validate-nanoagent:\n')[0]

    expect(existsSync(resolve(repositoryRoot, '.github/workflows/tengri-controller.yaml'))).toBe(false)
    expect(validation).toContain('cargo fmt --check')
    expect(validation).toContain('cargo clippy --locked --all-targets -- -D warnings')
    expect(validation).toContain('cargo test --locked --all-targets')
    expect(validation).toContain('bash test-runtime.sh')
    expect(validation).toContain('bash test-rpc-interop.sh')
    expect(validation).toContain('cargo run --locked --quiet --bin crdgen')
    expect(validation).toContain('diff -u /tmp/tengri-crd.yaml crd.yaml')
    expect(validation).toContain('diff -u /tmp/tengri-crd.yaml ../../argocd/applications/tengri/crd.yaml')
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
