import React, { createContext, useContext } from 'react';
import { Button } from './components/ui/button';

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
      variant={variant}
      size={size}
      pressed={pressed === id}
      disabled={disabled || acting}
      onClick={onPress}
      className={className}
    >
      {children}
    </Button>
  );
}
