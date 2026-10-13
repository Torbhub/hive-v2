import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium transition-colors duration-150',
  {
    variants: {
      variant: {
        outline: 'border-zinc-700 text-zinc-400',
        amber: 'border-amber-400/40 text-amber-300',
        cyan: 'border-sky-500/40 text-sky-300',
        red: 'border-red-500/40 text-red-300',
      },
    },
    defaultVariants: { variant: 'outline' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
