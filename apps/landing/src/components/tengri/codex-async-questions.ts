import { z } from 'zod'
import type { TengriCodexEvent } from '@/lib/tengri/types'
import type { TengriCodexInputResponse } from '@/lib/tengri/codex-input'
import { MAX_CODEX_PROMPT_BYTES } from '@/lib/tengri/schemas'
import type { QuestionRequest } from './codex-question-model'

const message = z.object({
  id: z.string().min(1).max(512),
  type: z.literal('agentMessage'),
  questions: z
    .array(
      z.object({
        title: z
          .string()
          .min(1)
          .max(4096)
          .refine((value) => Boolean(value.trim())),
        options: z
          .array(
            z
              .string()
              .min(1)
              .max(1024)
              .refine((value) => Boolean(value.trim())),
          )
          .min(1)
          .max(20)
          .nullish(),
      }),
    )
    .min(1)
    .max(10),
})
const reply = z.object({
  questionItemId: z.string().min(1).max(1024),
  question: z.string().min(1).max(4096),
  answer: z.string().min(1).max(8192),
})
const prefix = '<send_user_message_question_reply>'
const suffix = '</send_user_message_question_reply>'

export function codexAsyncQuestionRequest(item: unknown): QuestionRequest | null {
  const parsed = message.safeParse(item)
  if (!parsed.success) return null
  return {
    mode: 'questions',
    message: 'You can answer while the agent continues working.',
    fields: parsed.data.questions.map((question, index) => ({
      key: JSON.stringify(['request_user_input_async', parsed.data.id, index]),
      title: question.title,
      description: '',
      type: 'string',
      required: true,
      secret: false,
      choices: (question.options ?? []).map((label) => ({ label, value: label, description: '' })),
      freeText: true,
      defaultValue: question.options?.[0] ?? '',
    })),
  }
}

export function codexEventAsyncQuestionRequest(event: TengriCodexEvent) {
  if (event.kind !== 'assistant-text') return null
  try {
    return codexAsyncQuestionRequest(JSON.parse(event.rawJson)?.params?.item)
  } catch {
    return null
  }
}

export function codexAsyncQuestionReply(request: QuestionRequest, response: TengriCodexInputResponse) {
  if (!('answers' in response)) throw new Error('A question answer is required.')
  const replies = request.fields.map((field) =>
    reply.parse({
      questionItemId: field.key,
      question: field.title,
      answer: response.answers[field.key]?.answers[0],
    }),
  )
  const text = `${prefix}${JSON.stringify(replies)}${suffix}`
  if (new TextEncoder().encode(text).length > MAX_CODEX_PROMPT_BYTES)
    throw new Error('These answers exceed the 64 KiB message limit. Shorten them and try again.')
  return text
}

export function codexAsyncQuestionReplies(text: string) {
  let value = text.trim()
  if (value.length > MAX_CODEX_PROMPT_BYTES) return []
  if (value.startsWith('# Context from my IDE setup:\n')) {
    const delimiter = '\n## My request for Codex:\n'
    const index = value.lastIndexOf(delimiter)
    if (index < 0) return []
    value = value.slice(index + delimiter.length).trim()
  }
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return []
  try {
    const raw = JSON.parse(value.slice(prefix.length, -suffix.length))
    const parsed = z
      .array(reply)
      .min(1)
      .max(10)
      .safeParse(Array.isArray(raw) ? raw : [raw])
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

export function codexAnsweredAsyncQuestions(
  items: readonly { kind: string; text: string; questionRequest?: QuestionRequest | null }[],
) {
  const pending = new Set<string>()
  const answered = new Set<string>()
  for (const item of items) {
    for (const field of item.questionRequest?.fields ?? []) if (!answered.has(field.key)) pending.add(field.key)
    if (item.kind !== 'user-message') continue
    const replies = codexAsyncQuestionReplies(item.text)
    // Ordinary follow-ups supersede earlier questions; identified replies close only their targets.
    for (const key of replies.length ? replies.map((reply) => reply.questionItemId) : pending) {
      answered.add(key)
      pending.delete(key)
    }
  }
  return answered
}

export function codexAsyncQuestionReplyDisplayText(text: string) {
  const replies = codexAsyncQuestionReplies(text)
  return replies.length
    ? replies
        .map(
          ({ question, answer }) =>
            `${question
              .split('\n')
              .map((line) => `> ${line}`)
              .join('\n')}\n\n${answer}`,
        )
        .join('\n\n')
    : text
}
