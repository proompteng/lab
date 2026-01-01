import * as React from 'react'

import { cn } from '@/lib/utils'

const ScrollArea = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} data-slot="scroll-area" className={cn('relative overflow-auto', className)} {...props} />
  ),
)
ScrollArea.displayName = 'ScrollArea'

const ScrollBar = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} data-slot="scroll-bar" className={cn('pointer-events-none absolute', className)} {...props} />
  ),
)
ScrollBar.displayName = 'ScrollBar'

export { ScrollArea, ScrollBar }
