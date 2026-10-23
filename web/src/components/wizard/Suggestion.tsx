/**
 * Shared checkbox with label + reason, used across wizard steps.
 */
export function Suggestion({
  checked,
  onChange,
  label,
  reason,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  reason: string;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        {label}
        {reason && (
          <span className="block text-xs text-[var(--t-text-3)]">
            {reason}
          </span>
        )}
      </span>
    </label>
  );
}
