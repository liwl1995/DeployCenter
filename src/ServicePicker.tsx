import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { fmtTime, statusLabel, type Database } from './model';
import { Field } from './ui';
import { EntityIcon } from './entity-icons';

export function ServicePicker({ db, onChoose }: { db: Database; onChoose: (id: string) => void }) {
  const [query, setQuery] = useState('');
  return (
    <>
      <Field label="搜索服务">
        <input
          data-autofocus
          placeholder="服务名称、标识或项目目录"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </Field>
      <div className="stack">
        {db.services
          .filter((s) =>
            [s.name, s.code, s.root].join(' ').toLowerCase().includes(query.toLowerCase()),
          )
          .map((s) => {
            const h = db.history.find((h) => h.service.id === s.id);
            return (
              <button className="service-result" key={s.id} onClick={() => onChoose(s.id)}>
                <span className="service-icon"><EntityIcon kind="service" icon={s.icon} size={18} strokeWidth={1.5} /></span>
                <span className="grow">
                  <strong>{s.name}</strong>
                  <small>{s.root}</small>
                  <small>
                    {h ? `上次 ${fmtTime(h.time)} · ${statusLabel[h.status]}` : '尚未部署'}
                  </small>
                </span>
                <ChevronRight size={17} />
              </button>
            );
          })}
      </div>
    </>
  );
}
