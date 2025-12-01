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
    message: 'Service name (kebab-case)',
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

const clean = (value: string | symbol | null | undefined) => (typeof value === 'string' ? value : '')

export const runCli = async (opts: CliOptions = {}) => {
  intro(kleur.bold('schematic'))

  const name = opts.name ? kebabCase(opts.name) : await promptName()

  const type =
    opts.type ||
    ((await select({
      message: 'What do you want to scaffold?',
      options: [{ value: 'tanstack-start', label: 'TanStack Start (Bun, Tailwind v4, shadcn/ui)' }],
      initialValue: 'tanstack-start',
    })) as 'tanstack-start')

  if (isCancel(type)) cancel('Aborted')

  const description = await text({
    message: 'Short description (optional)',
    placeholder: 'Service purpose',
  })
  if (isCancel(description)) cancel('Aborted')

  const owner = await text({ message: 'Owner (team/handle, optional)' })
  if (isCancel(owner)) cancel('Aborted')

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

  const includeCi = await confirm({
    message: 'Include GitHub Actions CI + docker build workflows?',
    initialValue: true,
  })
  if (isCancel(includeCi)) cancel('Aborted')

  const includeArgo = await confirm({ message: 'Generate ArgoCD/Knative kustomize stack?', initialValue: true })
  if (isCancel(includeArgo)) cancel('Aborted')

  const includeScripts = await confirm({
    message: 'Create build/deploy scripts under packages/scripts?',
    initialValue: true,
  })
  if (isCancel(includeScripts)) cancel('Aborted')

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

  const domain = await text({
    message: 'Custom domain (optional, defaults to <name>.proompteng.ai)',
    initialValue: `${name}.proompteng.ai`,
  })
  if (isCancel(domain)) cancel('Aborted')

  const tailscaleHostname = await text({
    message: 'Tailscale hostname (only used if tailscale exposure)',
    initialValue: name,
  })
  if (isCancel(tailscaleHostname)) cancel('Aborted')

  const namespace = await text({
    message: 'Kubernetes namespace (optional)',
    initialValue: name,
  })
  if (isCancel(namespace)) cancel('Aborted')

  const imageRegistry = await text({
    message: 'Image registry',
    initialValue: 'registry.ide-newton.ts.net',
    validate: (value) => (!value?.trim() ? 'Registry is required' : undefined),
  })
  if (isCancel(imageRegistry)) cancel('Aborted')

  const s = spinner()
  s.start('Generating files')

  const generatorOptions: TanstackServiceOptions = {
    name,
    description: clean(description).trim() || undefined,
    owner: clean(owner).trim() || undefined,
    exposure,
    enablePostgres: Boolean(enablePostgres),
    enableRedis: Boolean(enableRedis),
    includeCi: Boolean(includeCi),
    includeArgo: Boolean(includeArgo),
    includeScripts: Boolean(includeScripts),
    domain: clean(domain).trim() || undefined,
    tailscaleHostname: clean(tailscaleHostname).trim() || undefined,
    namespace: clean(namespace).trim() || undefined,
    imageRegistry: clean(imageRegistry).trim(),
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
    `Next steps:\n- bunx biome check services/${name} packages/scripts/src/${name} argocd/applications/${name} || true\n- bun install --frozen-lockfile\n- cd services/${name} && bun dev\n- configure ArgoCD ApplicationSet entry if needed`,
    'Tips',
  )

  outro('Done')
}

if (import.meta.main) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
