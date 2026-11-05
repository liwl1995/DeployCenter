import { useState } from 'react';
import { Modal, Field } from './ui';
import { DateFilter } from './DateFilter';
import { recentDates, type DateRange } from './date-range';
export function DateRangeFilter({
  value,
  onChange,
}: {
  id?: string;
  value: DateRange;
  onChange: (range: DateRange) => void;
}) {
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState(value);
  const valid = !!draft.from && !!draft.to && draft.from <= draft.to;
  return (
    <div className="date-range-control" role="group" aria-label="部署日期">
      <div className="date-shortcuts">
        {[
          { label: '全部日期', days: 0 },
          { label: '今天', days: 1 },
          { label: '近 7 天', days: 7 },
          { label: '近 30 天', days: 30 },
        ].map(({ label, days }) => (
          <button
            key={label}
            className="button"
            onClick={() => onChange(days ? recentDates(days) : { from: '', to: '' })}
          >
            {label}
          </button>
        ))}
        <button
          className="button"
          onClick={() => {
            setDraft(value);
            setOpen(true);
          }}
        >
          自定义
        </button>
      </div>
      {(value.from || value.to) && (
        <p className="note" role="status">
          {value.from} 至 {value.to}
        </p>
      )}
      {open && (
        <Modal title="自定义日期范围" onClose={() => setOpen(false)}>
          <p className="note">包含开始与结束日期，格式 YYYY-MM-DD。</p>
          <div className="form-grid">
            <Field label="开始日期">
              <DateFilter value={draft.from} onChange={(from) => setDraft({ ...draft, from })} />
            </Field>
            <Field label="结束日期">
              <DateFilter value={draft.to} onChange={(to) => setDraft({ ...draft, to })} />
            </Field>
          </div>
          {draft.from && draft.to && draft.from > draft.to && (
            <p className="warning" role="alert">
              开始日期不能晚于结束日期。
            </p>
          )}
          <footer className="modal-actions">
            <button className="button" onClick={() => setOpen(false)}>
              取消
            </button>
            <button
              className="button primary"
              disabled={!valid}
              onClick={() => {
                onChange(draft);
                setOpen(false);
              }}
            >
              应用日期范围
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
