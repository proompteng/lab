import { describe, expect, test } from 'bun:test'

import {
  assertMermaidResourcePolicy,
  assertMermaidStyleFields,
  assertMermaidSpecializedResources,
  isSupportedMermaidDiagram,
} from './mermaid-resources'

describe('Mermaid resource policy', () => {
  test('accepts only formats with audited pre-layout resource checks', () => {
    for (const type of ['flowchart-v2', 'sequence', 'classDiagram', 'block'])
      expect(isSupportedMermaidDiagram(type)).toBe(true)
    for (const type of ['stateDiagram', 'pie', 'gantt', 'unknown']) expect(isSupportedMermaidDiagram(type)).toBe(false)
  })

  test('checks closure-backed block styles, sequence paint and sequence icons', () => {
    expect(() =>
      assertMermaidSpecializedResources({ getBlocksFlat: () => [{ styles: ['fill:url(/remote.svg)'] }] }),
    ).toThrow()
    expect(() =>
      assertMermaidSpecializedResources({
        LINETYPE: { RECT_START: 22 },
        getMessages: () => [{ type: 22, message: 'url(/remote.svg)' }],
      }),
    ).toThrow()
    expect(() =>
      assertMermaidSpecializedResources({
        getActors: () => new Map([['Alice', { properties: { icon: '/remote.svg' } }]]),
      }),
    ).toThrow('Diagram images are disabled')
    expect(() =>
      assertMermaidSpecializedResources({
        getBlocksFlat: () => [{ label: 'URL(value)', styles: ['fill:#fff'] }],
        LINETYPE: { RECT_START: 22 },
        getMessages: () => [
          { type: 22, message: 'rgb(230, 230, 250)' },
          { type: 0, message: 'call src(input)' },
        ],
        getActors: () => new Map([['Alice', { properties: {} }]]),
      }),
    ).not.toThrow()
  })

  test.each([
    'filter:url(/api/tengri/events)',
    'fill:URL(https://example.com/image.svg)',
    'filter:url("//example.com/filter.svg#filter")',
    "filter:url('/api/tengri/events')",
    String.raw`filter:u\72l(/api/tengri/events)`,
    String.raw`filter:\75 rl(/api/tengri/events)`,
    String.raw`filter:u\r\l(/api/tengri/events)`,
    'filter:u/**/rl(/api/tengri/events)',
    'filter:u#114;l(/api/tengri/events)',
    'filter:u&#x72;l(/api/tengri/events)',
    String.raw`filter:\u0075rl(/api/tengri/events)`,
    String.raw`filter:\x75rl(/api/tengri/events)`,
    'background:image-set("/api/tengri/events" 1x)',
    '@import "/api/tengri/events"',
    'filter:url(#local) url(/api/tengri/events)',
    'filter:url()',
  ])('rejects fetching or ambiguous CSS: %s', (value) => {
    expect(() => assertMermaidResourcePolicy(value)).toThrow('Diagram resource URLs are disabled')
  })

  test.each([
    'flowchart LR\nA --> B',
    'fill:#fff;stroke:rgb(1, 2, 3)',
    'marker-end="url(#tengri-mermaid-arrow)"',
    "filter:url('#local')",
    'filter:URL( "#local" )',
    String.raw`marker-end:url(\23 local)`,
  ])('preserves ordinary styles and fragment references: %s', (value) => {
    expect(() => assertMermaidResourcePolicy(value)).not.toThrow()
  })

  test('ignores ordinary labels and members while checking parsed style fields', () => {
    const data = {
      nodes: [{ label: 'Parse URL(value)', members: ['src(input)', 'image(input)'], styles: ['fill:#fff'] }],
      classes: new Map([['A', { label: 'image(value)', textStyles: ['fill:#fff'] }]]),
    }
    expect(() => assertMermaidStyleFields(data)).not.toThrow()
    data.nodes[0].styles.push('filter:url(/remote.svg)')
    expect(() => assertMermaidStyleFields(data)).toThrow('Diagram resource URLs are disabled')
  })

  test('checks style maps, edge styles and configuration values before layout', () => {
    for (const data of [
      new Map([['remote', { styles: ['filter:url(/remote.svg)'] }]]),
      { edges: [{ style: 'stroke:url(/remote.svg)' }] },
      { config: { themeCSS: '.node { filter:url(/remote.svg) }' } },
    ])
      expect(() => assertMermaidStyleFields(data)).toThrow('Diagram resource URLs are disabled')
  })
})
