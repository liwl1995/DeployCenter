import { useMemo } from 'react';
import { ChartNoAxesCombined } from 'lucide-react';
import { Button } from './design/ui/button';
import { Card } from './ui';
import { seconds, type History } from './model';
import type { TaskSummary } from './platform';
import { deployStats, type HistoryScope } from './deploy-stats';

type Stats = ReturnType<typeof deployStats>;
const rateText = (value: number | null) => (value === null ? '—' : value.toFixed(1) + '%');
const elapsedText = (value: number | null) => (value === null ? '—' : seconds(value));
const dateLabel = (value: string) => value.slice(5).replace('-', '/');

function Trend({ stats, metric }: { stats: Stats; metric: 'rate' | 'average' }) {
  const isRate = metric === 'rate';
  const title = isRate ? '成功率趋势' : '平均耗时趋势';
  const format = isRate ? rateText : elapsedText;
  const { buckets, bucketDays } = stats;
  const max = isRate
    ? 100
    : Math.max(4, Math.ceil(Math.max(...buckets.map((point) => point.average ?? 0)) / 4) * 4);
  const x = (index: number) =>
    buckets.length === 1 ? 50 : 4 + (index * 92) / (buckets.length - 1);
  const y = (value: number) => 8 + (1 - value / max) * 104;
  const lines: string[][] = [];
  let segment: string[] = [];
  const points = buckets.flatMap((bucket, index) => {
    const value = bucket[metric];
    if (value === null) {
      segment = [];
      return [];
    }
    if (!segment.length) lines.push(segment);
    segment.push(`${x(index)},${y(value)}`);
    return [{ bucket, index, value }];
  });
  const ticks = [0, 1, 2, 3, 4].map((index) => max * (1 - index / 4));
  const dateTicks =
    buckets.length < 3
      ? buckets.map((_, index) => index)
      : [0, Math.round((buckets.length - 1) / 2), buckets.length - 1];

  return (
    <Card
      title={title}
      className="deploy-stats-chart"
      action={<span className="note">{bucketDays === 1 ? '按天' : `每 ${bucketDays} 天`}</span>}
    >
      {!points.length ? (
        <p className="empty">暂无可绘制的数据。</p>
      ) : (
        <>
          <div className={`deploy-stats-plot deploy-stats-${metric}`}>
            <div className="deploy-stats-axis" aria-hidden="true">
              {ticks.map((tick) => (
                <span key={tick}>{isRate ? tick + '%' : elapsedText(tick)}</span>
              ))}
            </div>
            <div className="deploy-stats-series">
              <svg viewBox="0 0 100 120" preserveAspectRatio="none" role="img" aria-label={title}>
                <desc>
                  {points
                    .map(
                      ({ bucket, value }) =>
                        `${bucket.from} 至 ${bucket.to}，${format(value)}，${bucket.total} 个目标`,
                    )
                    .join('。')}
                </desc>
                {ticks.map((tick) => (
                  <line
                    className="deploy-stats-gridline"
                    key={tick}
                    x1="0"
                    x2="100"
                    y1={y(tick)}
                    y2={y(tick)}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                {lines
                  .filter((line) => line.length > 1)
                  .map((line) => (
                    <polyline
                      className="deploy-stats-line"
                      key={line[0]}
                      points={line.join(' ')}
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
              </svg>
              {points.map(({ bucket, index, value }) => (
                <svg
                  className="deploy-stats-dot"
                  key={bucket.from}
                  viewBox="0 0 12 12"
                  aria-hidden="true"
                  style={{ left: x(index) + '%', top: y(value) }}
                >
                  <title>
                    {bucket.from === bucket.to ? bucket.from : `${bucket.from} 至 ${bucket.to}`} ·{' '}
                    {format(value)} · {bucket.total} 个目标
                  </title>
                  <circle cx="6" cy="6" r="3.5" />
                </svg>
              ))}
              <div className="deploy-stats-dates" aria-hidden="true">
                {dateTicks.map((index) => {
                  const { from, to } = buckets[index];
                  const label =
                    from === to || buckets.length > 1
                      ? dateLabel(from)
                      : `${dateLabel(from)}–${dateLabel(to)}`;
                  return (
                    <span key={from} style={{ left: x(index) + '%' }}>
                      {label}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
          <p className="note">无数据的时段留空。</p>
        </>
      )}
    </Card>
  );
}

export function DeployStatsView({
  history,
  tasks,
  scope,
  onAdjust,
  onService,
}: {
  history: readonly History[];
  tasks: readonly TaskSummary[];
  scope: HistoryScope;
  onAdjust: () => void;
  onService: (id: string) => void;
}) {
  const stats = useMemo(() => deployStats(history, tasks, scope), [history, tasks, scope]);
  const excluded = [
    ['回滚目标', stats.excluded.rollback],
    ['试运行', stats.excluded.dryRun],
    ['中断任务', stats.excluded.interrupted],
    ['待核实目标', stats.excluded.unknown],
    ['已取消目标', stats.excluded.cancelled],
    ['已跳过目标', stats.excluded.skipped],
    ['构建失败任务', stats.excluded.buildFailed],
  ] as const;
  return (
    <div className="deploy-stats">
      <div className="deploy-stats-metrics">
        <Card title="目标部署数">
          <strong className="deploy-stats-value">{stats.total}</strong>
          <div className="deploy-stats-breakdown">
            <span className="deploy-stats-passed">成功 {stats.success}</span>
            <span className="deploy-stats-unverified">健康未验证 {stats.unverified}</span>
            <span className="deploy-stats-failed">失败 {stats.failed}</span>
          </div>
        </Card>
        <Card title="部署成功率">
          <strong className="deploy-stats-value">{rateText(stats.rate)}</strong>
          <p className="note">
            {stats.success + stats.unverified} / {stats.total} 个目标 · 含健康未验证
          </p>
        </Card>
        <Card title="平均目标耗时">
          <strong className="deploy-stats-value">{elapsedText(stats.average)}</strong>
          <p className="note">按已得出结果的目标计算，含失败</p>
        </Card>
      </div>
      <div className="deploy-stats-excluded note">
        <strong>未计入统计</strong>
        {excluded.map(([label, count]) => (
          <span key={label}>
            {label} {count}
          </span>
        ))}
      </div>
      {stats.total === 0 ? (
        <Card className="deploy-stats-empty">
          <ChartNoAxesCombined size={24} aria-hidden="true" />
          <h2>暂无可统计的部署记录</h2>
          <p className="note">可调整筛选范围，或完成一次目标部署后再查看。</p>
          <Button variant="neutral" size="compact" onClick={onAdjust}>
            调整筛选
          </Button>
        </Card>
      ) : (
        <>
          <div className="deploy-stats-charts">
            <Trend stats={stats} metric="rate" />
            <Trend stats={stats} metric="average" />
          </div>
          <div className="deploy-stats-comparison">
            <Card
              title="失败原因"
              action={<span className="note">共 {stats.failed} 个失败目标</span>}
            >
              {!stats.failures.length ? (
                <p className="note">筛选范围内没有失败目标。</p>
              ) : (
                <ul className="deploy-stats-failures">
                  {stats.failures.map(({ reason, count }) => (
                    <li key={reason}>
                      <span>{reason}</span>
                      <svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
                        <rect className="deploy-stats-gridline" width="100" height="8" />
                        <rect
                          className="deploy-stats-bar"
                          width={(100 * count) / stats.failed}
                          height="8"
                        />
                      </svg>
                      <span>{count} 个</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="按服务对比" action={<span className="note">点击服务名称筛选</span>}>
              <table className="compact-table deploy-stats-services" aria-label="各服务部署统计">
                <thead>
                  <tr>
                    <th scope="col">服务</th>
                    <th scope="col">目标部署数</th>
                    <th scope="col">成功率</th>
                    <th scope="col">平均耗时</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.services.map((service) => (
                    <tr key={service.id}>
                      <th scope="row">
                        <Button
                          variant="link"
                          size="compact"
                          title={service.name}
                          aria-label={`筛选服务：${service.name}`}
                          onClick={() => onService(service.id)}
                        >
                          <span className="compact-ellipsis">{service.name}</span>
                        </Button>
                      </th>
                      <td>{service.total}</td>
                      <td>{rateText(service.rate)}</td>
                      <td>{elapsedText(service.average)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
