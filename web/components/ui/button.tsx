import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors duration-150 focus-visible:outline-1 focus-visible:outline-sky-400 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-40 cursor-pointer',
  {
    variants: {
      variant: {
        default: 'bg-zinc-100 text-zinc-900 hover:bg-white',
        primary: 'bg-sky-500/15 text-sky-300 border border-sky-500/40 hover:bg-sky-500/25',
        outline: 'border border-zinc-700 text-zinc-200 hover:border-zinc-500 hover:text-white bg-transparent',
        ghost: 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60',
      },
      size: {
        default: 'h-8 px-3',
        sm: 'h-7 px-2 text-xs',
      },
      pressed: {
        true: 'bg-white text-zinc-900 border-white hover:bg-white',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  pressed?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, pressed, ...props }, ref) => (
    <button
      ref={ref}
      data-pressed={pressed ? 'true' : undefined}
      className={cn(buttonVariants({ variant, size, pressed }), className)}
      {...props}
    />
  ),
);
Button.displayName = 'Button';

export { buttonVariants };
