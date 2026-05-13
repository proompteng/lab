import * as React from 'react'
import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area'
import { ChevronDown } from 'lucide-react'
import { cn } from '~/lib/utils'

type ButtonProps = ButtonPrimitive.Props & {
  variant?: 'default' | 'outline' | 'secondary' | 'destructive'
  size?: 'default' | 'sm'
}

export function Button({ className, variant = 'default', size = 'default', ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md border text-xs font-medium outline-none transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-3.5',
        size === 'default' ? 'h-8 gap-1.5 px-3' : 'h-7 gap-1.5 px-2',
        variant === 'default' && 'border-zinc-100 bg-zinc-100 text-zinc-950 hover:bg-zinc-300',
        variant === 'outline' && 'border-zinc-800 bg-zinc-950 text-zinc-200 hover:bg-zinc-900',
        variant === 'secondary' && 'border-zinc-800 bg-zinc-900 text-zinc-100 hover:bg-zinc-800',
        variant === 'destructive' && 'border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800',
        className,
      )}
      {...props}
    />
  )
}

export function Badge({
  className,
  variant = 'outline',
  ...props
}: React.ComponentProps<'span'> & { variant?: 'outline' | 'secondary' | 'destructive' }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 w-fit shrink-0 items-center justify-center rounded-full border px-2 text-[10px] font-medium',
        variant === 'outline' && 'border-zinc-700 bg-zinc-950 text-zinc-300',
        variant === 'secondary' && 'border-zinc-700 bg-zinc-800 text-zinc-100',
        variant === 'destructive' && 'border-zinc-600 bg-zinc-900 text-zinc-100',
        className,
      )}
      {...props}
    />
  )
}

export function NativeSelect({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <div className={cn('relative w-fit', className)}>
      <select
        className="h-8 w-full min-w-0 appearance-none rounded-md border border-zinc-800 bg-zinc-900 py-1 pl-2 pr-7 text-xs text-zinc-100 outline-none transition-colors focus:border-zinc-600 disabled:pointer-events-none disabled:opacity-50"
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 text-zinc-500" />
    </div>
  )
}

export function NativeSelectOption(props: React.ComponentProps<'option'>) {
  return <option {...props} />
}

export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'min-h-20 w-full resize-none rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-600 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export function ScrollArea({ className, children, ...props }: ScrollAreaPrimitive.Root.Props) {
  return (
    <ScrollAreaPrimitive.Root data-slot="scroll-area" className={cn('relative', className)} {...props}>
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] outline-none"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        orientation="vertical"
        className="flex h-full w-2.5 touch-none select-none border-l border-l-transparent p-px"
      >
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-zinc-700" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

export function Separator({
  className,
  orientation = 'horizontal',
}: {
  className?: string
  orientation?: 'horizontal' | 'vertical'
}) {
  return <div className={cn(orientation === 'vertical' ? 'h-full w-px' : 'h-px w-full', 'bg-zinc-800', className)} />
}

export function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table className={cn('w-full caption-bottom text-xs', className)} {...props} />
    </div>
  )
}

export function TableHeader(props: React.ComponentProps<'thead'>) {
  return <thead {...props} />
}

export function TableBody(props: React.ComponentProps<'tbody'>) {
  return <tbody {...props} />
}

export function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return <tr className={cn('border-b transition-colors', className)} {...props} />
}

export function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return <th className={cn('h-10 text-left align-middle font-medium', className)} {...props} />
}

export function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return <td className={cn('align-middle', className)} {...props} />
}
