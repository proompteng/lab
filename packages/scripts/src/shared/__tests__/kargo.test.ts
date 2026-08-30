import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'

const repoRoot = new URL('../../../../../', import.meta.url)

type Manifest = {
  apiVersion?: string
  kind?: string
  metadata?: {
    name?: string
    namespace?: string
  }
  spec?: Record<string, any>
}

const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

const readManifests = (path: string): Manifest[] =>
  YAML.parseAllDocuments(readRepoFile(path)).map((document) => {
    expect(document.errors, `${path} must contain valid YAML`).toEqual([])
    return document.toJSON() as Manifest
  })

const warehouses = readManifests('argocd/applications/kargo/warehouses.yaml')
const stages = readManifests('argocd/applications/kargo/stages.yaml')
const project = YAML.parse(readRepoFile('argocd/applications/kargo/project.yaml')) as Manifest
const projectConfig = YAML.parse(readRepoFile('argocd/applications/kargo/project-config.yaml')) as Manifest
const kustomization = YAML.parse(readRepoFile('argocd/applications/kargo/kustomization.yaml')) as {
  resources?: string[]
}
const stagesSource = readRepoFile('argocd/applications/kargo/stages.yaml')
const torghutMigrationJob = YAML.parse(readRepoFile('argocd/applications/torghut/db-migrations-job.yaml')) as Manifest
const torghutVerifierWorkflow = readRepoFile('.github/workflows/torghut-post-deploy-verify.yml')
const agentsBuildWorkflow = YAML.parse(readRepoFile('.github/workflows/agents-build-push.yml')) as Record<string, any>
const productNixWorkflow = YAML.parse(readRepoFile('.github/workflows/product-nix-images.yml')) as Record<string, any>
const analysisKustomization = readRepoFile('argocd/applications/analysis/kustomization.yaml')
const pullRequestWorkflow = readRepoFile('.github/workflows/pull-request.yml')
const helmApplicationSet = YAML.parse(readRepoFile('argocd/applicationsets/helm-apps.yaml')) as any
const helmApplicationElements = helmApplicationSet.spec.generators[0].matrix.generators[1].list.elements as Array<
  Record<string, any>
>
const kargoHelmValues = helmApplicationElements.find((element) => element.name === 'kargo')?.valuesObject as Record<
  string,
  any
>
const argoCDConfigMap = YAML.parse(readRepoFile('argocd/applications/argocd/overlays/argocd-cm.yaml')) as Manifest & {
  data?: Record<string, string>
}
const dexConfig = YAML.parse(argoCDConfigMap.data?.['dex.config'] ?? '') as Record<string, any>
const applicationSetElements = ['argocd/applicationsets/product.yaml', 'argocd/applicationsets/platform.yaml'].flatMap(
  (path) =>
    (YAML.parse(readRepoFile(path)) as any).spec.generators[0].matrix.generators[1].list.elements as Array<
      Record<string, any>
    >,
)

const imageRepo = (name: string): string => `registry.ide-newton.ts.net/lab/${name}`
const gitRepo = 'git@github.com:proompteng/lab.git'
const buildRunIdAnnotation = 'ai.proompteng.github-actions-run-id'
const buildConclusionAnnotation = 'ai.proompteng.github-actions-build-conclusion'
const runQualifiedTagRegex = '^kargo-sha-[0-9a-f]{40}-run-[1-9][0-9]*$'

type FreightCriteria = 'single' | 'all' | 'external'

const criteriaExpression = (mode: FreightCriteria, images: readonly string[]): string => {
  const clauses = images.map((image) => `imageFrom('${image}').Tag == 'kargo-sha-' + commitFrom('${gitRepo}').ID`)
  if (mode === 'all') return clauses.join(' && ')
  return clauses[0] ?? ''
}

const receiptCriteriaExpression = (images: readonly string[]): string => {
  const receiptImage = images.length === 1 ? images[0] : images[1]
  if (!receiptImage) return ''

  const receipt = `imageFrom('${receiptImage}')`
  const clauses = [
    `${receipt}.Annotations['${buildRunIdAnnotation}'] != nil`,
    `${receipt}.Annotations['${buildRunIdAnnotation}'] != ''`,
    `${receipt}.Annotations['${buildConclusionAnnotation}'] == 'success'`,
  ]
  for (const image of images.filter((candidate) => candidate !== receiptImage)) {
    const candidate = `imageFrom('${image}')`
    clauses.push(
      `${candidate}.Annotations['${buildRunIdAnnotation}'] == ${receipt}.Annotations['${buildRunIdAnnotation}']`,
    )
    clauses.push(`${candidate}.Annotations['${buildConclusionAnnotation}'] == 'success'`)
  }
  clauses.push(
    `${receipt}.Tag == 'kargo-sha-' + commitFrom('${gitRepo}').ID + '-run-' + ${receipt}.Annotations['${buildRunIdAnnotation}']`,
  )
  for (const image of images.filter((candidate) => candidate !== receiptImage)) {
    clauses.push(`imageFrom('${image}').Tag == ${receipt}.Tag`)
  }
  return clauses.join(' && ')
}

