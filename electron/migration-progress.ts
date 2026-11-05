import type { MigrationProgress } from '../src/features';

/** 统计保留在内存，进度节流只影响展示，不影响迁移日志及逐块取消检查。 */
export class MigrationReporter {
  value: MigrationProgress;
  private samples: { time: number; bytes: number }[] = [];
  private lastEmit = -Infinity;
  constructor(
    source: string,
    target: string,
    private emit: (value: MigrationProgress) => void,
    private now = Date.now,
  ) {
    this.value = {
      state: 'preparing',
      source,
      target,
      copied: 0,
      total: 0,
      files: 0,
      totalFiles: 0,
      message: '正在准备数据清单，原目录保留。',
    };
    this.samples = [{ time: this.now(), bytes: 0 }];
  }
  update(patch: Partial<MigrationProgress>, force = false) {
    const time = this.now(),
      previous = this.value.state;
    this.value = { ...this.value, ...patch };
    const bytes = this.value.state === 'verifying' ? this.value.verified || 0 : this.value.copied;
    if (previous !== this.value.state) this.samples = [{ time, bytes }];
    if (['copying', 'verifying'].includes(this.value.state)) {
      this.samples.push({ time, bytes });
      while (this.samples.length > 2 && this.samples[1].time < time - 3000) this.samples.shift();
      const first = this.samples[0],
        elapsed = time - first.time;
      const speed = elapsed > 0 ? Math.max(0, ((bytes - first.bytes) * 1000) / elapsed) : 0;
      this.value.bytesPerSecond = speed;
      this.value.remainingSeconds =
        speed > 0 ? Math.max(0, (this.value.total - bytes) / speed) : undefined;
    } else {
      this.value.bytesPerSecond = undefined;
      this.value.remainingSeconds = this.value.state === 'pending' ? 0 : undefined;
    }
    if (force || previous !== this.value.state || time - this.lastEmit >= 100) {
      this.lastEmit = time;
      this.emit({ ...this.value });
    }
    return this.value;
  }
}
