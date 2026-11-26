import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withoutIcon, type Task } from '../src/model';
import type { Approval } from '../src/platform';
import { confirmProduction } from '../src/presentation';
import type { ReleasePreview, ReleaseRequest, ReleaseReview, ReleaseRow, ReleaseRun } from '../src/serial-release';
import { approvalSchema, credentialsSchema, prepareSchema } from './validate';

type Authorization = { previews: readonly ReleasePreview[]; credentials: Record<string, string>; approval: Approval };
const requestSchema = prepareSchema.omit({ historyId: true, dryRun: true, retryOf: true });
const policySchema = z.enum(['stop', 'continue']);
const journalSchema = z.object({
  state: z.enum(['running', 'cancelling', 'paused', 'done']),
  message: z.string(),
  failurePolicy: policySchema,
  cancelRequested: z.literal(true).optional(),
  rows: z.array(z.object({
    request: requestSchema,
    name: z.string(),
    targets: z.array(z.string()),
    state: z.enum(['queued', 'starting', 'running', 'success', 'partial', 'failed', 'cancelled', 'unknown', 'skipped']),
    taskId: z.string().regex(/^[\w-]{1,150}$/).optional(),
    elapsed: z.number().optional(),
    detail: z.string().optional(),
  })).min(1),
});

type DeploymentAccess = {
  prepare(request: ReleaseRequest, owned: boolean): Promise<{ task: Task; token: string }>;
  start(token: string, credentials: Record<string, string>, approval: Approval, releaseId: string): Promise<Task>;
  cancel(id: string): void | Promise<void>;
  readTask(id: string): Task | undefined | Promise<Task | undefined>;
  active(): boolean;
  unfinished(): boolean;
  blocked(): string | undefined;
};

function reviewedDetails(task: Task) {
  return JSON.stringify({
    service: withoutIcon(task.service),
    build: task.buildContext,
    artifact: task.artifact,
    note: task.note,
    failurePolicy: task.failurePolicy,
    targets: task.targets.map(({ target, server, backup }) => ({
      target: withoutIcon(target),
      server: withoutIcon(server),
      backup,
    })),
  });
}

const running = (task: Task) => task.status === 'running' || task.status === 'cancelling';
const unknown = (task: Task) => task.status === 'interrupted' || task.targets.some((item) => item.status === 'unknown');
const inFlight = (row: ReleaseRow) => row.state === 'starting' || row.state === 'running' || row.state === 'unknown';

/** 每次只交给现有控制器一个服务。清单日志只记录进度与请求，审批和口令留在内存。 */
export class SerialRelease {
  private run: ReleaseRun | null = null;
  private review?: ReleaseReview & { until: number };
  private authorization?: Authorization;
  private dispatching = false;
  private settling = false;
  private cancelRequested = false;
  private terminalEvent?: string;

  constructor(private api: DeploymentAccess, private persist: (run: ReleaseRun) => void,
    private changed: (run: ReleaseRun) => void, saved?: ReleaseRun) {
    if (saved) {
      this.restore(saved);
      if (saved !== this.run) this.persist(this.run!);
    }
  }

  private restore(saved: ReleaseRun) {
    this.cancelRequested = saved.state === 'cancelling' || saved.cancelRequested === true;
    this.run = saved.state === 'done' || saved.state === 'paused' ? saved : {
      ...saved,
      state: 'paused',
      cancelRequested: this.cancelRequested ? true : undefined,
      message: '应用已重新打开。请先核实已启动的任务，再重新确认未执行的服务。',
    };
    if (this.cancelRequested && this.run.state !== 'done' && !saved.rows.some(inFlight))
      this.run = { ...this.run, state: 'done', message: '已取消',
        rows: saved.rows.map((row) => row.state === 'queued' ? { ...row, state: 'skipped' } : row) };
  }

  get = () => this.run;
  active = () => this.run?.state === 'running' || this.run?.state === 'cancelling';
  ownsTask = (id: string) => this.active() && !!this.run?.rows.some((row) => row.taskId === id && inFlight(row));

  importLegacy(raw: string) {
    if (this.run) return;
    const saved = journalSchema.parse(JSON.parse(raw));
    if (new Set(saved.rows.map((row) => row.request.serviceId)).size !== saved.rows.length)
      throw new Error('旧清单包含重复服务，无法导入。');
    this.restore(saved);
    try { this.persist(this.run!); }
    catch (error) { this.run = null; this.cancelRequested = false; throw error; }
  }

  private update(run: ReleaseRun, durable = false) {
    run = { ...run, cancelRequested: this.cancelRequested ? true : undefined };
    try {
      this.persist(run);
    } catch {
      if (durable) throw new Error('无法保存本次发布进度。未启动下一个服务。');
      run = { ...run, state: 'paused', message: '无法保存发布进度。请检查本机数据目录后核实任务。' };
      this.authorization = undefined;
    }
    this.run = run;
    this.changed(run);
  }

