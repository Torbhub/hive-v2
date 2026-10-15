import React, {
  createContext, useCallback, useContext, useEffect, useRef, useState,
} from 'react';
import { Text, useInput } from 'ink';

type Registered = { press: () => void; disabled: boolean; hotkey?: string };

type Scope = {
  register: (api: Registered) => number;
  unregister: (slot: number) => void;
  update: (slot: number, api: Registered) => void;
  focusedSlot: number;
};

const ButtonScopeContext = createContext<Scope | null>(null);

// Ink has no Button; this scope gives Tab/Shift-Tab focus, Enter to press, and letter hotkeys.
// Unregistered slots stay as holes so a live button's slot never moves under it.
export function ButtonScope({ children, suspended = false }: { children: React.ReactNode; suspended?: boolean }) {
  const buttons = useRef<(Registered | null)[]>([]);
  const [focused, setFocused] = useState(0);
  const focusedRef = useRef(0);
  // While a text prompt owns the keyboard, hotkeys and Enter stay inert.
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;

  const liveSlots = () => buttons.current.map((b, i) => (b ? i : -1)).filter((i) => i >= 0);

  const register = useCallback((api: Registered) => {
    buttons.current.push(api);
    return buttons.current.length - 1;
  }, []);
  const unregister = useCallback((slot: number) => {
    buttons.current[slot] = null;
    focusedRef.current = Math.min(focusedRef.current, Math.max(0, liveSlots().length - 1));
    setFocused(focusedRef.current);
  }, []);
  const update = useCallback((slot: number, api: Registered) => {
    buttons.current[slot] = api;
  }, []);

  // Registration mutates a ref, so a render can lag behind it: key handling
  // reads the ref at event time, never the render-time snapshot.
  useInput((input, key) => {
    if (suspendedRef.current) return;
    const live = liveSlots();
    if (live.length === 0) return;
    if (key.tab) {
      const dir = key.shift ? -1 : 1;
      focusedRef.current = (focusedRef.current + dir + live.length) % live.length;
      setFocused(focusedRef.current);
      return;
    }
    if (key.return) {
      const b = buttons.current[live[Math.min(focusedRef.current, live.length - 1)]];
      if (b && !b.disabled) b.press();
      return;
    }
    const hot = live.map((i) => buttons.current[i]).find((b) => b?.hotkey && b.hotkey === input && !b.disabled);
    if (hot) hot.press();
  });

  const live = liveSlots();
  const focusedSlot = live.length ? live[Math.min(focused, live.length - 1)] : -1;

  return (
    <ButtonScopeContext.Provider value={{ register, unregister, update, focusedSlot }}>
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
  const register = scope?.register;
  const unregister = scope?.unregister;
  const [slot, setSlot] = useState(-1);
  // Registration is once per mount; prop changes go through update below.
  useEffect(() => {
    if (!register || !unregister) return;
    const i = register({ press: onPress, disabled, hotkey });
    setSlot(i);
    return () => unregister(i);
  }, [register, unregister]);
  useEffect(() => {
    if (slot >= 0) scope?.update(slot, { press: onPress, disabled, hotkey });
  });
  if (!scope) return <Text>{label}</Text>;
  const isFocused = scope.focusedSlot === slot;
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
