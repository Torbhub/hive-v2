import * as React from 'react';
import { cn } from '../../lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-8 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2.5 text-sm text-zinc-100',
        'placeholder:text-zinc-600 transition-colors duration-150',
        'focus-visible:outline-1 focus-visible:outline-sky-400 focus-visible:border-zinc-600',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