  private replace(row: ReleaseRow, state = this.run!.state, message = this.run!.message, durable = false) {
    this.update({
      ...this.run!,
      state,
      message,
      rows: this.run!.rows.map((item) => item.request.serviceId === row.request.serviceId ? row : item),
    }, durable);
  }

  async preview(value: unknown): Promise<ReleaseReview> {
    this.assertAvailable();
    const requests = z.array(requestSchema).min(1).parse(value);
    if (!requests.length || new Set(requests.map((item) => item.serviceId)).size !== requests.length)
      throw new Error('请选择不同的服务并为每个服务选择部署目标。');
    const previews: ReleasePreview[] = [];
    for (const request of requests) {
      const { task } = await this.api.prepare(request, false);
      previews.push({ request, task });
    }
    this.assertAvailable();
    const review = { token: randomUUID(), previews };
    this.review = { ...review, until: Date.now() + 15 * 60_000 };
    return review;
  }

  private assertAvailable() {
    if (this.dispatching || this.settling || this.active())
      throw new Error('已有清单正在执行。');
    const reason = this.api.blocked();
    if (reason) throw new Error(reason);
    if (this.api.active()) throw new Error('请等待当前任务结束。');
    if (this.api.unfinished()) throw new Error('请先核实尚未结束的部署任务。');
  }

  begin(token: string, values: unknown, rawApproval: unknown, rawPolicy: unknown, resume: boolean) {
    this.assertAvailable();
    const review = this.review;
    if (!review || review.token !== token || review.until < Date.now())
      throw new Error('清单确认已过期，请返回并重新检查。');
    const { previews } = review;
    const credentials = credentialsSchema.parse(values);
    const approval = approvalSchema.parse(rawApproval);
    const policy = policySchema.parse(rawPolicy);
    if (resume && (this.run?.state !== 'paused' || this.run.rows.some(inFlight) || this.cancelRequested))
      throw new Error('请先核实当前服务。');
    if (!resume && this.run?.state === 'paused') throw new Error('请先结束或继续上一次清单。');
    const requested = previews.map(({ request }) => request.serviceId);
    if ((!resume && requested.length < 2) || !requested.length || new Set(requested).size !== requested.length)
      throw new Error('请至少选择两个服务。');
    if (resume && JSON.stringify(previews.map(({ request }) => request)) !== JSON.stringify(
      this.run!.rows.filter((row) => row.state === 'queued').map((row) => row.request),
    ))
      throw new Error('未执行的服务已变化，请重新核对清单。');
    if (previews.some(({ task }) => !confirmProduction(task, approval.productionNames ?? {})))
      throw new Error('请逐项输入正式环境名称。');
    if (!approval.allowWeak && previews.some(({ task }) => task.targets.some(({ target }) => target.hashPolicy === 'size-confirm')))
      throw new Error('请明确确认弱校验策略。');
    const pending = previews.map(({ task, request }): ReleaseRow => ({
      request, name: task.service.name, targets: task.targets.map((item) => item.target.name), state: 'queued',
    }));
    const previousCancellation = this.cancelRequested;
    this.cancelRequested = false;
    try {
      this.update({
        id: resume ? this.run!.id ?? 'RL-' + randomUUID() : 'RL-' + randomUUID(),
        state: 'running', message: '',
        failurePolicy: resume ? this.run!.failurePolicy : policy,
        rows: resume ? [...this.run!.rows.filter((row) => row.state !== 'queued'), ...pending] : pending,
      }, true);
    } catch (error) {
      this.cancelRequested = previousCancellation;
      throw error;
    }
    this.review = undefined;
    this.authorization = { previews, credentials: { ...credentials }, approval };
    void this.next();
  }

  private pause(message: string) {
    this.authorization = undefined;
    if (this.run && this.run.state !== 'done') this.update({ ...this.run, state: 'paused', message });
  }

  private finish(message?: string, resolvedRows = this.run!.rows) {
    this.authorization = undefined;
    const rows = resolvedRows.map((row): ReleaseRow => row.state === 'queued' ? { ...row, state: 'skipped' } : row);
    // 正常完成和中断核实共用汇总规则。取消和主动结束保留各自的提示。
    const result = message ?? (rows.every((row) => row.state === 'success') ? '全部成功' :
      rows.some((row) => row.state === 'success' || row.state === 'partial') ? '部分成功' : '发布失败');
    this.update({
      ...this.run!,
      state: 'done', message: result, rows,
    });
  }

