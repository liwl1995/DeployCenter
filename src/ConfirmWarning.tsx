import { AlertTriangle } from 'lucide-react';
import { Button } from './design/ui/button';
import { HoverTip } from './design/ui/hover-tip';

export function ConfirmWarning({ label, text }: { label: string; text: string }) {
  return (
    <HoverTip content={<span className="confirm-warning-text">{text}</span>} disableHoverableContent>
      <Button type="button" size="icon-compact" className="confirm-warning-icon" aria-label={label}>
        <AlertTriangle size={15} aria-hidden="true" />
      </Button>
    </HoverTip>
  );
}
