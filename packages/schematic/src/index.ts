import { relative } from 'node:path'
import { cancel, confirm, intro, isCancel, note, outro, select, spinner, text } from '@clack/prompts'
import { kebabCase } from 'change-case'
import kleur from 'kleur'
import { z } from 'zod'
import { writeFiles } from './fs'
import { buildTanstackStartService } from './templates/tanstack/create-service'
import type { TanstackServiceOptions } from './templates/tanstack/types'

const nameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use kebab-case (letters, numbers, dashes)')

const promptName = async (initial?: string) => {
  const answer = await text({
    message: 'Service name',
    initialValue: initial,
    validate: (value) => {
      const parsed = nameSchema.safeParse(kebabCase(value ?? ''))
      return parsed.success ? undefined : parsed.error.issues[0]?.message
    },
  })

  if (isCancel(answer)) cancel('Aborted')
  const normalized = typeof answer === 'string' ? answer : String(answer ?? '')
  return kebabCase(normalized.trim())
}

export type CliOptions = {
  dryRun?: boolean
  force?: boolean
  type?: 'tanstack-start'
  name?: string
}

export const createSigintHandler = (
  onCancel: (reason?: string) => void = cancel,
  onExit: (code?: number) => never = process.exit,
) => {
  const handler = () => {
    onCancel('Aborted')
    onExit(1)
  }
  process.once('SIGINT', handler)
  return () => process.off('SIGINT', handler)
}

const clean = (value: string | symbol | null | undefined) => (typeof value === 'string' ? value : '')

export const runCli = async (opts: CliOptions = {}) => {
  intro(kleur.bold('schematic'))

  const detachSigint = createSigintHandler()

  const name = opts.name ? kebabCase(opts.name) : await promptName()

  const type =
    opts.type ||
    ((await select({
      message: 'What do you want to scaffold?',
      options: [{ value: 'tanstack-start', label: 'TanStack Start (Bun, Tailwind v4, @proompteng/design)' }],
      initialValue: 'tanstack-start',
    })) as 'tanstack-start')

  if (isCancel(type)) cancel('Aborted')

  const enablePostgres = await confirm({
    message: 'Add CloudNativePG Postgres manifest + env wiring?',
    initialValue: true,
  })
  if (isCancel(enablePostgres)) cancel('Aborted')

  const enableRedis = await confirm({
    message: 'Add Redis (opstree operator) manifest + env wiring?',
    initialValue: false,
  })
  if (isCancel(enableRedis)) cancel('Aborted')

  const exposure = (await select({
    message: 'Traffic exposure',
    options: [
      {
        value: 'external-dns',
        label: 'External DNS + DomainMapping (public)',
        hint: 'uses <name>.proompteng.ai unless overridden',
      },
      {
        value: 'tailscale',
        label: 'Private Tailscale LoadBalancer',
        hint: 'tailscale.com/hostname annotation + cluster-local Knative',
      },
    ],
    initialValue: 'external-dns',
  })) as 'external-dns' | 'tailscale'
  if (isCancel(exposure)) cancel('Aborted')

  const customize = await confirm({
    message: 'Customize domain/registry/namespace/CI/Argo/scripts?',
    initialValue: false,
  })
  if (isCancel(customize)) cancel('Aborted')

  let domain = exposure === 'external-dns' ? `${name}.proompteng.ai` : undefined
  let tailscaleHostname = exposure === 'tailscale' ? name : undefined
  let namespace = name
  let imageRegistry = 'registry.ide-newton.ts.net'
  let includeCi = true
  let includeArgo = true
  let includeScripts = true

  if (customize) {
    if (exposure === 'external-dns') {
      const domainAnswer = await text({
        message: 'Custom domain (defaults to <name>.proompteng.ai)',
        initialValue: domain,
      })
      if (isCancel(domainAnswer)) cancel('Aborted')
      domain = clean(domainAnswer).trim() || domain
    }

    if (exposure === 'tailscale') {
      const tailAnswer = await text({
        message: 'Tailscale hostname',
        initialValue: tailscaleHostname,
      })
      if (isCancel(tailAnswer)) cancel('Aborted')
      tailscaleHostname = clean(tailAnswer).trim() || tailscaleHostname
    }

    const nsAnswer = await text({
      message: 'Kubernetes namespace',
      initialValue: namespace,
    })
    if (isCancel(nsAnswer)) cancel('Aborted')
    namespace = clean(nsAnswer).trim() || namespace

    const registryAnswer = await text({
      message: 'Image registry',
      initialValue: imageRegistry,
      validate: (value) => (!value?.trim() ? 'Registry is required' : undefined),
    })
    if (isCancel(registryAnswer)) cancel('Aborted')
    imageRegistry = clean(registryAnswer).trim() || imageRegistry

    const includeCiAnswer = await confirm({
      message: 'Include GitHub Actions CI + docker build workflows?',
      initialValue: includeCi,
    })
    if (isCancel(includeCiAnswer)) cancel('Aborted')
    includeCi = Boolean(includeCiAnswer)

    const includeArgoAnswer = await confirm({
      message: 'Generate ArgoCD/Knative kustomize stack?',
      initialValue: includeArgo,
    })
    if (isCancel(includeArgoAnswer)) cancel('Aborted')
    includeArgo = Boolean(includeArgoAnswer)

    const includeScriptsAnswer = await confirm({
      message: 'Create build/deploy scripts under packages/scripts?',
      initialValue: includeScripts,
    })
    if (isCancel(includeScriptsAnswer)) cancel('Aborted')
    includeScripts = Boolean(includeScriptsAnswer)
  }

  const s = spinner()
  s.start('Generating files')

  const generatorOptions: TanstackServiceOptions = {
    name,
    description: undefined,
    owner: undefined,
    exposure,
    enablePostgres: Boolean(enablePostgres),
    enableRedis: Boolean(enableRedis),
    includeCi,
    includeArgo,
    includeScripts,
    domain,
    tailscaleHostname,
    namespace,
    imageRegistry,
  }

  const files =
    type === 'tanstack-start'
      ? await buildTanstackStartService(generatorOptions)
      : (() => {
          throw new Error(`Unsupported template: ${String(type)}`)
        })()

  try {
    await writeFiles(files, { dryRun: opts.dryRun, force: opts.force })
    s.stop('Scaffold ready')
  } catch (error) {
    s.stop('Failed')
    if (error instanceof Error) {
      throw error
    }
    throw new Error(String(error))
  }

  const created = files.map((f) => relative(process.cwd(), f.path)).sort()
  note(created.join('\n'), 'Files')

  note(
    `Next steps:\n- bunx oxfmt --check services/${name} packages/scripts/src/${name} argocd/applications/${name} || true\n- bun install --frozen-lockfile\n- cd services/${name} && bun dev\n- configure ArgoCD ApplicationSet entry if needed`,
    'Tips',
  )

  outro('Done')

  detachSigint()
}

if (import.meta.main) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
