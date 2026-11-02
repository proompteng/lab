import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import YAML from 'yaml'

const source = 'a'.repeat(40)
const schema = '1'.repeat(64)
const prefix = 'registry.ide-newton.ts.net/lab/'
const services = ['ofz', 'tengri', 'nanoagent', 'proompteng']
const read = (path: string) => readFileSync(resolve(import.meta.dir, '../../../..', path), 'utf8')
const warehouses = YAML.parseAllDocuments(read('argocd/applications/kargo/warehouses.yaml'))
const warehouse = warehouses.find((document) => document.getIn(['metadata', 'name']) === 'ofz')
const expression = warehouse?.getIn(['spec', 'freightCreationCriteria', 'expression'])
if (typeof expression !== 'string') throw new Error('Ofz release cohort requires promotion criteria')

type Artifact = { Tag: string; Annotations: Record<string, string> }

function artifacts(): Record<string, Artifact> {
  return Object.fromEntries(
    services.map((service) => [
      prefix + service,
      {
        Tag: `kargo-sha-${source}${service === 'ofz' ? '-run-17' : ''}`,
        Annotations: {
          'org.opencontainers.image.source': 'https://github.com/proompteng/lab',
          'org.opencontainers.image.revision': source,
          'ai.proompteng.github-actions-run-id': '17',
          'ai.proompteng.github-actions-build-conclusion': 'success',
          'ai.proompteng.tengri-schema': schema,
        },
      },
    ]),
  )
}

function eligible(images: ReturnType<typeof artifacts>) {
  return runInNewContext(expression, { imageFrom: (repository: string) => images[repository], nil: undefined }) === true
}

describe('Tengri ordered release cohort', () => {
  it('discovers all four immutable images in one automatic Warehouse', () => {
    expect(eligible(artifacts())).toBe(true)
    expect(warehouse?.getIn(['spec', 'freightCreationPolicy'])).toBe('Automatic')
    const subscriptions = warehouse?.getIn(['spec', 'subscriptions'])
    expect(YAML.isSeq(subscriptions)).toBe(true)
    if (!YAML.isSeq(subscriptions)) throw new Error('Missing image subscriptions')
    expect(
      subscriptions.items.map((item) => (YAML.isMap(item) ? item.getIn(['image', 'repoURL']) : undefined)),
    ).toEqual(services.map((service) => prefix + service))
    for (const name of ['tengri', 'proompteng']) {
      expect(warehouses.some((document) => document.getIn(['metadata', 'name']) === name)).toBe(false)
    }
  })

  it('rejects every incomplete schema, different source and unqualified image cohort', () => {
    for (const service of services) {
      for (const mismatch of ['2'.repeat(64), '', undefined]) {
        const images = artifacts()
        if (mismatch === undefined) delete images[prefix + service].Annotations['ai.proompteng.tengri-schema']
        else images[prefix + service].Annotations['ai.proompteng.tengri-schema'] = mismatch
        expect(eligible(images)).toBe(false)
      }
      const images = artifacts()
      images[prefix + service].Tag = `kargo-sha-${'b'.repeat(40)}${service === 'ofz' ? '-run-17' : ''}`
      images[prefix + service].Annotations['org.opencontainers.image.revision'] = 'b'.repeat(40)
      expect(eligible(images)).toBe(false)
      const wrongRepository = artifacts()
      wrongRepository[prefix + service].Annotations['org.opencontainers.image.source'] = 'https://example.com/other'
      expect(eligible(wrongRepository)).toBe(false)
    }
    const failed = artifacts()
    failed[prefix + 'ofz'].Annotations['ai.proompteng.github-actions-build-conclusion'] = 'failure'
    expect(eligible(failed)).toBe(false)
  })

  it('requires the migration and controller rollout before the web consumer can promote', () => {
    const stages = YAML.parseAllDocuments(read('argocd/applications/kargo/stages.yaml'))
    for (const [name, upstream] of [
      ['ofz', undefined],
      ['tengri', 'ofz'],
      ['proompteng', 'tengri'],
    ]) {
      const stage = stages.find((document) => document.getIn(['metadata', 'name']) === name)
      const request = stage?.getIn(['spec', 'requestedFreight', 0])
      if (!YAML.isMap(request)) throw new Error(`Missing ${name} Freight request`)
      expect(request.getIn(['origin', 'name'])).toBe('ofz')
      expect(request.getIn(['sources', 'direct'])).toBe(upstream ? undefined : true)
      expect(request.getIn(['sources', 'autoPromotionOptions', 'selectionPolicy'])).toBe(
        upstream ? 'MatchUpstream' : 'NewestFreight',
      )
      expect(request.getIn(['sources', 'stages', 0])).toBe(upstream)
      const steps = stage?.getIn(['spec', 'promotionTemplate', 'spec', 'steps'])
      if (!YAML.isSeq(steps)) throw new Error(`Missing ${name} promotion steps`)
      const last = steps.items.at(-1)
      expect(YAML.isMap(last) ? last.get('uses') : undefined).toBe('argocd-update')
    }
  })

  it('publishes every component on the same production inputs without enabling unrelated product builds', () => {
    const ofz = YAML.parseDocument(read('.github/workflows/ofz.yaml'))
    const tengri = YAML.parseDocument(read('.github/workflows/tengri-images.yml'))
    const product = YAML.parseDocument(read('.github/workflows/product-nix-images.yml'))
    const ofzPaths = ofz.getIn(['on', 'push', 'paths'])
    const tengriPaths = tengri.getIn(['on', 'push', 'paths'])
    if (!YAML.isSeq(ofzPaths) || !YAML.isSeq(tengriPaths)) throw new Error('Missing cohort production triggers')
    expect(tengriPaths.toJSON()).toEqual(ofzPaths.toJSON())
    const steps = product.getIn(['jobs', 'changes', 'steps'])
    if (!YAML.isSeq(steps)) throw new Error('Missing product filters')
    const filter = steps.items.find((item) => YAML.isMap(item) && item.get('id') === 'filter')
    const text = YAML.isMap(filter) ? filter.getIn(['with', 'filters']) : undefined
    if (typeof text !== 'string') throw new Error('Missing product filter source')
    const filters = YAML.parseDocument(text)
    expect(filters.getIn(['proompteng']).toJSON()).toEqual(ofzPaths.toJSON())
    const pushPaths = product.getIn(['on', 'push', 'paths'])
    if (!YAML.isSeq(pushPaths)) throw new Error('Missing product production triggers')
    for (const path of ofzPaths.toJSON()) expect(pushPaths.toJSON()).toContain(path)
    for (const name of ['app', 'synthesis', 'docs']) {
      expect(filters.getIn([name]).toJSON()).not.toContain('services/ofz/**')
      expect(filters.getIn([name]).toJSON()).not.toContain('services/nanoagent/**')
    }
  })
})
