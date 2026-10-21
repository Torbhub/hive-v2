import React, { createContext, useContext } from 'react';
import { Button } from './components/ui/button';

// Every action button reads this: while an action runs all of them disable,
// and the one that was pressed holds the inverted look until it ends.
export const ActionContext = createContext<{ acting: boolean; pressed: string | null }>({
  acting: false,
  pressed: null,
});

export function Btn({
  id, variant = 'outline', size = 'sm', disabled, onPress, children,
}: {
  id: string;
  variant?: 'default' | 'primary' | 'outline' | 'ghost';
  size?: 'default' | 'sm';
  disabled?: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  const { acting, pressed } = useContext(ActionContext);
  return (
    <Button
      variant={variant}
      size={size}
      pressed={pressed === id}
      disabled={disabled || acting}
      onClick={onPress}
    >
      {children}
    </Button>
  );
}
