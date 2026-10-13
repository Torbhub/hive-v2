import * as React from 'react';
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import { cn } from '../../lib/utils';

export const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <ToggleGroupPrimitive.Root
    ref={ref}
    className={cn('inline-flex rounded-md border border-zinc-800 overflow-hidden', className)}
    {...props}
  />
));
ToggleGroup.displayName = 'ToggleGroup';

export const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  <ToggleGroupPrimitive.Item
    ref={ref}
    className={cn(
      'px-2.5 h-7 text-xs text-zinc-400 transition-colors duration-150 cursor-pointer',
      'hover:text-zinc-100 focus-visible:outline-1 focus-visible:outline-sky-400',
      'disabled:pointer-events-none disabled:opacity-40',
      'data-[state=on]:bg-zinc-100 data-[state=on]:text-zinc-900',
      className,
    )}
    {...props}
  />
));
ToggleGroupItem.displayName = 'ToggleGroupItem';
