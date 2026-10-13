import React, {
  createContext, useCallback, useContext, useEffect, useRef, useState,
} from 'react';
import { Text, useInput } from 'ink';

type Registered = { press: () => void; disabled: boolean; hotkey?: string };

type Scope = {
  register: (api: Registered) => number;
  update: (index: number, api: Registered) => void;
  focused: number;
};

const ButtonScopeContext = createContext<Scope | null>(null);

// Ink has no Button; this scope gives Tab/Shift-Tab focus, Enter to press,
// and letter hotkeys that work regardless of focus.
export function ButtonScope({ children }: { children: React.ReactNode }) {
  const buttons = useRef<Registered[]>([]);
  const [focused, setFocused] = useState(0);

  const register = useCallback((api: Registered) => {
    buttons.current.push(api);
    return buttons.current.length - 1;
  }, []);
  const update = useCallback((index: number, api: Registered) => {
    buttons.current[index] = api;
  }, []);

  useInput((input, key) => {
    const list = buttons.current;
    if (list.length === 0) return;
    if (key.tab) {
      const dir = key.shift ? -1 : 1;
      setFocused((f) => (f + dir + list.length) % list.length);
      return;
    }
    if (key.return) {
      const b = list[Math.min(focused, list.length - 1)];
      if (b && !b.disabled) b.press();
      return;
    }
    const hot = list.find((b) => b.hotkey && b.hotkey === input && !b.disabled);
    if (hot) hot.press();
  });

  return (
    <ButtonScopeContext.Provider value={{ register, update, focused }}>
      {children}
    </ButtonScopeContext.Provider>
  );
}

export type ButtonVariant = 'primary' | 'plain' | 'default';

export function Button({
  label, onPress, variant = 'default', hotkey, disabled = false,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  hotkey?: string;
  disabled?: boolean;
}) {
  const scope = useContext(ButtonScopeContext);
  const indexRef = useRef(-1);
  if (scope && indexRef.current === -1) {
    indexRef.current = scope.register({ press: onPress, disabled, hotkey });
  }
  useEffect(() => {
    scope?.update(indexRef.current, { press: onPress, disabled, hotkey });
  });
  if (!scope) return <Text>{label}</Text>;
  const isFocused = scope.focused === indexRef.current;
  return (
    <Text
      inverse={isFocused}
      bold={variant === 'primary'}
      color={disabled ? 'gray' : variant === 'plain' ? 'gray' : variant === 'primary' ? 'cyan' : 'white'}
    >
      {label}
    </Text>
  );
}
