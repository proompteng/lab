import { appendFileSync, existsSync } from 'node:fs'

type TestPlan = { kind: 'unit'; files: string[]; shards: [1] } | { kind: 'full'; files: []; shards: [1, 2, 3, 4] }

export const isUnitTest = (path: string): boolean =>
  /^services\/bayn\/(src|tools)\/[^\n\r]+\.test\.ts$/.test(path) &&
  !path.endsWith('.integration.test.ts') &&
  path !== 'services/bayn/src/shadow-decision.test.ts'

export const planTests = (files: readonly string[], exactRevision: boolean): TestPlan =>
  !exactRevision && files.length > 0 && files.every(isUnitTest)
    ? { kind: 'unit', files: files.map((path) => path.slice('services/bayn/'.length)), shards: [1] }
    : { kind: 'full', files: [], shards: [1, 2, 3, 4] }

if (import.meta.main) {
  const files: unknown = JSON.parse(process.env['CHANGED_FILES'] ?? '[]')
  if (!Array.isArray(files) || !files.every((file): file is string => typeof file === 'string'))
    throw Error('CHANGED_FILES must be a JSON string array')
  const plan = planTests(
    files,
    process.env['GITHUB_EVENT_NAME'] !== 'pull_request' || files.some((file) => !existsSync(file)),
  )
  const integration = process.env['BAYN_RELEVANT'] === 'true' && plan.kind === 'full'
  const output = process.env['GITHUB_OUTPUT']
  if (output === undefined || output.length === 0) throw Error('GITHUB_OUTPUT is required')
  appendFileSync(
    output,
    `integration=${integration}\nunit_files=${JSON.stringify(plan.files)}\nunit_shards=${JSON.stringify(plan.shards)}\nunit_shard_count=${plan.shards.length}\n`,
  )
}
