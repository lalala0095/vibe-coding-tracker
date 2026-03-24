import type { Model } from '../types';

interface Props {
  models: Model[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}

export default function ModelSelector({ models, value, onChange, disabled }: Props) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm
                 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent
                 disabled:opacity-50 disabled:cursor-not-allowed appearance-none cursor-pointer"
    >
      <option value="" disabled>
        Select a model…
      </option>
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </select>
  );
}
