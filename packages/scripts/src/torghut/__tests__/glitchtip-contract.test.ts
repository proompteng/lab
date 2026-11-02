import { readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'
import YAML from 'yaml'

const root = new URL('../../../../../', import.meta.url)
const read = (path: string) => YAML.parseDocument(readFileSync(new URL(path, root), 'utf8'))

test('Dorvud error ingestion preserves Kargo commit bindings and credential references', () => {
  const stage = YAML.parseAllDocuments(
    readFileSync(new URL('argocd/applications/kargo/stages.yaml', root), 'utf8'),
  ).find((document) => document.getIn(['metadata', 'name']) === 'torghut')
  if (stage === undefined) throw new Error('Torghut Kargo Stage is missing')
  const steps = stage.getIn(['spec', 'promotionTemplate', 'spec', 'steps'], true)
  if (!YAML.isSeq(steps)) throw new Error('Torghut promotion steps must be a sequence')
  const services = new Map([
    ['argocd/applications/torghut/ws/deployment.yaml', 'WS'],
    ['argocd/applications/torghut/ta/flinkdeployment.yaml', 'TA'],
    ['argocd/applications/torghut/market-data-archive/flinkdeployment.yaml', 'TA'],
  ])
  let verified = 0
  for (const step of steps.items) {
    if (!YAML.isMap(step) || step.get('uses') !== 'yaml-update') continue
    const rawPath = step.getIn(['config', 'path'])
    if (typeof rawPath !== 'string') continue
    const path = rawPath.replace(/^\.\/out\//, '')
    const service = services.get(path)
    if (service === undefined) continue
    const updates = step.getIn(['config', 'updates'], true)
    if (!YAML.isSeq(updates)) throw new Error('Kargo metadata updates must be a sequence')
    const manifest = read(path)
    for (const update of updates.items) {
      if (!YAML.isMap(update)) continue
      const key = update.get('key')
      const value = update.get('value')
      if (typeof key !== 'string' || typeof value !== 'string' || !/\.env\.\d+\.value$/.test(key)) continue
      const target = key
        .replace(/\.value$/, '.name')
        .split('.')
        .map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      const name = `TORGHUT_${service}_${value.includes('trimPrefix(') ? 'COMMIT' : 'VERSION'}`
      expect(manifest.getIn(target), `${path}: ${key} must update ${name}`).toBe(name)
      const credential = target.slice(0, -1).concat('valueFrom')
      expect(manifest.getIn(credential), `${path}: metadata must not overwrite a credential`).toBeUndefined()
      verified += 1
    }
  }
  expect(verified).toBe(6)
})
