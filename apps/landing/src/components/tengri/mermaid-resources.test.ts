import { describe, expect, test } from 'bun:test'

import { assertMermaidResourcePolicy } from './mermaid-resources'

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
})
