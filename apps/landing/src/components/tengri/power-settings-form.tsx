'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useRef } from 'react'
import { Controller, useForm } from 'react-hook-form'

import { tengriPowerSettingsSchema, type TengriPowerSettings } from '@/lib/tengri/schemas'
import type { TengriAgent } from '@/lib/tengri/types'
import { runTengriAction } from './client'
import { SettingsSelect } from './settings-select'

const sleepIntervals = [1, 2, 5, 10, 15, 30, 60, 120, 240, 480, 1440, 0]

function intervalLabel(minutes: number) {
  if (minutes === 0) return 'Never'
  if (minutes < 60) return `After ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  if (minutes % 60 === 0) return `After ${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`
  return `After ${minutes} minutes`
}

export function PowerSettingsForm({
  agent,
  disabled,
  instanceId,
  onChanged,
  onSavingChange,
}: {
  agent: TengriAgent
  disabled: boolean
  instanceId: string
  onChanged: () => Promise<void>
  onSavingChange: (saving: boolean) => void
}) {
  const saving = useRef(false)
  const timeoutTrigger = useRef<HTMLButtonElement>(null)
  const {
    control,
    reset,
    handleSubmit,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<TengriPowerSettings>({
    defaultValues: agent.power,
    resolver: zodResolver(tengriPowerSettingsSchema),
  })
  useEffect(() => {
    reset({ idleTimeoutMinutes: agent.power.idleTimeoutMinutes })
  }, [agent.id, agent.power.idleTimeoutMinutes, reset])

  const minutes = watch('idleTimeoutMinutes')
  const intervals = sleepIntervals.includes(minutes) ? sleepIntervals : [minutes, ...sleepIntervals]
  const save = handleSubmit(async (power) => {
    if (saving.current) return
    saving.current = true
    onSavingChange(true)
    try {
      const updated = await runTengriAction<TengriAgent>({ action: 'update-power-settings', agentId: agent.id, power })
      reset(updated.power)
      try {
        await onChanged()
      } catch {
        setError('root.server', {
          message: 'Saved. The workspace status could not refresh. Reopen Settings to check it.',
        })
      }
    } catch (cause) {
      setError('root.server', {
        message: cause instanceof Error ? cause.message : 'The sleep setting could not be saved.',
      })
    } finally {
      saving.current = false
      onSavingChange(false)
    }
  })

  return (
    <form noValidate onSubmit={save} className="space-y-2">
      <div className="flex min-h-12 items-center justify-between gap-4 rounded-[10px] border border-white/[0.07] bg-white/[0.045] px-3 py-2">
        <label htmlFor={`${instanceId}-idle-timeout`} className="text-[13px] text-zinc-100">
          Sleep when inactive
        </label>
        <Controller
          name="idleTimeoutMinutes"
          control={control}
          render={({ field }) => (
            <SettingsSelect
              name={field.name}
              ref={(element) => {
                field.ref(element)
                timeoutTrigger.current = element
              }}
              onBlur={field.onBlur}
              value={String(field.value)}
              id={`${instanceId}-idle-timeout`}
              aria-describedby={`${instanceId}-idle-timeout-help`}
              aria-invalid={Boolean(errors.idleTimeoutMinutes)}
              disabled={disabled || isSubmitting}
              className="w-auto max-w-[55%]"
              options={intervals.map((value) => ({ value: String(value), label: intervalLabel(value) }))}
              onValueChange={(value) => {
                field.onChange(Number(value))
                void save().finally(() =>
                  window.requestAnimationFrame(() => {
                    const trigger = timeoutTrigger.current
                    if (
                      document.hasFocus() &&
                      document.activeElement === document.body &&
                      trigger?.isConnected &&
                      !trigger.disabled &&
                      trigger.getClientRects().length > 0
                    )
                      trigger.focus({ preventScroll: true })
                  }),
                )
              }}
            />
          )}
        />
      </div>
      <p id={`${instanceId}-idle-timeout-help`} className="px-3 text-[12px] leading-[1.45] text-zinc-400">
        Your workspace sleeps after you and your agent stop working. Open windows and connection checks won’t keep it
        awake. Files are kept; background processes stop.
      </p>
      {isSubmitting ? (
        <p role="status" className="px-3 text-xs text-zinc-400">
          Saving…
        </p>
      ) : null}
      {errors.idleTimeoutMinutes ? (
        <p role="alert" className="px-3 text-xs text-red-300">
          {errors.idleTimeoutMinutes.message}
        </p>
      ) : null}
      {errors.root?.server ? (
        <div className="flex items-center justify-between gap-3 px-3">
          <p role="alert" className="text-xs text-red-300">
            {errors.root.server.message}
          </p>
          <button
            type="submit"
            disabled={disabled || isSubmitting}
            className="shrink-0 text-xs text-blue-400 outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            Try Again
          </button>
        </div>
      ) : null}
    </form>
  )
}