  private async next() {
    if (!this.run || this.run.state !== 'running' || this.dispatching || !this.authorization) return;
    const row = this.run.rows.find((item) => item.state === 'queued');
    if (!row) {
      this.finish();
      return;
    }
    const authorization = this.authorization;
    const preview = authorization.previews.find((item) => item.request.serviceId === row.request.serviceId);
    if (!preview) { this.pause('请重新核对待执行服务。'); return; }
    this.dispatching = true;
    let dispatch: ReleaseRow | undefined;
    let started: Task | undefined;
    try {
      if (this.api.unfinished()) throw new Error('仍有部署任务待核实。');
      if (this.cancelRequested) return;
      // 每次重新预检，避免前一服务执行过久导致令牌过期，也防止确认过的信息变化。
      const prepared = await this.api.prepare(row.request, true);
      if (this.cancelRequested) return;
      if (reviewedDetails(prepared.task) !== reviewedDetails(preview.task))
        throw new Error('服务配置或产物已变化，请重新核对后续服务。');
      dispatch = { ...row, taskId: prepared.task.id, state: 'starting' };
      this.replace(dispatch, 'running', '', true);
      const serverIds = new Set(prepared.task.targets.map((item) => item.server.id));
      started = await this.api.start(prepared.token,
        Object.fromEntries(Object.entries(authorization.credentials).filter(([id]) => serverIds.has(id))),
        authorization.approval, this.run.id!);
      if (started.id !== dispatch.taskId) throw new Error('执行任务与清单记录不一致。');
      this.replace({ ...dispatch, state: 'running' }, this.cancelRequested ? 'cancelling' : 'running');
      if (this.cancelRequested && running(started)) await this.api.cancel(started.id);
    } catch (error) {
      const explanation = error instanceof Error ? error.message : String(error);
      this.pause(row.name + ' · ' + explanation);
    } finally {
      this.dispatching = false;
      if (this.cancelRequested && this.get()?.state === 'cancelling' && !dispatch) this.finish('已取消');
    }
    if (started && this.terminalEvent === started.id) await this.check(started.id, true);
  }

  observe(task: Task) {
    if (!running(task) &&
        this.run && (this.run.state === 'running' || this.run.state === 'cancelling') &&
        this.run.rows.some((row) => row.taskId === task.id && inFlight(row))) {
      if (this.dispatching || this.settling) this.terminalEvent = task.id;
      else void this.check(task.id, true);
    }
  }

  async check(id?: string, automatic = false) {
    if (this.dispatching || this.settling || !this.run || this.run.state === 'done') return;
    const row = this.run.rows.find((item) => inFlight(item) && item.taskId && (!id || item.taskId === id));
    if (!row?.taskId) return;
    this.settling = true;
    if (this.terminalEvent === row.taskId) this.terminalEvent = undefined;
    let proceed = false;
    try {
      if (!automatic && this.api.active()) {
        this.pause('当前部署任务尚未完成保存，请稍后再刷新核实结果。');
        return;
      }
      const task = await this.api.readTask(row.taskId);
      if (!task || task.service.id !== row.request.serviceId) throw new Error('没有对应的本机任务记录。');
      if (task.status === 'running' || task.status === 'cancelling') {
        if (!automatic) this.pause('当前任务仍在执行，请等待结束后再核实。');
        return;
      }
      if (unknown(task)) {
        this.replace({ ...row, state: 'unknown', elapsed: task.elapsed }, 'paused', '当前服务结果待核实。请在任务详情中核实原任务。');
        this.authorization = undefined;
        return;
      }
      const detail = task.targets.find((item) => item.error)?.error;
      const unverifiedTargets = task.targets.filter((item) => item.status === 'unverified').length;
      if (task.status === 'interrupted') return;
      const resolved: ReleaseRow = { ...row, state: task.status, elapsed: task.elapsed, detail, unverifiedTargets };
      const rows = this.run.rows.map((item) => item === row ? resolved : item);
      // 子任务结果和清单去向一起保存，避免崩溃恢复时丢失停止策略。
      if (this.cancelRequested || task.status === 'cancelled') this.finish('已取消', rows);
      else if (task.status !== 'success' && this.run.failurePolicy === 'stop') this.finish(undefined, rows);
      else if (!rows.some((item) => item.state === 'queued')) this.finish(undefined, rows);
      else if (this.run.state === 'paused') {
        this.update({ ...this.run, rows, message: '原任务已核实。可重新确认后续服务。' });
      } else {
        this.update({ ...this.run, rows });
        proceed = automatic && this.run.state === 'running';
      }
    } catch {
      this.pause('本机暂时无法读取已启动任务的结果。请核实原任务后再处理后续服务。');
    } finally {
      this.settling = false;
      if (this.terminalEvent === row.taskId) {
        this.terminalEvent = undefined;
        if (this.run.rows.some((item) => item.taskId === row.taskId && (item.state === 'running' || item.state === 'starting')))
          void this.check(row.taskId, automatic);
      }
    }
    if (proceed) void this.next();
  }

  async cancel() {
    if (!this.run || this.run.state !== 'running') return;
    this.cancelRequested = true;
    this.update({ ...this.run, state: 'cancelling', message: '正在等待当前服务到达安全点，后续服务不会启动。' });
    if (this.dispatching) return;
    const row = this.run.rows.find(inFlight);
    if (row?.taskId) {
      try { await this.api.cancel(row.taskId); }
      catch { this.pause('未能确认取消请求。请检查当前任务并核实结果，后续服务不会启动。'); }
    } else this.finish('已取消');
  }

  end() {
    if (this.run?.state === 'paused' && !this.dispatching && !this.settling) this.finish('已结束 · 保留原任务状态');
  }
}
