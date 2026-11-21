import React, { useEffect, useState } from 'react';
import { Btn } from './action';

export function KillControl({
  project, children, onKill,
}: {
  project: string;
  children: number;
  onKill: (project: string) => void;
}) {
  const [arming, setArming] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  useEffect(() => {
    if (!arming) return;
    setCooldown(true);
    const t = setTimeout(() => setCooldown(false), 500);
    return () => clearTimeout(t);
  }, [arming]);
  const label = children > 0 ? `Kill +${children}` : 'Kill';
  if (!arming) {
    return (
      <span className="ml-2 inline-block">
        <Btn id={`kill-${project}`} onPress={() => setArming(true)}>{label}</Btn>
      </span>
    );
  }
  return (
    <span className="ml-2 inline-flex gap-1.5">
      <Btn id={`kill-go-${project}`} disabled={cooldown} onPress={() => { setArming(false); onKill(project); }}>
        {`${label} for good?`}
      </Btn>
      <Btn id={`kill-back-${project}`} onPress={() => setArming(false)}>Back</Btn>
    </span>
  );
}
