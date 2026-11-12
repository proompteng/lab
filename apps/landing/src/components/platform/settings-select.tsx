'use client'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@proompteng/design/ui'
import { cn } from '@proompteng/design/utils'
import type { ComponentProps } from 'react'

type Props = Pick<
  ComponentProps<typeof SelectTrigger>,
  'id' | 'aria-label' | 'aria-describedby' | 'aria-invalid' | 'onBlur' | 'ref' | 'className'
> & {
  name: string
  value: string
  onValueChange: (value: string) => void
  options: readonly { value: string; label: string }[]
  placeholder?: string
  disabled?: boolean
}

export function SettingsSelect({
  name,
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  className,
  ...trigger
}: Props) {
  return (
    <Select
      name={name}
      value={value || null}
      items={options}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next)
      }}
    >
      <SelectTrigger {...trigger} className={cn('w-full min-w-0', className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent
        align="start"
        alignItemWithTrigger={false}
        className="tengri-theme font-geist max-h-64 p-1 motion-reduce:animate-none"
      >
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            className="pr-8 data-highlighted:bg-accent data-highlighted:text-accent-foreground"
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
