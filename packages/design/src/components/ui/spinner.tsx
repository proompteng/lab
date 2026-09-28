import type { ComponentPropsWithoutRef } from 'react'
import { cn } from '../../lib/utils'
import { Loader2Icon } from 'lucide-react'

function Spinner({ className, ...props }: ComponentPropsWithoutRef<'svg'>) {
  return <Loader2Icon role="status" aria-label="Loading" className={cn('size-4 animate-spin', className)} {...props} />
}

export { Spinner }
