import React, { useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { theme } from './theme.js';
import { loadWizardSettings, saveWizardSettings, validateWizardValue, type WizardField, type WizardValues } from './wizard-config.js';

const FIELDS: ReadonlyArray<{ id: 'store' | WizardField; label: string }> = [
  { id: 'store', label: 'store (read-only)' }, { id: 'operator', label: 'operator label' },
  { id: 'edge', label: 'edge host' }, { id: 'commander', label: 'commander ws' }, { id: 'policy', label: 'model policy' },
];
export function WizardScreen({ cwd = process.cwd(), dry = false }: { cwd?: string; dry?: boolean }) {
  const { exit } = useApp();
  const [initial] = useState(() => { try { return loadWizardSettings(cwd); } catch { return null; } });
  const [values, setValues] = useState<WizardValues>(() => initial ?? { operator: '', edge: '', commander: '', policy: '' });
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const [note, setNote] = useState('Edit local settings; [w] saves them. No service is contacted.');
  const [failed, setFailed] = useState(false);
  useInput((text, key) => {
    if (!initial) { if (text === 'q' || key.escape) exit(); return; }
    const field = FIELDS[selected].id;
    if (editing) {
      if (key.escape) { setEditing(false); setInput(''); return; }
      if (key.return && field !== 'store') {
        try {
          const next = validateWizardValue(field, input);
          setValues(v => ({ ...v, [field]: next })); setEditing(false); setInput(''); setFailed(false); setNote('Value staged; [w] saves settings.');
        } catch { setFailed(true); setNote('Invalid value. Use a label, hostname, credential-free WS URL, or model ID.'); }
        return;
      }
      if (key.backspace || key.delete) { setInput(v => [...v].slice(0, -1).join('')); return; }
      if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(text)) setInput(v => (v + text).slice(0, 256));
      return;
    }
    if (text === 'q' || key.escape) { exit(); return; }
    if (key.upArrow || text === 'k') setSelected(v => Math.max(0, v - 1));
    if (key.downArrow || text === 'j' || key.return) setSelected(v => Math.min(FIELDS.length - 1, v + 1));
    if (text === 'e' && field !== 'store') { setEditing(true); setInput(values[field]); return; }
    if (text === 'w') {
      try {
        const result = saveWizardSettings(values, cwd, dry);
        setFailed(false); setNote(result.dry ? 'Dry run — settings validated; nothing written.' : 'Private settings saved. Restart Timmy to use them.');
      } catch { setFailed(true); setNote('Save refused or incomplete. Check private-file permissions and settings before retrying.'); }
    }
  });
  return <Box flexDirection="column">
    <Text bold color={theme.textPrimary}>TIMMY INIT — settings wizard</Text>
    {!initial ? <Text color={theme.refuse}>Settings unavailable: malformed, unsafe or unreadable private configuration. Nothing written. [q] quit</Text> : <>
      <Text color={theme.textMuted}>Operator ID: {initial.operatorId} (read-only; identity setup uses timmy init)</Text>
      {FIELDS.map((field, index) => <Text key={field.id} color={index === selected ? theme.textPrimary : theme.textMuted}>
        {`${index === selected ? '▶' : ' '} ${index + 1} ${field.label.padEnd(18)} ${editing && index === selected ? `[${input}]` : (field.id === 'store' ? initial.store : values[field.id]) || '—'}`}
      </Text>)}
      <Text color={failed ? theme.refuse : theme.textMuted}>{note}</Text>
      <Text color={theme.textMuted}>[↑↓] step · [e] edit · [Enter] next · [w] save · [q] quit</Text>
    </>}
  </Box>;
}
