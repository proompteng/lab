'use client'

import { useId, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button, Card, CardContent, Input, Label, RadioGroup, RadioGroupItem } from '@proompteng/design/ui'
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
  onRespond,
  disabled = false,
}: {
  agentId: string
  runId: string
  approvalId: string
  request: QuestionRequest
  onAnswered: () => void
  onRespond?: (response: TengriCodexInputResponse) => Promise<void>
  disabled?: boolean
}) {
  const id = useId()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [freeTextFields, setFreeTextFields] = useState<ReadonlySet<string>>(new Set())
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
    defaultValues: Object.fromEntries(request.fields.map((field, index) => [`q${index}`, field.defaultValue ?? ''])),
  })
  async function respond(response: TengriCodexInputResponse) {
    const key = `tengri-control:${runId}:${approvalId}`
    let operationId: string | undefined
    setBusy(true)
    setError('')
    try {
      if (onRespond) {
        await onRespond(response)
        onAnswered()
        return
      }
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
    <Card role="article" aria-label="Agent question" size="sm" className="w-full max-w-xl bg-zinc-900/40 ring-white/10">
      <CardContent>
        <form
          onSubmit={handleSubmit((values) => respond(codexQuestionResponse(request, values)))}
          className="space-y-3"
        >
          <p className="text-label-12 text-zinc-400">{request.message}</p>
          {request.fields.map((field, index) => {
            const key = `q${index}`
            const value = watch(key)
            const errorId = `${id}-${key}-error`
            return (
              <fieldset key={key} disabled={busy || disabled} className="min-w-0 space-y-1.5">
                <legend id={`${id}-${key}`} className="whitespace-pre-wrap break-words text-label-14">
                  {field.title}
                  {field.required ? '' : ' (optional)'}
                </legend>
                {field.description ? <p className="text-label-12 text-zinc-400">{field.description}</p> : null}
                {field.choices.length ? (
                  <RadioGroup
                    aria-labelledby={`${id}-${key}`}
                    name={`${id}-${key}`}
                    disabled={busy || disabled}
                    value={freeTextFields.has(key) ? null : value}
                    onValueChange={(choice) => {
                      if (typeof choice === 'string') {
                        setFreeTextFields((current) => new Set([...current].filter((field) => field !== key)))
                        setValue(key, choice, { shouldValidate: true })
                      }
                    }}
                    className="gap-0.5"
                  >
                    {field.choices.map((choice, choiceIndex) => (
                      <Label
                        key={choice.value}
                        htmlFor={`${id}-${key}-${choiceIndex}`}
                        className="min-h-7 cursor-pointer items-start rounded-md px-1 py-1.5 text-copy-14 hover:bg-white/[0.04]"
                      >
                        <RadioGroupItem id={`${id}-${key}-${choiceIndex}`} value={choice.value} className="mt-0.5" />
                        <span className="min-w-0 whitespace-pre-wrap break-words">
                          {choice.label}
                          {choice.description ? (
                            <span className="mt-0.5 block text-label-12 text-zinc-400">{choice.description}</span>
                          ) : null}
                        </span>
                      </Label>
                    ))}
                  </RadioGroup>
                ) : null}
                {field.freeText ? (
                  <Input
                    {...register(key)}
                    value={
                      !freeTextFields.has(key) && field.choices.some((choice) => choice.value === value) ? '' : value
                    }
                    onChange={(event) => {
                      setFreeTextFields((current) => new Set([...current, key]))
                      setValue(key, event.target.value, { shouldValidate: true })
                    }}
                    placeholder={field.choices.length ? 'Other answer' : undefined}
                    type={
                      field.secret
                        ? 'password'
                        : field.type === 'number' || field.type === 'integer'
                          ? 'number'
                          : 'text'
                    }
                    step={field.type === 'integer' ? 1 : 'any'}
                    aria-label={field.choices.length ? `Other answer: ${field.title}` : field.title}
                    aria-invalid={Boolean(errors[key])}
                    aria-describedby={errors[key] ? errorId : undefined}
                    autoComplete="off"
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
          <div className="flex flex-wrap items-center gap-1.5">
            <Button type="submit" disabled={busy || disabled}>
              {busy ? 'Sending…' : request.mode === 'url' ? 'Done' : 'Submit answers'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy || disabled}
              onClick={() => void respond(request.mode === 'questions' ? { answers: {} } : { action: 'cancel' })}
            >
              {onRespond ? 'Dismiss for now' : request.mode === 'questions' ? 'Skip questions' : 'Cancel'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
