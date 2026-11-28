import { readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { compileConnectors, type ConnectorRegistration } from './onboarding'

const root = new URL('../../', import.meta.url)
const read = (path: string) => readFile(new URL(path, root), 'utf8')
const json = async (path: string) => JSON.parse(await read(path))
const files = (await readdir(new URL('./connectors/', import.meta.url))).filter((file) => file.endsWith('.ts')).sort()
const registrations: ConnectorRegistration[] = await Promise.all(
  files.map(async (file) => (await import(`./connectors/${file}`)).default),
)
const result = compileConnectors(registrations, {
  policies: await json('services/ofz/platform/policies.base.json'),
  services: await json('services/ofz/platform/services.base.json'),
  schema: await read('services/ofz/platform/schema.base.zed'),
})
const opencode = await json('argocd/applications/opencode/opencode.json')
opencode.permissions = [
  ...(opencode.permissions ?? []).filter((rule: { action: string }) => !rule.action.startsWith('relay_')),
  ...result.approvals,
]
const outputs = {
  'argocd/applications/relay/config.json': result.relay,
  'services/ofz/platform/policies.json': result.policies,
  'services/ofz/platform/services.json': result.services,
  'argocd/applications/opencode/opencode.json': opencode,
}
const check = process.argv.includes('--check')
for (const [path, value] of Object.entries(outputs)) {
  if (check) {
    if (JSON.stringify(await json(path)) !== JSON.stringify(value))
      throw new Error(`Registration drift: ${path}; run bun services/relay/generate.ts`)
  } else await writeFile(new URL(path, root), JSON.stringify(value, null, 2) + '\n')
}
const schemaPath = 'services/ofz/platform/schema.zed'
if (check) {
  if ((await read(schemaPath)) !== result.schema) throw new Error(`Registration drift: ${schemaPath}`)
} else await writeFile(new URL(schemaPath, root), result.schema)
if (!check) {
  const formatter = Bun.spawn(['bunx', 'oxfmt', ...Object.keys(outputs)], {
    cwd: fileURLToPath(root),
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (await formatter.exited) throw new Error('Generated registration formatting failed')
}
