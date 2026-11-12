import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

const setupAction = readRepoFile('.github/actions/setup-nix-toolchain/action.yml')
const arcApplication = readRepoFile('argocd/applications/arc/application.yaml')
const arcRunnerImage = readRepoFile('nix/images/arc-runner.nix')
const arcRunnerBuildWorkflow = readRepoFile('.github/workflows/arc-runner-build-push.yml')
const arcPlacementAcceptance = readRepoFile('.github/workflows/arc-placement-acceptance.yml')
const nixOciWorkflow = readRepoFile('.github/workflows/nix-oci-build-common.yml')
const agentsBuildWorkflow = readRepoFile('.github/workflows/agents-build-push.yml')
const argoLintWorkflow = readRepoFile('.github/workflows/argo-lint.yml')
const kubeconformWorkflow = readRepoFile('.github/workflows/kubeconform.yml')
const headlampWorkflow = readRepoFile('.github/workflows/headlamp-ci.yml')
const flake = readRepoFile('flake.nix')
const nixPackages = readRepoFile('nix/packages.nix')
const toolchainDoctor = readRepoFile('nix/toolchain-doctor.sh')

const runnerScaleSetBlock = (name: string): string => {
  const start = arcApplication.indexOf(`runnerScaleSetName: ${name}`)
  expect(start).toBeGreaterThan(-1)

  const next = arcApplication.indexOf('runnerScaleSetName:', start + 1)
  return arcApplication.slice(start, next === -1 ? arcApplication.length : next)
}

const arcRunnerBuildTriggerPaths = YAML.parse(arcRunnerBuildWorkflow).on.push.paths as string[]

const arcRunnerToolchainScriptPaths = Array.from(
  new Set(Array.from(flake.matchAll(/builtins\.readFile \.\/(nix\/[^)]+\.sh)/g), ([, path]) => path)),
)

const arcNixSetupSteps = (workflow: string) => {
  const jobs = YAML.parseDocument(workflow).get('jobs')
  if (!YAML.isMap(jobs)) throw new Error('Workflow jobs are missing')
  return jobs.items.flatMap(({ key, value: job }) => {
    if (!YAML.isMap(job)) throw new Error('Workflow job is not a map')
    const runner = job.get('runs-on')
    const matrix = job.getIn(['strategy', 'matrix', 'include'])
    const runners =
      typeof runner === 'string' && runner.includes('matrix.runner') && YAML.isSeq(matrix)
        ? matrix.items.map((row) => (YAML.isMap(row) ? row.get('runner') : undefined))
        : YAML.isSeq(runner)
          ? runner.toJSON()
          : [runner]
    if (!runners.some((name: unknown) => typeof name === 'string' && name.startsWith('arc-'))) return []
    const steps = job.get('steps')
    if (!YAML.isSeq(steps)) return []
    return steps.items.flatMap((step) =>
      YAML.isMap(step) && step.get('uses') === './.github/actions/setup-nix-toolchain'
        ? [{ job: String(key), required: step.getIn(['with', 'require-preinstalled']) }]
        : [],
    )
  })
}

