import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'

const productApplicationSet = readFileSync(
  new URL('../../../../../argocd/applicationsets/product.yaml', import.meta.url),
  'utf8',
)

test('Torghut keeps Knative metadata drift visible to Argo CD', () => {
  const start = productApplicationSet.indexOf('              - name: torghut\n')
  const end = productApplicationSet.indexOf('              - name: torghut-options\n', start)

  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)

  const torghutElement = productApplicationSet.slice(start, end)
  const ignoredPaths = new Set(
    torghutElement
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- /'))
      .map((line) => line.slice(2)),
  )
  for (const path of [
    '/metadata/annotations',
    '/metadata/labels',
    '/spec/template/metadata/annotations',
    '/spec/template/metadata/labels',
  ]) {
    expect(ignoredPaths.has(path)).toBeFalse()
  }

  expect(ignoredPaths.has('/spec/template/metadata/annotations/client.knative.dev~1updateTimestamp')).toBeTrue()
  expect(ignoredPaths.has('/metadata/annotations/serving.knative.dev~1lastModifier')).toBeTrue()
  expect(ignoredPaths.has('/spec/template/metadata/creationTimestamp')).toBeTrue()
  expect(ignoredPaths.has('/spec/template/spec/containers/0/readinessProbe')).toBeTrue()
})
