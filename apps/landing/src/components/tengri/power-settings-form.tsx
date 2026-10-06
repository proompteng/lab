'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { Button, Input, Switch } from '@proompteng/design/ui'
import { LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'

import { tengriPowerSettingsSchema, type TengriPowerSettings } from '@/lib/tengri/schemas'
import type { TengriAgent } from '@/lib/tengri/types'
import { runTengriAction } from './client'

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
  const [saved, setSaved] = useState(false)
  const {
    register,
    reset,
    handleSubmit,
    setError,
    watch,
    setValue,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<TengriPowerSettings>({
    defaultValues: agent.power,
    resolver: zodResolver(tengriPowerSettingsSchema),
    mode: 'onChange',
  })

  useEffect(() => {
    reset({ idleTimeoutMinutes: agent.power.idleTimeoutMinutes })
  }, [agent.id, agent.power.idleTimeoutMinutes, reset])

  const idleTimeoutMinutes = watch('idleTimeoutMinutes')
  const save = handleSubmit(async (power) => {
    setSaved(false)
    onSavingChange(true)
    try {
      const updated = await runTengriAction<TengriAgent>({ action: 'update-power-settings', agentId: agent.id, power })
      reset(updated.power)
      setSaved(true)
      try {
        await onChanged()
      } catch {
        setError('root.server', { message: 'Settings were saved. Refresh the desktop to update its status.' })
      }
    } catch (cause) {
      setError('root.server', { message: cause instanceof Error ? cause.message : 'Power settings could not be saved' })
    } finally {
      onSavingChange(false)
    }
  })

  return (
    <form noValidate onSubmit={save} className="space-y-4 rounded-[10px] border border-zinc-700 bg-zinc-800/80 p-3">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-4">
          <label htmlFor={`${instanceId}-automatic-sleep`} className="text-xs font-medium text-zinc-200">
            Automatic sleep
          </label>
          <Switch
            id={`${instanceId}-automatic-sleep`}
            checked={idleTimeoutMinutes !== 0}
            disabled={disabled || isSubmitting}
            onCheckedChange={(enabled) =>
              setValue('idleTimeoutMinutes', enabled ? 60 : 0, { shouldDirty: true, shouldValidate: true })
            }
          />
        </div>
        <p className="text-[11px] leading-5 text-zinc-400">
          Every sleep releases guest RAM and stops background processes. Your workspace is retained.
        </p>
      </div>
      <div className="space-y-1.5">
        <label htmlFor={`${instanceId}-idle-timeout`} className="block text-xs font-medium text-zinc-200">
          Idle timeout in minutes
        </label>
        <Input
          id={`${instanceId}-idle-timeout`}
          type="number"
          min={1}
          max={1440}
          step={1}
          disabled={disabled || isSubmitting || idleTimeoutMinutes === 0}
          aria-describedby={`${instanceId}-idle-timeout-help`}
          aria-invalid={Boolean(errors.idleTimeoutMinutes)}
          {...register('idleTimeoutMinutes', { valueAsNumber: true })}
          className="max-w-32"
        />
        <p id={`${instanceId}-idle-timeout-help`} className="text-[11px] leading-5 text-zinc-400">
          Sleep after this many minutes without authenticated activity. Turn off Automatic sleep to keep the agent
          running until you sleep it manually.
        </p>
        {errors.idleTimeoutMinutes ? (
          <p role="alert" className="text-xs text-red-200">
            {errors.idleTimeoutMinutes.message}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" variant="secondary" disabled={disabled || isSubmitting || !isDirty}>
          {isSubmitting ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> : null} Save power
          settings
        </Button>
        {saved && !isDirty ? (
          <p role="status" className="text-xs text-emerald-300">
            Saved
          </p>
        ) : null}
      </div>
      {errors.root?.server ? (
        <p role="alert" className="text-xs text-red-200">
          {errors.root.server.message}
        </p>
      ) : null}
    </form>
  )
}
