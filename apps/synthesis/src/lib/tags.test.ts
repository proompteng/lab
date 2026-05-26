import { describe, expect, test } from 'vitest'

import { deriveTopicTagsFromItemContent, normalizeTopicTags } from './tags'

describe('synthesis tags', () => {
  test('normalizes explicit tags and removes empty chrome', () => {
    expect(normalizeTopicTags([' Semis ', '', '#AI Agents', 'semis'])).toEqual(['semis', 'ai-agents'])
  })

  test('derives useful display tags from item content when explicit tags are missing', () => {
    expect(
      deriveTopicTagsFromItemContent({
        title: 'NVDA HBM packaging constraints move into inference systems',
        synthesis:
          'Semiconductor packaging and inference deployment notes make this a useful chip supply-chain signal.',
        takeaways: ['watch HBM allocation for model deployment'],
        topicTags: [],
      }),
    ).toEqual(expect.arrayContaining(['semis', 'machine-learning']))
  })
})