describe('ARC Nix runner toolchain', () => {
  it('keeps runner scratch disposable while making runner images releasable by digest', () => {
    expect(arcApplication).toContain('runnerScaleSetName: arc-arm64')
    expect(arcApplication).toContain('runnerScaleSetName: arc-amd64')
    expect(arcApplication).toContain('runnerScaleSetName: analysis-arm64')
    expect(arcApplication).not.toContain('image: docker:dind')
    const armBlock = runnerScaleSetBlock('arc-arm64')
    expect(armBlock).toContain('emptyDir:')
    expect(armBlock).toContain('sizeLimit: 130Gi')
    expect(armBlock).not.toContain('volumeClaimTemplate:')
    expect(runnerScaleSetBlock('arc-amd64')).toContain('storageClassName: rook-ceph-block')
    const analysisBlock = runnerScaleSetBlock('analysis-arm64')
    expect(analysisBlock).toContain('emptyDir:')
    expect(analysisBlock).toContain('sizeLimit: 20Gi')
    expect(analysisBlock).not.toContain('ACTIONS_RUNNER_CONTAINER_HOOKS')
    expect(analysisBlock).not.toContain('volumeClaimTemplate:')
    expect(analysisBlock).not.toContain('storageClassName: "rook-ceph-block"')
    expect(arcRunnerBuildWorkflow).toContain('image_name: arc-runner')
    expect(arcRunnerBuildWorkflow).toContain('latest: ${{')
  })

  it('keeps ARC control pods on Ryzen while ARM64 runners stay on Altra', () => {
    const application = YAML.parse(arcApplication)
    expect(application.spec.sources[0].helm.valuesObject).toMatchObject({
      nodeSelector: { 'kubernetes.io/arch': 'amd64', 'kubernetes.io/hostname': 'talos-192-168-1-194' },
      tolerations: [
        {
          key: 'workload.proompteng.ai/compute-local',
          operator: 'Equal',
          value: 'true',
          effect: 'NoSchedule',
        },
      ],
    })

    for (const name of ['arc-arm64', 'analysis-arm64']) {
      const source = application.spec.sources.find(
        (candidate: { helm?: { valuesObject?: { runnerScaleSetName?: string } } }) =>
          candidate.helm?.valuesObject?.runnerScaleSetName === name,
      )
      expect(source.helm.valuesObject.listenerTemplate.spec).toMatchObject({
        nodeSelector: { 'kubernetes.io/arch': 'amd64', 'kubernetes.io/hostname': 'talos-192-168-1-194' },
        tolerations: [
          {
            key: 'workload.proompteng.ai/compute-local',
            operator: 'Equal',
            value: 'true',
            effect: 'NoSchedule',
          },
        ],
      })
      expect(source.helm.valuesObject.template.spec.nodeSelector).toEqual({ 'kubernetes.io/arch': 'arm64' })
    }
  })

  it('places AMD64 Nix and workspace writes on one disposable Ceph RBD volume', () => {
    const application = YAML.parseDocument(arcApplication)
    for (const [index, name, storageClass] of [[2, 'arc-amd64', 'rook-ceph-block']] as const) {
      const valuesPath = ['spec', 'sources', index, 'helm', 'valuesObject']
      expect(application.getIn([...valuesPath, 'runnerScaleSetName'])).toBe(name)
      expect(application.getIn([...valuesPath, 'scaleSetLabels']).toJSON()).toContain('arc-amd64')
      const pod = application.getIn([...valuesPath, 'template', 'spec'])
      if (!YAML.isMap(pod)) throw new Error('AMD64 runner Pod template is missing')

      const workMount = { name: 'scratch', mountPath: '/home/runner/_work', subPath: 'work' }
      expect(pod.toJSON()).toMatchObject({
        nodeSelector: { 'kubernetes.io/arch': 'amd64', 'kubernetes.io/hostname': 'turin' },
        initContainers: expect.arrayContaining([
          expect.objectContaining({
            volumeMounts: expect.arrayContaining([{ name: 'scratch', mountPath: '/scratch' }]),
          }),
        ]),
        containers: expect.arrayContaining([
          expect.objectContaining({
            name: 'runner',
            volumeMounts: expect.arrayContaining([
              { name: 'scratch', mountPath: '/nix', subPath: 'nix' },
              { name: 'scratch', mountPath: '/home/runner/.cache', subPath: 'cache' },
              { name: 'scratch', mountPath: '/tmp', subPath: 'tmp' },
              { name: 'scratch', mountPath: '/var/tmp', subPath: 'var-tmp' },
              workMount,
            ]),
          }),
        ]),
        volumes: expect.arrayContaining([
          {
            name: 'scratch',
            ephemeral: {
              volumeClaimTemplate: expect.objectContaining({
                spec: {
                  accessModes: ['ReadWriteOnce'],
                  storageClassName: storageClass,
                  volumeMode: 'Filesystem',
                  resources: { requests: { storage: '130Gi' } },
                },
              }),
            },
          },
        ]),
      })
      expect(pod.toJSON().tolerations).toContainEqual({
        key: 'workload.proompteng.ai/compute-local',
        operator: 'Equal',
        value: 'true',
        effect: 'NoSchedule',
      })
    }
  })

  it('keeps ten warm AMD64 runners while preserving the other runner pools', () => {
    expect(runnerScaleSetBlock('arc-arm64')).toContain('maxRunners: 8')
    expect(runnerScaleSetBlock('arc-arm64')).toContain('minRunners: 1')
    expect(runnerScaleSetBlock('arc-amd64')).toContain('maxRunners: 10')
    expect(runnerScaleSetBlock('arc-amd64')).toContain('minRunners: 10')
    expect(runnerScaleSetBlock('arc-amd64-publish')).toContain('maxRunners: 2')
    expect(runnerScaleSetBlock('arc-amd64-publish')).toContain('minRunners: 1')
    expect(arcApplication).not.toContain('runnerScaleSetName: arc-amd64-ryzen')
    expect(arcApplication).not.toContain('arc-amd64-turin')
    expect(runnerScaleSetBlock('analysis-arm64')).toContain('maxRunners: 1')
    expect(runnerScaleSetBlock('analysis-arm64')).toContain('minRunners: 1')
  })

  it('pins AMD64 builds to Turin without repurposing the existing local storage paths', () => {
    const application = YAML.parseDocument(arcApplication)
    const pod = application.getIn(['spec', 'sources', 2, 'helm', 'valuesObject', 'template', 'spec'])
    if (!YAML.isMap(pod)) throw new Error('AMD64 runner Pod template is missing')
    expect(pod.toJSON().nodeSelector).toEqual({
      'kubernetes.io/arch': 'amd64',
      'kubernetes.io/hostname': 'turin',
    })
    expect(pod.getIn(['volumes', 0, 'ephemeral', 'volumeClaimTemplate', 'spec', 'storageClassName'])).toBe(
      'rook-ceph-block',
    )
    expect(pod.getIn(['containers', 0, 'resources', 'requests', 'memory'])).toBe('16Gi')
    const config = YAML.parseDocument(
      readRepoFile('argocd/applications/local-path/patches/local-path-config.patch.yaml'),
    )
    const data = JSON.parse(String(config.getIn(['data', 'config.json'])))
    expect(data.nodePathMap).toEqual([])
    expect(data.storageClassConfigs['local-path-ci-amd64'].nodePathMap).toEqual([
      { node: 'talos-192-168-1-194', paths: ['/var/mnt/local-path-provisioner'] },
      { node: 'turin', paths: ['/var/lib/kubelet/ci-amd64'] },
      { node: 'DEFAULT_PATH_FOR_NON_LISTED_NODES', paths: [] },
    ])
    expect(Object.keys(data.storageClassConfigs).sort()).toEqual([
      'local-path',
      'local-path-bayn-wal',
      'local-path-ci-amd64',
    ])
  })

  it('admits only a separate Ceph RBD ext4 scratch mount before touching files', () => {
    const application = YAML.parse(arcApplication)
    const script = application.spec.sources[2].helm.valuesObject.template.spec.initContainers[0].args[0] as string
    const boundary = script.indexOf('# A terminated init')
    if (boundary < 0) throw new Error('Scratch admission boundary is missing')
    const admission = script.slice(0, boundary)
    const directory = mkdtempSync(join(tmpdir(), 'arc-scratch-admission-'))
    writeFileSync(
      join(directory, 'df'),
      `#!/bin/sh
for path do :; done
printf 'Filesystem Type Blocks Used Available Capacity Mounted\\n'
if [ "$path" = / ]; then
  printf '%s overlay 1 0 1 0%% /\\n' "$ARC_TEST_ROOT"
else
  printf '%s %s 1 0 1 0%% /scratch\\n' "$ARC_TEST_DEVICE" "$ARC_TEST_FSTYPE"
fi
`,
      { mode: 0o755 },
    )
    try {
      for (const [device, filesystem, root, status] of [
        ['/dev/rbd0', 'ext4', 'overlay', 0],
        ['/dev/rbd12', 'ext4', 'overlay', 0],
        ['/dev/nvme3n1p4', 'ext4', 'overlay', 1],
        ['/dev/rbd0', 'xfs', 'overlay', 1],
        ['overlay', 'overlay', 'overlay', 1],
        ['/dev/rbd0', 'ext4', '/dev/rbd0', 1],
      ] as const) {
        const result = spawnSync('bash', ['-c', admission], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            ARC_TEST_DEVICE: device,
            ARC_TEST_FSTYPE: filesystem,
            ARC_TEST_ROOT: root,
          },
        })
        expect(result.status, `${device} ${filesystem} root=${root}: ${result.stderr}`).toBe(status)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('requires ten Ceph builders and two publication runners without weakening the overlap proof', () => {
    const jobs = YAML.parse(arcPlacementAcceptance).jobs
    expect(jobs['ceph-build'].strategy.matrix.slot).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(jobs['ceph-build'].strategy['max-parallel']).toBe(10)
    expect(jobs['publication-tools'].strategy.matrix.slot).toEqual([1, 2])
    expect(jobs['publication-tools'].strategy['max-parallel']).toBe(2)
    expect(jobs['verify-placement'].needs).toEqual(['ceph-build', 'publication-tools'])
    for (const job of Object.values(jobs) as { steps: { run?: string }[] }[]) {
      for (const step of job.steps) {
        if (step.run) {
          const syntax = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' })
          expect(syntax.status, syntax.stderr).toBe(0)
        }
      }
    }
    expect(arcPlacementAcceptance).toContain('"$RUNNER_TEMP" "$buildkit_root"')
    expect(arcPlacementAcceptance).toContain('test "$device" = "$scratch_device"')
    expect(arcPlacementAcceptance).toContain('test "$output_sha" = "$input_sha"')
    expect(arcPlacementAcceptance).toContain('([.[].pod] | unique | length) == 12')
    expect(arcPlacementAcceptance).toContain('([.[].end] | min) - ([.[].start] | max) >= 45')
  })

  it('reserves small sidecar-free runners for publication outside the native build queues', () => {
    const application = YAML.parse(arcApplication)
    const source = application.spec.sources.find(
      (source: { helm?: { valuesObject?: { runnerScaleSetName?: string } } }) =>
        source.helm?.valuesObject?.runnerScaleSetName === 'arc-amd64-publish',
    )
    const pod = source.helm.valuesObject.template.spec
    expect(pod.nodeSelector).toEqual({ 'kubernetes.io/arch': 'amd64' })
    expect(pod.tolerations).toContainEqual({
      key: 'workload.proompteng.ai/compute-local',
      operator: 'Equal',
      value: 'true',
      effect: 'NoSchedule',
    })
    expect(pod.automountServiceAccountToken).toBe(false)
    expect(pod.containers.map((container: { name: string }) => container.name)).toEqual(['runner'])
    expect(pod.containers[0].securityContext.privileged).toBe(false)
    expect(pod.initContainers).toBeUndefined()
    expect(pod.containers[0].resources.requests).toEqual({ cpu: '1', memory: '2Gi', 'ephemeral-storage': '2Gi' })
    expect(pod.volumes).toEqual([{ name: 'work', emptyDir: { sizeLimit: '32Gi' } }])
  })

  it('isolates each job in a private BuildKit process without a sidecar or shared cache', () => {
    const application = YAML.parse(arcApplication)
    for (const index of [1, 2, 3]) {
      const pod = application.spec.sources[index].helm.valuesObject.template.spec
      expect(pod.containers.map((container: { name: string }) => container.name)).toEqual(['runner'])
      expect(JSON.stringify(pod)).not.toMatch(/DOCKER_HOST|podman|hostPath|dind|tcp:\/\//)
      expect(pod.containers[0].command).toEqual(['/home/runner/run.sh'])
      expect(pod.containers[0].securityContext.privileged).toBe(true)
    }
    const setup = YAML.parse(readRepoFile('.github/actions/setup-buildkit/action.yml'))
    const start = setup.runs.steps.find((step: { id?: string }) => step.id === 'worker').run
    expect(start).toContain('mktemp -d "$RUNNER_TEMP/buildkit.XXXXXX"')
    expect(start).toContain('endpoint="unix://$state/buildkitd.sock"')
    expect(start).toContain('--root "$state/cache"')
    expect(start).toContain('--containerd-worker=false')
    expect(start).not.toContain('tcp://')
    expect(
      setup.runs.steps.find((step: { uses?: string }) => step.uses === 'docker/setup-buildx-action@v3').with.driver,
    ).toBe('remote')
    expect(existsSync(new URL('argocd/applications/arc/buildkit.yaml', repoRoot))).toBe(false)
  })

  it('keeps lab ARC ephemeral-storage requests small enough for the configured runner scale', () => {
    for (const scaleSet of ['arc-arm64', 'arc-amd64']) {
      const block = runnerScaleSetBlock(scaleSet)
      expect(block).toContain('ephemeral-storage: "10Gi"')
      expect(block).not.toContain('storage: 20Gi')
    }

    expect(runnerScaleSetBlock('arc-arm64')).toContain('sizeLimit: 130Gi')
    expect(runnerScaleSetBlock('analysis-arm64')).toContain('sizeLimit: 20Gi')
    expect(runnerScaleSetBlock('analysis-arm64')).not.toContain('volumeClaimTemplate:')
  })

  it('builds a custom actions runner image with pinned Nix CI tools preinstalled', () => {
    expect(existsSync(new URL('images/arc-runner/Dockerfile', repoRoot))).toBe(false)
    expect(arcRunnerImage).toContain('pkgs.dockerTools.pullImage')
    expect(arcRunnerImage).toContain('pkgs.dockerTools.buildLayeredImageWithNixDb')
    expect(arcRunnerImage).toContain('ciToolchain')
    expect(arcRunnerImage).toContain('imageName = "ghcr.io/actions/actions-runner"')
    expect(arcRunnerImage).toContain(
      'imageDigest = "sha256:e5496277be5d09bc968b3d64911b74e219ac4a3f2edce956a3ecf9271bea1ef4"',
    )
    expect(arcRunnerImage).not.toContain('ghcr.io/actions/actions-runner:latest')
    expect(arcRunnerImage).toContain('LAB_ARC_RUNNER_TOOLCHAIN=1')
    expect(arcRunnerImage).toContain('experimental-features = nix-command flakes')
    expect(arcRunnerImage).toContain('build-users-group =')
    expect(arcRunnerImage).toContain('NIX_PAGER=cat')
    expect(arcRunnerImage).toContain('nix/store')
    expect(arcRunnerImage).toContain('nix/var/nix/db')
    expect(arcRunnerImage).toContain('fakeRootCommands =')
    expect(arcRunnerImage).toContain('chown 1001:1001 ./nix ./nix/store')
    expect(arcRunnerImage).toContain('chown -R 1001:1001 ./nix/var/nix')
    expect(arcRunnerImage).toContain('chmod 1777 tmp var/tmp')
    expect(arcRunnerImage).toContain('cat > etc/nix/nix.conf')
    expect(arcRunnerImage).not.toContain('home/runner/.config')
    expect(arcRunnerImage).not.toContain('home/runner/tmpDir')
    expect(arcRunnerImage).not.toContain('chown -R 1001:1001 home/runner')
    expect(arcRunnerImage).not.toContain('chmod -R u+rwX,go+rX home/runner')
    expect(arcRunnerImage).toContain('User = "runner"')
    expect(arcRunnerImage).toContain('/home/runner/run.sh')
    expect(arcRunnerImage).not.toContain('curl')
    expect(arcRunnerImage).not.toContain('apt-get')
    expect(arcRunnerImage).not.toContain('created = "now"')
    expect(flake).toContain('ciToolchain = pkgs.buildEnv')
    expect(flake).toContain('"arc-runner-image" = import ./nix/images/arc-runner.nix')
    expect(flake).toContain('name = "lab-ci-toolchain"')
    expect(flake).toContain('pathsToLink = [ "/bin" ]')
    expect(flake).toContain('ignoreCollisions = true')
    expect(nixPackages).toContain('pkgs.kubernetes-helm')
    expect(nixPackages).toContain('lib.versions.major')
    expect(nixPackages).toContain('kubernetes-helm must stay on Helm 3')
    expect(nixPackages).not.toContain('https://github.com/helm/helm/releases/download/v${helmVersion}/')
    expect(nixPackages).not.toContain('https://get.helm.sh/helm-v${helmVersion}-')
    expect(toolchainDoctor).toContain('expect_prefix helm v3.')
    expect(toolchainDoctor).not.toContain('expect_eq helm v3.14.4')
  })

  it('publishes multi-arch ARC runner images for Kargo discovery', () => {
    expect(arcRunnerBuildWorkflow).toContain('uses: ./.github/workflows/nix-oci-build-common.yml')
    expect(arcRunnerBuildWorkflow).toContain('image_name: arc-runner')
    expect(arcRunnerBuildWorkflow).toContain('package_attr: arc-runner-image')
    expect(arcRunnerBuildWorkflow).toContain('publish_kargo_tag: true')
    expect(arcRunnerBuildWorkflow).not.toContain('release_artifact_name:')
    expect(arcRunnerBuildWorkflow).toContain(
      "latest: ${{ (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main' }}",
    )
    expect(arcRunnerBuildTriggerPaths).toContain('flake.nix')
    expect(arcRunnerBuildTriggerPaths).toContain('flake.lock')
    expect(arcRunnerBuildTriggerPaths).toContain('nix/packages.nix')
    expect(arcRunnerBuildWorkflow).not.toContain('docker buildx')
    expect(arcRunnerBuildWorkflow).not.toContain('docker/setup-buildx-action')
    expect(arcRunnerBuildWorkflow).not.toContain('docker run')
    expect(arcRunnerBuildWorkflow).not.toContain("- '.github/actions/setup-nix-toolchain/**'")
    expect(arcRunnerBuildTriggerPaths).not.toContain('.github/workflows/nix-oci-build-common.yml')
    expect(arcRunnerBuildWorkflow).toContain("- 'nix/oci-push.sh'")
    expect(arcRunnerBuildWorkflow).not.toContain("- '.github/workflows/arc-runner-build-push.yml'")
    expect(arcRunnerBuildWorkflow).not.toContain("'packages/scripts/src/shared/__tests__/arc-runner.test.ts'")
    expect(arcRunnerBuildTriggerPaths.length).toBeGreaterThan(0)
    expect(arcRunnerToolchainScriptPaths.length).toBeGreaterThan(0)
    for (const toolchainScriptPath of arcRunnerToolchainScriptPaths) {
      expect(arcRunnerBuildTriggerPaths, `${toolchainScriptPath} must start ARC runner image builds`).toContain(
        toolchainScriptPath,
      )
    }
  })

  it('uses a shared setup action so Nix jobs validate preinstalled tools before falling back', () => {
    expect(setupAction).toContain('Detect preinstalled Nix')
    expect(setupAction).toContain('require-preinstalled:')
    expect(setupAction).toContain('Reject missing preinstalled Nix')
    expect(setupAction).toContain("inputs.require-preinstalled == 'true'")
    expect(setupAction).toContain("steps.detect.outputs.nix_available != 'true'")
    expect(setupAction).toContain(
      "steps.detect.outputs.nix_available != 'true' && inputs.require-preinstalled != 'true'",
    )
    expect(setupAction).toContain('uses: cachix/install-nix-action@v31')
    expect(setupAction).toContain('extra_nix_config: ${{ inputs.extra-nix-config }}')
    expect(setupAction).toContain('NIX_CONFIG<<__LAB_NIX_CONFIG__')
    expect(setupAction).toContain('has_nixbld_group=false')
    expect(setupAction).toContain('getent group nixbld')
    expect(setupAction).toContain('build-users-group =')
    expect(setupAction).toContain('Validate writable Nix store access')
    expect(setupAction).toContain('nix store info')
    expect(setupAction).toContain('NIX_REMOTE=daemon')
    expect(setupAction).toContain('/nix/var/nix/daemon-socket/socket')
    expect(setupAction).toContain('lab-nix-sudo-wrapper')
    expect(setupAction).toContain('sudo -n --preserve-env=NIX_CONFIG,NIX_SSL_CERT_FILE')
    expect(setupAction).toContain('LAB_NIX_WITH_SUDO=true')
    expect(setupAction).toContain('neither daemon nor sudo store access is available')
    expect(setupAction).toContain('REQUIRE_PREINSTALLED: ${{ inputs.require-preinstalled }}')
    expect(setupAction).toContain('Required CI toolchain commands are missing from the preinstalled runner image')
    expect(setupAction).toContain('command -v "${cmd}"')
    expect(setupAction).toContain('node')
    expect(setupAction).toContain('bun')
    expect(setupAction).toContain('uv')
    expect(setupAction).toContain('buildctl')
    expect(setupAction).toContain('nix profile install .#ciToolchain --priority 4')
    expect(setupAction).toContain('toolchain-doctor')
    expect(setupAction).toContain('oci-doctor')

    for (const workflow of [nixOciWorkflow, agentsBuildWorkflow, headlampWorkflow]) {
      expect(workflow).toContain('uses: ./.github/actions/setup-nix-toolchain')
      expect(workflow).toContain("require-preinstalled: 'true'")
    }

    for (const workflow of [argoLintWorkflow, kubeconformWorkflow]) {
      expect(workflow).toContain('runs-on: ubuntu-latest')
      expect(workflow).toContain('uses: ./.github/actions/setup-nix-toolchain')
      expect(workflow).not.toContain("require-preinstalled: 'true'")
    }

    expect(nixOciWorkflow).not.toContain('Install xz for Nix installer')
    expect(nixOciWorkflow).not.toContain('uses: cachix/install-nix-action@v31')
  })

  it('checks setup steps in their own ARC jobs, including matrix runners', () => {
    const setup = { uses: './.github/actions/setup-nix-toolchain' }
    const workflow = YAML.stringify({
      jobs: {
        hosted: { 'runs-on': 'ubuntu-latest', steps: [setup] },
        native: { 'runs-on': 'arc-amd64', steps: [] },
      },
    })
    expect(arcNixSetupSteps(workflow)).toEqual([])
    expect(
      arcNixSetupSteps(
        YAML.stringify({
          jobs: {
            guarded: {
              'runs-on': 'arc-amd64',
              steps: [{ ...setup, with: { 'require-preinstalled': 'true' } }],
            },
            unguarded: {
              'runs-on': '${{ matrix.runner }}',
              strategy: { matrix: { include: [{ runner: 'arc-arm64' }] } },
              steps: [setup],
            },
          },
        }),
      ),
    ).toEqual([
      { job: 'guarded', required: 'true' },
      { job: 'unguarded', required: undefined },
    ])
  })

  it('does not let ARC workflow callers silently use fallback Nix installation', () => {
    const workflowDir = new URL('.github/workflows/', repoRoot)
    const arcSetupCallers = readdirSync(workflowDir)
      .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
      .flatMap((file) => arcNixSetupSteps(readRepoFile(`.github/workflows/${file}`)).map((step) => ({ file, ...step })))

    expect(arcSetupCallers.length).toBeGreaterThan(0)
    for (const { file, job, required } of arcSetupCallers) {
      expect(required, `${file}:${job} must require the preinstalled ARC Nix toolchain`).toBe('true')
    }
  })
})
