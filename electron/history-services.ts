import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { HistorySearchResult } from '../src/features';
export class HistorySearch {
  private worker?: Worker;
  private generation = 0;
  private reject?: (reason: Error) => void;
  private async stopWorker() {
    const worker = this.worker;
    this.worker = undefined;
    this.reject?.(new Error('搜索已取消'));
    this.reject = undefined;
    if (worker) await worker.terminate();
  }
  async stop() {
    this.generation++;
    await this.stopWorker();
  }
  async search(directory: string, query: string): Promise<HistorySearchResult> {
    const generation = ++this.generation;
    await this.stopWorker();
    if (generation !== this.generation) throw new Error('搜索已取消');
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'history-search.cjs'), {
        workerData: { directory, query },
      });
      this.worker = worker;
      this.reject = reject;
      const finish = () => {
        if (this.worker === worker) {
          this.worker = undefined;
          this.reject = undefined;
        }
        void worker.terminate();
      };
      worker.once('message', (value: { result?: HistorySearchResult; error?: string }) => {
        finish();
        if (value.result) resolve(value.result);
        else reject(new Error(value.error || '搜索未完成'));
      });
      worker.once('error', (error) => {
        finish();
        reject(error);
      });
      worker.once('exit', (code) => {
        if (this.worker === worker) {
          this.worker = undefined;
          this.reject = undefined;
          reject(new Error('搜索工作进程退出：' + code));
        }
      });
    });
  }
}
