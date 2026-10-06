import { describe, expect, test } from 'bun:test'

import { assertMermaidResourcePolicy, assertMermaidStyleFields } from './mermaid-resources'

describe('Mermaid resource policy', () => {
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
