import { describe, expect, it } from 'bun:test'
import { buildMessageContent, buildThreadName, stripBotMention } from '../utils'

describe('utils', () => {
  it('stripBotMention removes bot mention formats', () => {
    expect(stripBotMention('hi <@123>', '123')).toBe('hi')
    expect(stripBotMention('hi <@!123> there', '123')).toBe('hi  there'.trim())
  })

  it('buildThreadName uses prefix and trims content', () => {
    const name = buildThreadName({ content: '  hello   world  ', botId: null, prefix: 'Oirat' })
    expect(name).toBe('Oirat - hello world')
  })

  it('buildThreadName falls back when content is only mention', () => {
    const name = buildThreadName({ content: '<@123>', botId: '123', prefix: 'Oirat' })
    expect(name).toBe('Oirat - conversation')
  })

  it('buildThreadName enforces length limit', () => {
    const long = 'x'.repeat(200)
    const name = buildThreadName({ content: long, botId: null, prefix: 'Oirat' })
    expect(name.length).toBeLessThanOrEqual(90)
  })

  it('buildMessageContent removes mention and appends attachments', () => {
    const content = buildMessageContent({
      content: '<@123> hello',
      cleanContent: 'hello',
      botId: '123',
      attachmentUrls: ['https://example.com/a.png'],
    })
    expect(content).toContain('hello')
    expect(content).toContain('Attachments:')
    expect(content).toContain('https://example.com/a.png')
  })

  it('buildMessageContent falls back to clean content', () => {
    const content = buildMessageContent({
      content: '<@123>',
      cleanContent: 'hello',
      botId: '123',
      attachmentUrls: [],
    })
    expect(content).toBe('hello')
  })
})