const productImageCommonInputs = [
  'nix/images/bun-workspace-service.nix',
  'nix/packages.nix',
  'nix/cache-push.sh',
  'nix/ci-nix-oci-summary.sh',
  'nix/ci-run-timed.sh',
  'nix/oci-inspect-archive.sh',
  '.github/workflows/nix-oci-build-common.yml',
  'nix/oci-push.sh',
  'flake.nix',
  'flake.lock',
  'bun.lock',
] as const

const expected = {
  proompteng: {
    creationCriteria: 'single',
    images: [imageRepo('proompteng')],
    apps: ['proompteng'],
    includePaths: [
      'apps/landing',
      'packages/backend',
      'packages/design',
      'services/tengri/proto',
      'nix/images/proompteng.nix',
      ...productImageCommonInputs,
      'argocd/applications/proompteng',
    ],
  },
  app: {
    creationCriteria: 'single',
    images: [imageRepo('app')],
    apps: ['app'],
    includePaths: [
      'apps/app',
      'packages/design',
      'nix/images/app.nix',
      ...productImageCommonInputs,
      'argocd/applications/app',
    ],
  },
  synthesis: {
    creationCriteria: 'single',
    images: [imageRepo('synthesis')],
    apps: ['synthesis'],
    includePaths: [
      'apps/synthesis',
      'packages/design',
      'nix/images/synthesis.nix',
      ...productImageCommonInputs,
      'argocd/applications/synthesis',
    ],
  },
  docs: {
    creationCriteria: 'single',
    images: [imageRepo('docs')],
    apps: ['docs'],
    includePaths: [
      'apps/docs',
      'packages/design',
      'nix/images/docs.nix',
      ...productImageCommonInputs,
      'argocd/applications/docs',
    ],
  },
  bumba: {
    creationCriteria: 'single',
    images: [imageRepo('bumba')],
    apps: ['bumba'],
    includePaths: [
      'services/bumba',
      'packages/temporal-bun-sdk',
      'nix/images/bumba.nix',
      '.github/workflows/nix-oci-build-common.yml',
      'nix/oci-push.sh',
      'argocd/applications/bumba',
    ],
  },
  oirat: {
    creationCriteria: 'single',
    images: [imageRepo('oirat')],
    apps: ['oirat'],
    includePaths: [
      'services/oirat',
      'packages/discord',
      'nix/images/oirat.nix',
      '.github/workflows/nix-oci-build-common.yml',
      'nix/oci-push.sh',
      'argocd/applications/oirat',
    ],
  },
  froussard: {
    creationCriteria: 'single',
    images: [imageRepo('froussard')],
    apps: ['froussard'],
    includePaths: [
      'apps/froussard',
      'packages/agent-contracts',
      'packages/codex',
      'packages/discord',
      'packages/otel',
      'nix/images/froussard.nix',
      '.github/workflows/nix-oci-build-common.yml',
      'nix/oci-push.sh',
      'argocd/applications/froussard',
    ],
  },
  'arc-runner': {
    creationCriteria: 'single',
    images: [imageRepo('arc-runner')],
    apps: ['arc'],
    includePaths: [
      'nix/images/arc-runner.nix',
      'nix/cache-doctor.sh',
      'nix/oci-doctor.sh',
      '.github/workflows/nix-oci-build-common.yml',
      'nix/oci-push.sh',
      'nix/toolchain-doctor.sh',
      'argocd/applications/arc',
    ],
  },
  attic: {
    creationCriteria: 'single',
    images: [imageRepo('attic')],
    apps: ['attic'],
    includePaths: [
      'nix/images/attic.nix',
      'docs/nix-cache.md',
      'docs/nix-oci-real-image-build-adoption-plan.md',
      '.github/workflows/nix-oci-build-common.yml',
      'nix/oci-push.sh',
      'argocd/applications/attic',
    ],
  },
  headlamp: {
    creationCriteria: 'single',
    images: [imageRepo('headlamp')],
    apps: ['headlamp'],
    includePaths: [
      '.github/workflows/headlamp-ci.yml',
      '.github/workflows/nix-oci-build-common.yml',
      'nix/oci-push.sh',
      'nix/verify-headlamp-image-assets.sh',
      'services/headlamp',
      'nix/images/headlamp.nix',
      'argocd/applications/headlamp',
    ],
  },
  'hermes-toolchain': {
    creationCriteria: 'single',
    images: [imageRepo('hermes-toolchain')],
    apps: ['hermes'],
    includePaths: [
      '.github/actions/setup-nix-toolchain',
      '.github/workflows/hermes-toolchain-build-push.yml',
      '.github/workflows/nix-oci-build-common.yml',
      'flake.lock',
      'flake.nix',
      'nix/ci-nix-oci-summary.sh',
      'nix/ci-run-timed.sh',
      'nix/images/hermes-toolchain.nix',
      'nix/oci-inspect-archive.sh',
      'nix/oci-push.sh',
      'nix/oci-release-contract.sh',
      'nix/packages.nix',
      'argocd/applications/hermes',
    ],
  },
  jangar: {
    creationCriteria: 'single',
    requiresBuildReceipt: true,
    tagRegex: runQualifiedTagRegex,
    images: [imageRepo('jangar')],
    apps: ['jangar'],
    includePaths: [
      'services/jangar',
      'services/bumba',
      'nix/images/jangar.nix',
      '.github/workflows/nix-oci-build-common.yml',
      '.github/workflows/jangar-post-deploy-verify.yml',
      'nix/oci-push.sh',
      'argocd/applications/jangar',
    ],
  },
  symphony: {
    creationCriteria: 'single',
    images: [imageRepo('symphony')],
    apps: ['symphony', 'symphony-jangar', 'symphony-torghut'],
    includePaths: [
      'services/symphony',
      'nix/images/symphony.nix',
      '.github/workflows/nix-oci-build-common.yml',
      '.github/workflows/symphony-post-deploy-verify.yml',
      'nix/oci-push.sh',
      'argocd/applications/symphony',
      'argocd/applications/symphony-jangar',
      'argocd/applications/symphony-torghut',
      'argocd/applications/symphony-base',
    ],
  },
  torghut: {
    creationCriteria: 'all',
    images: [
      imageRepo('torghut'),
      imageRepo('torghut-notebook'),
      imageRepo('torghut-ta'),
      imageRepo('torghut-ws'),
      imageRepo('signal-publisher'),
    ],
    apps: ['torghut', 'torghut-options', 'torghut-hyperliquid-runtime'],
    includePaths: [
      'services/torghut',
      'packages/scripts/src/torghut',
      'services/dorvud/gradle',
      'services/dorvud/gradlew',
      'services/dorvud/gradle.properties',
      'services/dorvud/settings.gradle.kts',
      'services/dorvud/build.gradle.kts',
      'services/dorvud/platform',
      'services/dorvud/technical-analysis',
      'services/dorvud/technical-analysis-flink',
      'services/dorvud/websockets',
      'services/signal-publisher',
      'nix/images/torghut.nix',
      'nix/images/torghut-notebook.nix',
      'nix/images/torghut-ta.nix',
      'nix/images/dorvud-jvm-service.nix',
      'nix/images/torghut-ws.nix',
      'nix/images/signal-publisher.nix',
      'nix/images/bun-workspace-service.nix',
      'services/torghut/uv.lock',
      'flake.nix',
      'flake.lock',
      'bun.lock',
      'package.json',
      '.github/workflows/nix-oci-build-common.yml',
      '.github/workflows/torghut-post-deploy-verify.yml',
      'nix/oci-push.sh',
      'argocd/applications/torghut',
      'argocd/applications/torghut-options',
      'argocd/applications/torghut-hyperliquid-runtime',
    ],
    excludePaths: ['packages/scripts/src/torghut/__tests__', 'glob:packages/scripts/src/torghut/**/*.test.ts'],
  },
  'torghut-hyperliquid-feed': {
    creationCriteria: 'single',
    images: [imageRepo('torghut-hyperliquid-feed')],
    apps: ['torghut-hyperliquid-feed'],
    includePaths: [
      'services/dorvud/gradle',
      'services/dorvud/gradlew',
      'services/dorvud/gradle.properties',
      'services/dorvud/settings.gradle.kts',
      'services/dorvud/build.gradle.kts',
      'services/dorvud/platform',
      'services/dorvud/hyperliquid-feed',
      'nix/images/dorvud-jvm-service.nix',
      'nix/images/torghut-hyperliquid-feed.nix',
      '.github/workflows/nix-oci-build-common.yml',
      'nix/oci-push.sh',
      'argocd/applications/torghut-hyperliquid-feed',
    ],
  },
  bilig: {
    creationCriteria: 'external',
    images: [imageRepo('bilig-app')],
    apps: ['bilig'],
    includePaths: ['argocd/applications/bilig'],
    platform: 'linux/arm64',
    tagRegex: '^[0-9a-f]{40}$',
  },
  analysis: {
    creationCriteria: 'external',
    images: [imageRepo('analysis')],
    apps: ['analysis'],
    includePaths: ['argocd/applications/analysis'],
    platform: 'linux/arm64',
    imageStrategy: 'Digest',
  },
  agents: {
    creationCriteria: 'all',
    requiresBuildReceipt: true,
    tagRegex: runQualifiedTagRegex,
    images: [
      imageRepo('agents-controller'),
      imageRepo('agents-control-plane'),
      imageRepo('agents-shell'),
      imageRepo('agents-codex-runner'),
    ],
    apps: ['agents'],
    includePaths: [
      'packages/agent-contracts',
      'packages/codex',
      'packages/cx-tools',
      'packages/otel',
      'packages/scripts/src/agents/update-values.ts',
      'packages/scripts/src/shared/oci.ts',
      'packages/temporal-bun-sdk',
      'services/agents',
      'charts/agents/crds',
      'nix/images/agents.nix',
      'nix/images/openai-codex-cli.nix',
      '.github/workflows/nix-oci-build-common.yml',
      'nix/oci-push.sh',
      'argocd/applications/agents',
      'charts/agents',
    ],
    excludePaths: [
      'services/agents/agentctl',
      'glob:services/agents/Dockerfile*',
      'glob:**/__tests__/**',
      'glob:**/__snapshots__/**',
      'glob:**/tests/**',
      'glob:**/*.test.ts',
      'glob:**/*.test.tsx',
      'glob:**/*.spec.ts',
      'glob:**/*.spec.tsx',
      'glob:**/*.md',
      'glob:**/*.mdx',
    ],
  },
  tengri: {
    creationCriteria: 'all',
    images: [imageRepo('tengri'), imageRepo('nanoagent')],
    apps: ['tengri'],
    includePaths: [
      'services/tengri',
      'services/nanoagent',
      '.github/workflows/tengri-images.yml',
      'packages/scripts/src/tengri',
      'packages/scripts/src/shared/cli.ts',
      'packages/scripts/package.json',
      'bun.lock',
      'argocd/applications/tengri',
    ],
  },
  buzz: {
    creationCriteria: 'single',
    images: [imageRepo('buzz')],
    apps: ['buzz'],
    includePaths: ['third_party/buzz', '.github/workflows/buzz-relay-build-push.yml', 'argocd/applications/buzz'],
  },
} as const

