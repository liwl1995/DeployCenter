import { fmtTime, seconds, type Step } from './model';

export function TimingTable({ steps }: { steps: Step[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>步骤</th>
            <th>开始时间</th>
            <th>耗时</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s.key}>
              <td>{s.label}</td>
              <td>
                {s.startedAt === undefined
                  ? '未执行'
                  : fmtTime(new Date(s.startedAt).toISOString())}
              </td>
              <td>{seconds(s.elapsed || 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
