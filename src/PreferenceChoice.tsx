import { useId } from 'react';
import { SegmentedControl, type SegmentedControlProps } from './design/ui/segmented-control';
import { helpFor } from './field-help';
import { FieldHelp } from './ui';

export function PreferenceChoice<T extends string | number>({
  label,
  hint,
  disabled,
  items,
  ...choice
}: Pick<SegmentedControlProps<T>, 'items' | 'value' | 'onValueChange'> & {
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  const hintId = useId();
  const help = helpFor(label);
  return (
    <div className="preference-row">
      <span className="field-label">
        {label}
        {help && <FieldHelp label={label} text={help} />}
      </span>
      <SegmentedControl
        {...choice}
        items={disabled ? items.map((item) => ({ ...item, disabled: true })) : items}
        size="sm"
        aria-label={label}
        aria-describedby={hint ? hintId : undefined}
      />
      {hint && <small id={hintId}>{hint}</small>}
    </div>
  );
}
