import React, { createContext, useContext } from 'react';
import { Button } from './components/ui/button';
import { cn } from './lib/utils';

export const ActionContext = createContext<{ acting: boolean; pressed: string | null }>({
  acting: false,
  pressed: null,
});

export function Btn({
  id, variant = 'outline', size = 'sm', disabled, onPress, children, className,
}: {
  id: string;
  variant?: 'default' | 'primary' | 'outline' | 'ghost';
  size?: 'default' | 'sm';
  disabled?: boolean;
  onPress: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const { acting, pressed } = useContext(ActionContext);
  return (
    <Button
      id={id}
      type="button"
      variant={variant === 'primary' ? 'default' : variant}
      size={size}
      data-pressed={pressed === id ? 'true' : undefined}
      disabled={disabled || acting}
      onClick={onPress}
      className={cn('max-sm:min-h-10 data-[pressed=true]:bg-primary/80', className)}
    >
      {children}
    </Button>
  );
}
