import { expect, test } from 'bun:test'

import metadata from '../../package.json'
import { projectTemplates } from '../../src/bin/temporal-bun'

test('scaffolding pairs the installed SDK with Effect 4 and its Bun type environment', () => {
  const templates = projectTemplates('test-worker')
  const manifest = JSON.parse(templates.find((template) => template.path === 'package.json')!.contents)
  const config = JSON.parse(templates.find((template) => template.path === 'tsconfig.json')!.contents)
  expect(manifest.dependencies['@proompteng/temporal-bun-sdk']).toBe(`^${metadata.version}`)
  expect(manifest.dependencies.effect).toBe('4.0.0')
  expect(config.compilerOptions.types).toEqual(['bun-types'])
  expect(config.compilerOptions.lib).toEqual(['esnext', 'dom'])
})
