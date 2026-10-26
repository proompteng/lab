import { describe, expect, test } from 'bun:test'
import type { TengriCodexEvent } from '@/lib/tengri/types'
import {
  codexAsyncQuestionRequest,
  codexEventAsyncQuestionRequest,
  codexAsyncQuestionReply,
  codexAsyncQuestionReplies,
  codexAsyncQuestionReplyDisplayText,
  codexAnsweredAsyncQuestions,
} from './codex-async-questions'
import { codexQuestionResponse } from './codex-question-model'

const item = {
  id: 'call_123',
  type: 'agentMessage',
  text: '',
  delivery: 'async',
  questions: [
    { title: 'Which environment?', options: [' Staging ', 'Production'] },
    { title: 'Any notes?', options: null },
  ],
}
const event: TengriCodexEvent = {
  sequence: 1,
  kind: 'assistant-text',
  method: 'item/completed',
  threadId: 'thread-1',
  turnId: 'turn-1',
  itemId: item.id,
  text: '',
  approvalId: '',
  rawJson: JSON.stringify({ params: { item } }),
}

describe('Codex async questions', () => {
  test('decodes native question messages with stable desktop reply identities and optional choices', () => {
    const request = codexAsyncQuestionRequest(item)!
    expect(codexEventAsyncQuestionRequest(event)).toEqual(request)
    expect(request.fields.map((field) => [field.key, field.freeText, field.defaultValue])).toEqual([
      ['["request_user_input_async","call_123",0]', true, ' Staging '],
      ['["request_user_input_async","call_123",1]', true, ''],
    ])
    expect(codexEventAsyncQuestionRequest({ ...event, kind: 'tool-output' })).toBeNull()
    expect(codexEventAsyncQuestionRequest({ ...event, rawJson: '{' })).toBeNull()
  })

  test('encodes selected and free-text answers using the native desktop message envelope', () => {
    const request = codexAsyncQuestionRequest(item)!
    const text = codexAsyncQuestionReply(
      request,
      codexQuestionResponse(request, { q0: ' Staging ', q1: 'Keep my draft\nand files.' }),
    )
    expect(codexAsyncQuestionReplies(text)).toEqual([
      { questionItemId: request.fields[0].key, question: 'Which environment?', answer: ' Staging ' },
      { questionItemId: request.fields[1].key, question: 'Any notes?', answer: 'Keep my draft\nand files.' },
    ])
    expect(codexAsyncQuestionReplyDisplayText(text)).toBe(
      '> Which environment?\n\n Staging \n\n> Any notes?\n\nKeep my draft\nand files.',
    )
    expect(() => codexAsyncQuestionReply(request, { answers: {} })).toThrow()
    expect(() => codexAsyncQuestionReply(request, { action: 'accept' })).toThrow()
  })

  test('recognizes single desktop replies without interpreting quoted or malformed envelopes', () => {
    const response = { questionItemId: 'one', question: 'First?', answer: 'Yes' }
    const text = `<send_user_message_question_reply>${JSON.stringify(response)}</send_user_message_question_reply>`
    expect(codexAsyncQuestionReplies(text)).toEqual([response])
    expect(codexAsyncQuestionReplies(`# Context from my IDE setup:\nFiles\n## My request for Codex:\n${text}`)).toEqual(
      [response],
    )
    for (const bad of [
      `Quoted: ${text}`,
      `${text} trailing`,
      '<send_user_message_question_reply>[]</send_user_message_question_reply>',
      '<send_user_message_question_reply>{</send_user_message_question_reply>',
    ]) {
      expect(codexAsyncQuestionReplies(bad)).toEqual([])
      expect(codexAsyncQuestionReplyDisplayText(bad)).toBe(bad)
    }
  })

  test('retires only the identified answer and supersedes older questions on an ordinary follow-up', () => {
    const request = codexAsyncQuestionRequest(item)!
    const first = request.fields[0].key
    const second = request.fields[1].key
    const questionItem = { kind: 'assistant-text', text: '', questionRequest: request }
    const answer = `<send_user_message_question_reply>${JSON.stringify({ questionItemId: first, question: request.fields[0].title, answer: 'Staging' })}</send_user_message_question_reply>`
    expect([...codexAnsweredAsyncQuestions([questionItem, { kind: 'user-message', text: answer }])]).toEqual([first])
    expect([
      ...codexAnsweredAsyncQuestions([
        questionItem,
        { kind: 'user-message', text: 'Continue with the current setup.' },
      ]),
    ]).toEqual([first, second])
    expect(codexAnsweredAsyncQuestions([{ kind: 'user-message', text: 'Earlier prompt' }, questionItem]).size).toBe(0)
  })

  test('bounds the encoded message before attempting answer delivery', () => {
    const request = codexAsyncQuestionRequest({
      ...item,
      questions: Array.from({ length: 10 }, () => ({ title: 'Question' })),
    })!
    expect(() =>
      codexAsyncQuestionReply(
        request,
        codexQuestionResponse(request, Object.fromEntries(request.fields.map((_, i) => [`q${i}`, '🙂'.repeat(2000)]))),
      ),
    ).toThrow('64 KiB')
  })

  test('rejects empty and oversized question payloads without manufacturing controls', () => {
    for (const questions of [
      [],
      [{ title: ' ' }],
      [{ title: 'Choose', options: [] }],
      [{ title: 'Choose', options: [''] }],
      [{ title: 'x'.repeat(4097) }],
      Array.from({ length: 11 }, () => ({ title: 'Question' })),
    ])
      expect(codexAsyncQuestionRequest({ ...item, questions })).toBeNull()
  })
})