const expectedStageNames = Object.keys(expected).sort()

const byName = (manifests: Manifest[]): Map<string, Manifest> =>
  new Map(manifests.map((manifest) => [manifest.metadata?.name ?? '', manifest]))

describe('Kargo direct-push GitOps contract', () => {
  it('exposes the Kargo UI over Tailscale with Dex SSO and no built-in admin', () => {
    expect(kargoHelmValues.api).toMatchObject({
      enabled: true,
      host: 'kargo.ide-newton.ts.net',
      secretManagementEnabled: false,
      adminAccount: { enabled: false },
      oidc: {
        enabled: true,
        issuerURL: 'https://argocd.proompteng.ai/api/dex',
        clientID: 'kargo-ui',
        cliClientID: 'kargo-cli',
        usernameClaim: 'email',
        admins: { claims: { email: ['admin@proompteng.ai'] } },
      },
      tls: { enabled: false, terminatedUpstream: true },
      rollouts: { integrationEnabled: false },
    })
    expect(kargoHelmValues.externalWebhooksServer).toEqual({ enabled: false })

    const ingress = (kargoHelmValues.extraObjects as Array<Record<string, any>>).find(
      (object) => object.kind === 'Ingress' && object.metadata?.name === 'kargo-tailscale',
    )
    expect(ingress).toMatchObject({
      metadata: {
        namespace: 'kargo',
        annotations: { 'tailscale.com/tags': 'tag:k8s' },
      },
      spec: {
        ingressClassName: 'tailscale',
        tls: [{ hosts: ['kargo.ide-newton.ts.net'] }],
        rules: [
          {
            host: 'kargo.ide-newton.ts.net',
            http: {
              paths: [
                {
                  path: '/',
                  pathType: 'Prefix',
                  backend: { service: { name: 'kargo-api', port: { number: 80 } } },
                },
              ],
            },
          },
        ],
      },
    })

    expect(dexConfig.web.allowedOrigins).toContain('https://kargo.ide-newton.ts.net')
    expect(dexConfig.staticClients).toEqual(
      expect.arrayContaining([
        {
          id: 'kargo-ui',
          name: 'Kargo UI',
          public: true,
          redirectURIs: ['https://kargo.ide-newton.ts.net/login'],
        },
        { id: 'kargo-cli', name: 'Kargo CLI', public: true },
      ]),
    )
  })

  it('points every enrolled Argo Application at its exact authorized Kargo branch', () => {
    const applications = new Map(applicationSetElements.map((element) => [element.name as string, element]))
    const expectedApplications = Object.values(expected)
      .flatMap((contract) => contract.apps)
      .sort()
    const kargoApplications = applicationSetElements
      .filter((element) => String(element.targetRevision ?? '').startsWith('kargo/'))
      .map((element) => element.name as string)
      .sort()
    expect(kargoApplications).toEqual(expectedApplications)

    for (const [stageName, contract] of Object.entries(expected)) {
      for (const applicationName of contract.apps) {
        expect(applications.get(applicationName)?.targetRevision).toBe(`kargo/${stageName}`)
        expect(applications.get(applicationName)?.annotations?.['kargo.akuity.io/authorized-stage']).toBe(
          `lab-delivery:${stageName}`,
        )
      }
    }

    expect(applications.get('bayn')?.targetRevision).toBe('codex/bayn-deploy')
    expect(applications.get('bayn')?.annotations?.['kargo.akuity.io/authorized-stage']).toBeUndefined()
  })

  it('defines one automatic Warehouse for every promoted application group', () => {
    expect(project.apiVersion).toBe('kargo.akuity.io/v1alpha1')
    expect(project.kind).toBe('Project')
    expect(project.metadata?.name).toBe('lab-delivery')
    expect(project.metadata?.namespace).toBeUndefined()

    const warehouseMap = byName(warehouses)
    expect([...warehouseMap.keys()].sort()).toEqual(expectedStageNames)

    for (const stageName of expectedStageNames) {
      const contract = expected[stageName as keyof typeof expected]
      const warehouse = warehouseMap.get(stageName)
      expect(warehouse).toBeDefined()
      expect(warehouse?.metadata?.namespace).toBe('lab-delivery')
      expect(warehouse?.spec?.interval).toBe('1m')
      expect(warehouse?.spec?.freightCreationPolicy).toBe('Automatic')
      const criteria = warehouse?.spec?.freightCreationCriteria as { expression?: string } | undefined
      if (contract.creationCriteria === 'external') {
        expect(criteria).toBeUndefined()
      } else {
        const baseCriteria = criteriaExpression(contract.creationCriteria, contract.images)
        if ('requiresBuildReceipt' in contract && contract.requiresBuildReceipt) {
          expect(criteria?.expression).toBe(receiptCriteriaExpression(contract.images))
        } else {
          expect(criteria?.expression).toBe(baseCriteria)
        }
      }

      const subscriptions = warehouse?.spec?.subscriptions as Array<Record<string, any>>
      expect(subscriptions).toHaveLength(contract.images.length + 1)
      const git = subscriptions.find((subscription) => subscription.git)?.git
      expect(git).toMatchObject({
        repoURL: 'git@github.com:proompteng/lab.git',
        branch: 'main',
        commitSelectionStrategy: 'NewestFromBranch',
      })
      expect(git?.includePaths).toEqual(contract.includePaths)
      if (contract.excludePaths) expect(git?.excludePaths).toEqual(contract.excludePaths)
      else expect(git?.excludePaths).toBeUndefined()

      const imageSubscriptions = subscriptions
        .filter((subscription) => subscription.image)
        .map((subscription) => subscription.image)
      expect(imageSubscriptions.map((image) => image.repoURL)).toEqual(contract.images)
      for (const image of imageSubscriptions) {
        expect(image.imageSelectionStrategy).toBe(contract.imageStrategy ?? 'NewestBuild')
        if (contract.imageStrategy === 'Digest') {
          expect(image.constraint).toBe('latest')
          expect(image.cacheByTag).toBeUndefined()
        } else {
          expect(image.cacheByTag).toBe(true)
        }
        expect(image.platform).toBe(contract.platform ?? 'linux/amd64')
        if (contract.imageStrategy === 'Digest') {
          expect(image.allowTagsRegexes).toBeUndefined()
        } else {
          expect(image.allowTagsRegexes).toEqual([contract.tagRegex ?? '^kargo-sha-[0-9a-f]{40}$'])
        }
      }
    }
  })

  it('aligns each product Warehouse source paths with its exact image build filter', () => {
    expect(productNixWorkflow.concurrency).toEqual({
      group: 'product-nix-images-${{ github.event.pull_request.number || github.run_id }}',
      'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
    })

    const filtersSource = productNixWorkflow.jobs?.changes?.steps?.find(
      (step: Record<string, any>) => step.id === 'filter',
    )?.with?.filters
    expect(typeof filtersSource).toBe('string')
    const buildFilters = YAML.parse(filtersSource) as Record<string, string[]>
    const warehouseMap = byName(warehouses)

    for (const product of ['proompteng', 'app', 'synthesis', 'docs']) {
      const warehouse = warehouseMap.get(product)
      const subscriptions = warehouse?.spec?.subscriptions as Array<Record<string, any>>
      const warehousePaths = subscriptions.find((subscription) => subscription.git)?.git?.includePaths
      const buildPaths = buildFilters[product]?.map((path) => path.replace(/\/\*\*$/, ''))
      expect(warehousePaths).toEqual(buildPaths)
    }
  })

  it('aligns the Agents Warehouse source paths with its exact image build trigger', () => {
    const warehouse = byName(warehouses).get('agents')
    const subscriptions = warehouse?.spec?.subscriptions as Array<Record<string, any>>
    const git = subscriptions.find((subscription) => subscription.git)?.git
    const buildPaths = agentsBuildWorkflow.on?.push?.paths as string[]
    const includePaths = buildPaths.filter((path) => !path.startsWith('!')).map((path) => path.replace(/\/\*\*$/, ''))
    const excludePaths = buildPaths
      .filter((path) => path.startsWith('!'))
      .map((path) => path.slice(1))
      .map((path) => (path.endsWith('/**') && !path.slice(0, -3).includes('*') ? path.slice(0, -3) : path))
      .map((path) => (path.includes('*') ? `glob:${path}` : path))

    expect(git?.includePaths).toEqual(includePaths)
    expect(git?.excludePaths).toEqual(excludePaths)
  })

  it('keeps every stage direct, automatic, branch-backed, and free of pull-request promotion', () => {
    const stageMap = byName(stages)
    expect([...stageMap.keys()].sort()).toEqual(expectedStageNames)

    const projectPolicies = projectConfig.spec?.promotionPolicies as Array<Record<string, any>>
    expect(projectPolicies.map((policy) => policy.stageSelector?.name).sort()).toEqual(expectedStageNames)
    expect(projectPolicies.every((policy) => policy.autoPromotionEnabled === true)).toBe(true)

    for (const stageName of expectedStageNames) {
      const contract = expected[stageName as keyof typeof expected]
      const stage = stageMap.get(stageName)
      expect(stage?.metadata?.namespace).toBe('lab-delivery')

      const vars = Object.fromEntries(
        ((stage?.spec?.vars ?? []) as Array<{ name: string; value: string }>).map((variable) => [
          variable.name,
          variable.value,
        ]),
      )
      expect(vars.gitRepo).toBe('git@github.com:proompteng/lab.git')
      expect(vars.targetBranch).toBe(`kargo/${stageName}`)
      expect(vars.srcPath).toBe('./src')
      expect(vars.outPath).toBe('./out')
      for (const image of contract.images) expect(JSON.stringify(vars)).toContain(image)

      const requestedFreight = stage?.spec?.requestedFreight as Array<Record<string, any>>
      expect(requestedFreight).toHaveLength(1)
      expect(requestedFreight[0].origin).toEqual({ kind: 'Warehouse', name: stageName })
      expect(requestedFreight[0].sources).toEqual({
        direct: true,
        autoPromotionOptions: { selectionPolicy: 'NewestFreight' },
      })

      const steps = stage?.spec?.promotionTemplate?.spec?.steps as Array<Record<string, any>>
      expect(steps.map((step) => step.uses)).not.toContain('git-open-pr')
      expect(steps.map((step) => step.uses)).not.toContain('git-wait-for-pr')
      expect(steps.map((step) => step.uses)).not.toContain('github-push')
      expect(steps.map((step) => step.uses)).toContain('git-clone')
      expect(steps.map((step) => step.uses)).toContain('git-clear')
      expect(steps.map((step) => step.uses)).toContain('copy')
      expect(steps.map((step) => step.uses)).toContain('git-commit')
      expect(steps.map((step) => step.uses)).toContain('git-push')
      expect(steps.at(-1)?.uses).toBe('argocd-update')

      const push = steps.find((step) => step.uses === 'git-push')
      expect(push?.config).toMatchObject({
        path: '${{ vars.outPath }}',
        targetBranch: '${{ vars.targetBranch }}',
      })
      expect(push?.config?.force).toBeUndefined()

      if (['jangar', 'symphony', 'torghut'].includes(stageName)) {
        const commit = steps.find((step) => step.uses === 'git-commit')
        expect(commit?.config?.message).toContain('Source commit: ${{ commitFrom(vars.gitRepo).ID }}')
      }

      const clone = steps.find((step) => step.uses === 'git-clone')
      expect(clone?.config).toMatchObject({
        repoURL: '${{ vars.gitRepo }}',
        author: { name: 'Kargo', email: 'kargo@proompteng.ai' },
      })
      expect(clone?.config?.checkout).toEqual([
        { commit: '${{ commitFrom(vars.gitRepo).ID }}', path: '${{ vars.srcPath }}' },
        { branch: '${{ vars.targetBranch }}', create: true, path: '${{ vars.outPath }}' },
      ])

      const argocdUpdate = steps.at(-1)
      expect(argocdUpdate?.retry).toEqual({
        timeout: stageName === 'torghut' ? '105m' : '20m',
        errorThreshold: 3,
      })
      const apps = argocdUpdate?.config?.apps as Array<Record<string, any>>
      expect(apps.map((app) => app.name)).toEqual(contract.apps)
      for (const app of apps) {
        expect(app.namespace).toBe('argocd')
        expect(app.sources).toEqual([
          {
            repoURL: 'https://github.com/proompteng/lab.git',
            desiredRevision: '${{ outputs.commit.commit }}',
          },
        ])
      }

      if (stageName === 'agents') {
        expect(steps[0].uses).toBe('fail')
        expect(steps[0].if).toContain('imageFrom(vars.agentsControllerImage).Tag')
        expect(steps[0].if).toContain('imageFrom(vars.agentsControlPlaneImage).Tag')
        expect(steps[0].if).toContain('imageFrom(vars.agentsShellImage).Tag')
        expect(steps[0].if).toContain('imageFrom(vars.agentsCodexRunnerImage).Tag')
      } else if (stageName === 'tengri') {
        expect(steps[0].uses).toBe('fail')
        expect(steps[0].if).toContain('imageFrom(vars.tengriImage).Tag')
        expect(steps[0].if).toContain('imageFrom(vars.nanoagentImage).Tag')
      } else {
        expect(steps[0].uses).toBe('git-clone')
      }
    }
  })

  it('lets the Torghut Kargo sync outlast its migration and verifier windows', () => {
    const torghut = byName(stages).get('torghut')
    const steps = torghut?.spec?.promotionTemplate?.spec?.steps as Array<Record<string, any>>
    const timeout = String(steps.find((step) => step.uses === 'argocd-update')?.retry?.timeout ?? '')
    const timeoutMinutes = Number(timeout.match(/^(\d+)m$/)?.[1])
    const timeoutSeconds = timeoutMinutes * 60
    const migrationDeadlineSeconds = Number(torghutMigrationJob.spec?.activeDeadlineSeconds)
    const verifierTimeoutSeconds = Number(torghutVerifierWorkflow.match(/ARGO_SYNC_TIMEOUT_SECONDS=(\d+)/)?.[1])

    expect(timeoutSeconds).toBeGreaterThanOrEqual(migrationDeadlineSeconds + 900)
    expect(timeoutSeconds).toBeGreaterThanOrEqual(verifierTimeoutSeconds + 600)
  })

  it('retains post-deploy verification for every application promoted by the Torghut stage', () => {
    expect(torghutVerifierWorkflow).toContain("- 'argocd/applications/torghut-hyperliquid-runtime/**'")
    expect(torghutVerifierWorkflow).toContain('for app in torghut torghut-options torghut-hyperliquid-runtime; do')
    expect(torghutVerifierWorkflow).toContain('torghut-hyperliquid-runtime \\')
  })

  it('uses Kargo to write image and provenance data, never live Argo image overrides', () => {
    const stageMap = byName(stages)
    for (const stageName of expectedStageNames) {
      const stage = stageMap.get(stageName)
      const steps = stage?.spec?.promotionTemplate?.spec?.steps as Array<Record<string, any>>
      const serialized = JSON.stringify(stage)
      expect(serialized).toContain('commitFrom(vars.gitRepo).ID')
      expect(serialized).toContain('outputs.commit.commit')
      expect(serialized).not.toContain('updateTargetRevision')

      const imageUpdateSteps = steps.filter((step) => ['kustomize-set-image', 'yaml-update'].includes(step.uses))
      expect(imageUpdateSteps.length).toBeGreaterThan(0)
      for (const step of imageUpdateSteps) expect(step.config?.path).toMatch(/^\.\/out\//)
      for (const step of steps.filter((candidate) => candidate.uses === 'kustomize-set-image')) {
        for (const image of step.config?.images ?? []) {
          expect(image.digest).toContain('imageFrom(')
          expect(image.tag).toBeUndefined()
        }
      }

      const argocdStep = steps.find((step) => step.uses === 'argocd-update')
      for (const source of (argocdStep?.config?.apps ?? []).flatMap((app: Record<string, any>) => app.sources ?? [])) {
        expect(source.kustomize).toBeUndefined()
        expect(source.helm).toBeUndefined()
      }
    }

    expect(kustomization.resources).toContain('git-credentials.yaml')
    for (const manifest of [...warehouses, ...stages, project, projectConfig]) {
      expect(manifest.kind).not.toBe('Namespace')
    }
    expect(expectedStageNames).not.toContain('bayn')
    expect(expectedStageNames).not.toContain('sag')
    expect(expectedStageNames).not.toContain('torghut-notebook')
    expect(expectedStageNames).not.toContain('torghut-ta')
    expect(expectedStageNames).not.toContain('torghut-ws')
    expect(expectedStageNames).not.toContain('signal-publisher')
    expect(expectedStageNames).not.toContain('bilig-app')
    expect(stagesSource).not.toContain('#(')
    const expectYamlUpdate = (stageName: string, path: string, keys: string[]) => {
      const steps = stageMap.get(stageName)?.spec?.promotionTemplate?.spec?.steps as Array<Record<string, any>>
      const step = steps.find((candidate) => candidate.uses === 'yaml-update' && candidate.config?.path === path)
      expect(step).toBeDefined()
      expect(step?.config?.updates?.map((update: Record<string, any>) => update.key)).toEqual(
        expect.arrayContaining(keys),
      )
    }
    expectYamlUpdate('bumba', './out/argocd/applications/bumba/deployment.yaml', [
      'spec.template.spec.containers.0.env.6.value',
    ])
    expectYamlUpdate('jangar', './out/argocd/applications/jangar/deployment.yaml', [
      'spec.template.spec.containers.0.env.132.value',
      'spec.template.spec.containers.0.env.133.value',
      'spec.template.spec.containers.0.env.134.value',
      'spec.template.spec.containers.0.env.135.value',
      'spec.template.spec.containers.0.env.136.value',
    ])
    const jangarSteps = stageMap.get('jangar')?.spec?.promotionTemplate?.spec?.steps as Array<Record<string, any>>
    const jangarProofUpdate = jangarSteps.find(
      (step) => step.uses === 'yaml-update' && step.config?.path === './out/argocd/applications/jangar/deployment.yaml',
    )
    const jangarProofValues = Object.fromEntries(
      (jangarProofUpdate?.config?.updates ?? []).map((update: Record<string, any>) => [update.key, update.value]),
    )
    expect(jangarProofValues['spec.template.spec.containers.0.env.132.value']).toBe(
      "${{ quote(imageFrom(vars.imageRepo).Annotations['ai.proompteng.github-actions-run-id']) }}",
    )
    expect(jangarProofValues['spec.template.spec.containers.0.env.133.value']).toBe(
      "${{ quote(imageFrom(vars.imageRepo).Annotations['ai.proompteng.github-actions-build-conclusion']) }}",
    )
    for (const key of [
      'spec.template.spec.containers.0.env.2.value',
      'spec.template.spec.containers.0.env.3.value',
      'spec.template.spec.containers.0.env.135.value',
    ]) {
      expect(jangarProofValues[key]).toBe('${{ commitFrom(vars.gitRepo).ID }}')
    }
    expectYamlUpdate('agents', './out/argocd/applications/agents/values.yaml', [
      'controllers.image.repository',
      'controllers.image.tag',
      'controllers.image.digest',
      'controlPlane.env.vars.AGENTS_SOURCE_CI_RUN_ID',
      'controlPlane.env.vars.AGENTS_SOURCE_CI_CONCLUSION',
    ])
    const agentsSteps = stageMap.get('agents')?.spec?.promotionTemplate?.spec?.steps as Array<Record<string, any>>
    const agentsProofUpdate = agentsSteps.find(
      (step) => step.uses === 'yaml-update' && step.config?.path === './out/argocd/applications/agents/values.yaml',
    )
    const agentsProofValues = Object.fromEntries(
      (agentsProofUpdate?.config?.updates ?? []).map((update: Record<string, any>) => [update.key, update.value]),
    )
    expect(agentsProofValues['controlPlane.env.vars.AGENTS_SOURCE_CI_RUN_ID']).toBe(
      "${{ quote(imageFrom(vars.agentsControlPlaneImage).Annotations['ai.proompteng.github-actions-run-id']) }}",
    )
    expect(agentsProofValues['controlPlane.env.vars.AGENTS_SOURCE_CI_CONCLUSION']).toBe(
      "${{ quote(imageFrom(vars.agentsControlPlaneImage).Annotations['ai.proompteng.github-actions-build-conclusion']) }}",
    )
    for (const key of [
      'controlPlane.env.vars.AGENTS_SOURCE_HEAD_SHA',
      'controlPlane.env.vars.AGENTS_GITOPS_REVISION',
      'controlPlane.env.vars.AGENTS_SERVING_BUILD_COMMIT',
    ]) {
      expect(agentsProofValues[key]).toBe('${{ commitFrom(vars.gitRepo).ID }}')
    }
    expectYamlUpdate('torghut', './out/argocd/applications/torghut/knative-service.yaml', [
      'spec.template.spec.containers.0.env.179.value',
      'spec.template.spec.containers.0.env.180.value',
    ])
    expect(stagesSource).not.toContain('restartNonce')
    expect(stagesSource).not.toContain('restartedAt')
    expect(stagesSource).not.toContain('updateTimestamp')
    expect(analysisKustomization).toMatch(/digest: sha256:[0-9a-f]{64}/)
    expect(analysisKustomization).not.toContain('newTag:')
    expect(pullRequestWorkflow).toContain('analysis@sha256:[0-9a-f]{64}')
  })
})
