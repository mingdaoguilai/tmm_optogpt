import { useEffect, useState } from 'react';

type Props = { value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; unit?: string; integer?: boolean };
export function NumberField({ value, onChange, min = 0, max = Infinity, step = 1, unit, integer }: Props) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState('');
  useEffect(() => { setDraft(String(value)); setError(''); }, [value]);
  const commit = () => {
    const number = Number(draft);
    if (!draft.trim() || !Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
      setError(`请输入${integer ? '整数，' : ''}${min} 至 ${Number.isFinite(max) ? max : '有效上限'}之间的有效数值`); return;
    }
    setError(''); setDraft(String(number)); if (number !== value) onChange(number);
  };
  return <span className="number-field"><span className="number-box"><input aria-invalid={!!error} title="Enter 确认，Esc 恢复，方向键微调" inputMode="decimal" value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => {
    if (e.key === 'Enter') e.currentTarget.blur();
    if (e.key === 'Escape') { setDraft(String(value)); setError(''); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); const next = Math.min(max, Math.max(min, value + (e.key === 'ArrowUp' ? step : -step))); setDraft(String(next)); onChange(next); }
  }} />{unit && <span>{unit}</span>}</span>{error && <small role="alert">{error}</small>}</span>;
}
