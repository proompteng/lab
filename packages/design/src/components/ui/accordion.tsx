'use client'

import * as React from 'react'
import { Accordion as AccordionPrimitive } from '@base-ui/react/accordion'
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react'

import { cn } from '../../lib/utils'

type AccordionType = 'single' | 'multiple'
type AccordionValue = AccordionPrimitive.Root.Props['value'] | string

type AccordionProps = Omit<AccordionPrimitive.Root.Props, 'value' | 'defaultValue' | 'onValueChange' | 'multiple'> & {
  type?: AccordionType
  collapsible?: boolean
  multiple?: boolean
  value?: AccordionValue
  defaultValue?: AccordionValue
  onValueChange?: (value: AccordionValue, details: AccordionPrimitive.Root.ChangeEventDetails) => void
}

function normalizeValue(value: AccordionValue | undefined) {
  if (value === undefined) {
    return undefined
  }

  if (Array.isArray(value)) {
    return value
  }

  return [value]
}

function formatValue(value: AccordionPrimitive.Root.Props['value'] | undefined, multiple: boolean) {
  if (value === undefined) {
    return undefined
  }

  if (multiple) {
    return value
  }

  return value[0] ?? ''
}

function Accordion({
  className,
  type,
  collapsible,
  multiple: multipleProp,
  value,
  defaultValue,
  onValueChange,
  ...props
}: AccordionProps) {
  const multiple = type ? type === 'multiple' : Boolean(multipleProp)
  const isCollapsible = multiple ? true : (collapsible ?? false)
  const normalizedValue = normalizeValue(value)
  const normalizedDefaultValue = normalizeValue(defaultValue)

  const handleValueChange = React.useCallback(
    (nextValue: AccordionPrimitive.Root.Props['value'], details: AccordionPrimitive.Root.ChangeEventDetails) => {
      if (nextValue === undefined) {
        onValueChange?.(formatValue(nextValue, multiple), details)
        return
      }

      if (!multiple && !isCollapsible && nextValue.length === 0) {
        details.cancel()
        return
      }

      onValueChange?.(formatValue(nextValue, multiple), details)
    },
    [isCollapsible, multiple, onValueChange],
  )

  return (
    <AccordionPrimitive.Root
      data-slot="accordion"
      className={cn('overflow-hidden rounded-md border flex w-full flex-col', className)}
      multiple={multiple}
      value={normalizedValue}
      defaultValue={normalizedDefaultValue}
      onValueChange={onValueChange || !isCollapsible ? handleValueChange : undefined}
      {...props}
    />
  )
}

function AccordionItem({ className, ...props }: AccordionPrimitive.Item.Props) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn('data-open:bg-muted/50 not-last:border-b', className)}
      {...props}
    />
  )
}

function AccordionTrigger({ className, children, ...props }: AccordionPrimitive.Trigger.Props) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          '**:data-[slot=accordion-trigger-icon]:text-muted-foreground gap-6 p-2 text-left text-xs/relaxed font-medium hover:underline **:data-[slot=accordion-trigger-icon]:ml-auto **:data-[slot=accordion-trigger-icon]:size-4 group/accordion-trigger relative flex flex-1 items-start justify-between border border-transparent transition-all outline-none disabled:pointer-events-none disabled:opacity-50',
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDownIcon
          data-slot="accordion-trigger-icon"
          className="pointer-events-none shrink-0 group-aria-expanded/accordion-trigger:hidden"
        />
        <ChevronUpIcon
          data-slot="accordion-trigger-icon"
          className="pointer-events-none hidden shrink-0 group-aria-expanded/accordion-trigger:inline"
        />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  )
}

function AccordionContent({ className, children, ...props }: AccordionPrimitive.Panel.Props) {
  return (
    <AccordionPrimitive.Panel
      data-slot="accordion-content"
      className="data-open:animate-accordion-down data-closed:animate-accordion-up px-2 text-xs/relaxed overflow-hidden"
      {...props}
    >
      <div
        className={cn(
          'pt-0 pb-4 [&_a]:hover:text-foreground h-(--accordion-panel-height) data-ending-style:h-0 data-starting-style:h-0 [&_a]:underline [&_a]:underline-offset-3 [&_p:not(:last-child)]:mb-4',
          className,
        )}
      >
        {children}
      </div>
    </AccordionPrimitive.Panel>
  )
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
