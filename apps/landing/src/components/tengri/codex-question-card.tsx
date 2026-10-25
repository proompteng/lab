'use client'

import { useId, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { prepareCodexOperation, completeCodexOperation } from '@/lib/tengri/codex-operation'
import { runTengriAction, TengriRequestError } from './client'
import { codexQuestionResponse, type QuestionRequest } from './codex-question-model'
import type { TengriCodexInputResponse } from '@/lib/tengri/codex-input'

export function CodexQuestionCard({
  agentId,
  runId,
  approvalId,
  request,
  onAnswered,
}: {
  agentId: string
  runId: string
  approvalId: string
  request: QuestionRequest
  onAnswered: () => void
}) {
  const id = useId()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fields = Object.fromEntries(
    request.fields.map((field, index) => {
      const schema = z
        .string()
        .max(8192)
        .superRefine((value, context) => {
          if (!value && !field.required) return
          const issue = (message: string) => context.addIssue({ code: 'custom', message })
          if (request.mode === 'questions' ? !value.trim() : !value && field.type !== 'string') {
            issue('Choose an option or enter an answer.')
            return
          }
          if (field.choices.length && !field.freeText && !field.choices.some((choice) => choice.value === value))
            issue('Choose one of the available options.')
          if (field.type === 'number' || field.type === 'integer') {
            const number = Number(value)
            if (!Number.isFinite(number) || (field.type === 'integer' && !Number.isSafeInteger(number)))
              issue('Enter a valid number.')
            else if (
              (field.minimum !== undefined && number < field.minimum) ||
              (field.maximum !== undefined && number > field.maximum)
            )
              issue('The number is outside the requested range.')
          }
          const length = [...value].length
          if (
            (field.minLength !== undefined && length < field.minLength) ||
            (field.maxLength !== undefined && length > field.maxLength)
          )
            issue('The answer is outside the requested length.')
        })
      return [`q${index}`, schema]
    }),
  )
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(z.object(fields)),
    defaultValues: Object.fromEntries(request.fields.map((_, index) => [`q${index}`, ''])),
  })
  async function respond(response: TengriCodexInputResponse) {
    const key = `tengri-control:${runId}:${approvalId}`
    let operationId: string | undefined
    setBusy(true)
    setError('')
    try {
      if (!runId)
        throw new Error('This question has no durable run identity. Sleep the workspace before starting new work.')
      const op = await prepareCodexOperation(key, response, '')
      operationId = op.id
      await runTengriAction({ action: 'answer-questions', agentId, runId, operationId: op.id, approvalId, response })
      completeCodexOperation(key, op.id)
      onAnswered()
    } catch (cause) {
      if (cause instanceof TengriRequestError && cause.code === 'control_not_dispatched' && operationId)
        completeCodexOperation(key, operationId)
      setError(cause instanceof Error ? cause.message : 'The answer could not be sent.')
      setBusy(false)
    }
  }
  return (
    <article aria-label="Agent question" className="rounded-xl border border-zinc-700 bg-zinc-900/40 p-4 text-copy-14">
      <h3 className="text-heading-14">Your input is needed</h3>
      <p className="mt-1 text-zinc-400">{request.message}</p>
      <form
        onSubmit={handleSubmit((values) => respond(codexQuestionResponse(request, values)))}
        className="mt-4 space-y-4"
      >
        {request.fields.map((field, index) => {
          const key = `q${index}`
          const value = watch(key)
          const errorId = `${id}-${key}-error`
          return (
            <fieldset key={key} disabled={busy} className="space-y-2">
              <legend className="text-label-14">
                {field.title}
                {field.required ? '' : ' (optional)'}
              </legend>
              {field.description ? <p className="text-label-12 text-zinc-400">{field.description}</p> : null}
              {field.choices.map((choice) => (
                <label
                  key={choice.value}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border border-zinc-700 px-3 py-2 has-checked:border-blue-400"
                >
                  <input
                    type="radio"
                    name={`${id}-${key}`}
                    checked={value === choice.value}
                    onChange={() => setValue(key, choice.value, { shouldValidate: true })}
                    className="mt-1 accent-blue-400"
                  />
                  <span>
                    <span>{choice.label}</span>
                    {choice.description ? (
                      <span className="mt-1 block text-label-12 text-zinc-400">{choice.description}</span>
                    ) : null}
                  </span>
                </label>
              ))}
              {field.freeText ? (
                <input
                  {...register(key)}
                  type={
                    field.secret ? 'password' : field.type === 'number' || field.type === 'integer' ? 'number' : 'text'
                  }
                  step={field.type === 'integer' ? 1 : 'any'}
                  aria-label={field.choices.length ? `Other answer: ${field.title}` : field.title}
                  aria-invalid={Boolean(errors[key])}
                  aria-describedby={errors[key] ? errorId : undefined}
                  autoComplete="off"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                />
              ) : null}
              {errors[key] ? (
                <p id={errorId} role="alert" className="text-label-12 text-red-300">
                  {String(errors[key]?.message)}
                </p>
              ) : null}
            </fieldset>
          )
        })}
        {request.mode === 'url' ? (
          <a
            href={request.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-block text-blue-300 underline"
          >
            Open request
          </a>
        ) : null}
        {error ? (
          <p role="alert" className="text-red-300">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-zinc-100 px-3 py-2 text-label-12 text-zinc-950 disabled:opacity-50"
          >
            {busy ? 'Sending…' : request.mode === 'url' ? 'Done' : 'Submit answers'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void respond(request.mode === 'questions' ? { answers: {} } : { action: 'cancel' })}
            className="rounded-lg px-3 py-2 text-label-12 text-zinc-400"
          >
            {request.mode === 'questions' ? 'Skip questions' : 'Cancel'}
          </button>
        </div>
      </form>
    </article>
  )
}
