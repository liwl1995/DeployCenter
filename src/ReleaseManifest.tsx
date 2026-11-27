import { ArrowLeft, ChevronRight, GripVertical, ListOrdered, Plus, Rocket, X } from 'lucide-react';
import { useRef, useState, type RefObject } from 'react';
import { BuildModeChoice } from './BuildArtifactChoice';
import { ConfirmTargets } from './ConfirmTargets';
import { ConfirmWarning, confirmationWarnings } from './ConfirmWarning';
import { DeploymentTargetRow } from './DeploymentTargetRow';
import { DeployFailurePolicy } from './DeployFailurePolicy';
import { TargetObservationOverride } from './TargetObservationOverride';
import { ArtifactInfo } from './ArtifactInfo';
import { HashValue } from './DeployDetails';
import { credentialServers } from './credentials';
import { Button } from './design/ui/button';
import { Checkbox } from './design/ui/checkbox';
import { confirmProduction, productionNames } from './presentation';
import { seconds, type Database, type Target, type Task } from './model';
import { EntityIcon } from './entity-icons';
import { deploymentStage, deploymentStages } from './step-names';
import { useTaskClock } from './task-clock';
import type { DesktopAPI } from './platform';
import type { ReleaseRequest, ReleaseReview, ReleaseRow, ReleaseRun } from './serial-release';
import { Badge, Card, Field, Modal } from './ui';

export type ReleaseDraft = Omit<ReleaseRequest, 'failurePolicy'>[];
const labels: Record<ReleaseRow['state'], string> = {
  queued: '等待', starting: '正在启动', running: '执行中', success: '成功', partial: '部分成功',
  failed: '失败', cancelled: '已取消', unknown: '待核实', skipped: '未执行',
};

function LivePhase({ snapshot }: { snapshot: Task }) {
  const task = useTaskClock(snapshot);
  const build = task.buildSteps.some((step) => step.status === 'running');
  const target = task.targets[task.active];
  const step = target?.steps.find((entry) => entry.status === 'running');
  const phase = task.status === 'cancelling' ? '等待安全取消' :
    step ? deploymentStages[deploymentStage(step.key)] : build ? deploymentStages[0] : '执行中';
  return <p className="release-live-phase">{phase}{step ? ' · ' + target.target.name : ''} · {seconds(task.elapsed)}</p>;
}

export function ReleaseManifest({ api, db, run, liveTask, showRun, setShowRun, draft, setDraft, saved, blocked, onTask, onHistory, onCopy, board, policy, onPolicy, onEditTarget }: {
  api: DesktopAPI;
  db: Database;
  run: ReleaseRun | null;
  liveTask: Task | null;
  showRun: boolean;
  setShowRun: (value: boolean) => void;
  draft: ReleaseDraft;
  setDraft: (value: ReleaseDraft | ((old: ReleaseDraft) => ReleaseDraft)) => void;
  saved: string[];
  blocked: boolean;
  onTask: (id: string) => void;
  onHistory: (releaseId: string) => void;
  onCopy: (value: string) => void;
  onEditTarget: (target: Target) => void;
  board: RefObject<HTMLDivElement | null>;
  policy: Database['settings']['failurePolicy'] | null;
  onPolicy: (value: Database['settings']['failurePolicy'] | null) => void;
}) {
  const [confirmation, setConfirmation] = useState<ReleaseReview>();
  const review = confirmation?.previews ?? [];
  const [resume, setResume] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [modal, setModal] = useState<'add' | 'cancel' | 'end'>();
  const [picks, setPicks] = useState<string[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [allowWeak, setAllowWeak] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drop, setDrop] = useState('');
  const dragging = useRef('');
  const active = run?.state === 'running' || run?.state === 'cancelling';
  const current = run?.rows.find((row) => row.state === 'starting' || row.state === 'running');
  const awaiting = run?.rows.find((row) => row.state === 'unknown' || row === current);
  const processed = run?.rows.filter((row) => !['queued', 'starting', 'running', 'unknown'].includes(row.state)).length ?? 0;
  const unverifiedTargets = run?.rows.reduce((sum, row) => sum + (row.unverifiedTargets ?? 0), 0) ?? 0;
  const step = review.length ? 1 : run && (showRun || active || run.state === 'paused') ? 2 : 0;
  const defaults = db.settings.failurePolicy;
  const selectedTargets = draft.flatMap((row) => row.targetIds);
  const pending = run?.rows.filter((row) => row.state === 'queued') ?? [];
  const unresolved = run?.rows.some((row) => row.state === 'starting' || row.state === 'running' || row.state === 'unknown');
  const available = db.services.filter((item) => !draft.some((row) => row.serviceId === item.id));
  const target = (id: string) => db.targets.find((item) => item.id === id);
  const valid = draft.length >= 2 && draft.every((row) => db.services.some((item) => item.id === row.serviceId) &&
    row.targetIds.length && row.targetIds.every((id) => target(id)?.serviceId === row.serviceId));

  function patch(serviceId: string, change: (row: ReleaseDraft[number]) => ReleaseDraft[number]) {
    setDraft((old) => old.map((row) => row.serviceId === serviceId ? change(row) : row));
  }
  function move(serviceId: string, destination: string) {
    if (serviceId === destination) return;
    setDraft((old) => {
      const source = old.findIndex((item) => item.serviceId === serviceId);
      const to = old.findIndex((item) => item.serviceId === destination);
      if (source < 0 || to < 0) return old;
      const next = [...old];
      next.splice(to, 0, next.splice(source, 1)[0]);
      return next;
    });
  }
  function clearApproval() {
    setNames({});
    setCredentials({});
    setAllowWeak(false);
  }
  async function action(callback: () => Promise<void>) {
    setError('');
    setBusy(true);
    try { await callback(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  function prepare(restarting = false) {
    void action(async () => {
      await api.save(db);
      const requests = restarting ? pending.map((item) => item.request) :
        draft.map((row) => ({ ...row, failurePolicy: defaults }));
      const next = await api.previewRelease(requests);
      clearApproval();
      setResume(restarting);
      setConfirmation(next);
      board.current?.scrollTo(0, 0);
    });
  }
  async function chooseJar(serviceId: string) {
    await action(async () => {
      const path = await api.choose('jar');
      if (!path) return;
      await api.inspectJar(path);
      patch(serviceId, (row) => ({ ...row, jarPath: path }));
    });
  }

  const servers = credentialServers(review.flatMap(({ task }) => task.targets.map((item) => item.server)));
  const production = review.flatMap(({ task }) => productionNames(task));
  const weak = review.some(({ task }) => task.targets.some((item) => item.target.hashPolicy === 'size-confirm'));
  const missingPassword = servers.some((item) => item.auth === 'password' &&
    !(item.credentialMode === 'windows' && saved.includes(item.id)) && !credentials[item.id]);
  const approved = review.every(({ task }) => confirmProduction(task, names)) && (!weak || allowWeak) && !missingPassword;
  const confirmedPolicy = resume ? run?.failurePolicy ?? defaults : policy ?? defaults;
  const policyText = confirmedPolicy === 'stop' ? '失败后停止后续服务' : '失败后继续其他服务';
  const previewTargets = review.flatMap(({ task }) => task.targets);
  const warnings = review.flatMap(({ task }) => confirmationWarnings(task, true));
  const stage = (task: Task) => task.targets.map((item) => item.target.name).join('、');

  return (
    <section className="release-manifest" aria-label="发布清单">
      <ol className="release-steps" aria-label="发布步骤">
        {['编排', '确认', '执行'].map((label, index) => (
          <li key={label} aria-current={step === index ? 'step' : undefined}>
            <span>{index + 1}</span>{label}
          </li>
        ))}
      </ol>
      <div className="release-board" ref={board}>
        {error && <p className="warning" role="alert">{error}</p>}
        {step === 0 && <>
          <div className="release-heading">
            <div><h2>执行顺序</h2><p className="note">按清单顺序逐个发布服务。</p></div>
            <Button size="compact" disabled={busy || !available.length} onClick={() => { setPicks([]); setModal('add'); }}>
              <Plus size={15} />添加服务
            </Button>
          </div>
          {!draft.length && <div className="empty service-empty">
            <ListOrdered size={24} /><strong>清单里还没有服务</strong>
            <span>添加至少两个服务，再选择各自的部署目标。</span>
          </div>}
          {draft.map((row, index) => {
            const service = db.services.find((item) => item.id === row.serviceId);
            const targets = db.targets.filter((item) => item.serviceId === row.serviceId);
            return <Card key={row.serviceId} className={'release-service' + (drop === row.serviceId ? ' release-drop' : '')}>
              <div className="release-heading" onDragOver={(event) => {
                if (!dragging.current) return;
                event.preventDefault();
                setDrop(dragging.current === row.serviceId ? '' : row.serviceId);
              }} onDrop={(event) => {
                event.preventDefault();
                move(dragging.current, row.serviceId);
                dragging.current = '';
                setDrop('');
              }}>
                <div className="row">
                  <Button type="button" variant="ghost" size="icon-compact" className="release-grip"
                    aria-label={'拖动排序 ' + (service?.name ?? row.serviceId)} draggable={!busy}
                    title="拖动调整顺序，也可使用 Alt+↑ / Alt+↓"
                    onDragStart={(event) => {
                      dragging.current = row.serviceId;
                      event.dataTransfer.setData('text/plain', row.serviceId);
                      event.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => { dragging.current = ''; setDrop(''); }}
                    onKeyDown={(event) => {
                      if (busy || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                      const destination = draft[index + (event.key === 'ArrowUp' ? -1 : 1)];
                      if (destination) { event.preventDefault(); move(row.serviceId, destination.serviceId); }
                    }}><GripVertical size={16} /></Button>
                  <small className="release-order">{index + 1}</small><h3 className="release-service-name"><EntityIcon kind="service" icon={service?.icon} size={17} strokeWidth={1.75} />{service?.name ?? '服务已删除'}</h3>
                </div>
                <div className="row wrap">
                  {!busy && <BuildModeChoice mode={row.build}
                    onMode={(build) => patch(row.serviceId, (current) => ({ ...current, build }))} />}
                  <Button variant="ghost" size="icon-compact" disabled={busy}
                    aria-label={'移除 ' + (service?.name ?? row.serviceId)}
                    onClick={() => setDraft((old) => old.filter((item) => item.serviceId !== row.serviceId))}>
                    <X size={15} />
                  </Button>
                </div>
              </div>
              {row.build === 'existing' && <div className="row wrap release-jar">
                <small className="path">{row.jarPath || '使用服务配置的 JAR 路径'}</small>
                <Button size="compact" variant="neutral" disabled={busy} onClick={() => void chooseJar(row.serviceId)}>选择本地 JAR</Button>
                {row.jarPath && <Button size="compact" variant="link" disabled={busy}
                  onClick={() => patch(row.serviceId, (current) => ({ ...current, jarPath: undefined }))}>使用默认路径</Button>}
              </div>}
              <fieldset className="deployment-targets release-targets" aria-label={(service?.name ?? row.serviceId) + ' 部署目标'} disabled={busy}>
                {targets.map((item) => (
                  <DeploymentTargetRow key={item.id} target={item} server={db.servers.find((s) => s.id === item.serverId)}
                    checked={row.targetIds.includes(item.id)}
                    onChecked={() => patch(row.serviceId, (current) => ({
                      ...current, targetIds: current.targetIds.includes(item.id)
                        ? current.targetIds.filter((id) => id !== item.id) : [...current.targetIds, item.id],
                    }))}
                    open={expanded.includes(item.id)}
                    onOpen={() => setExpanded((old) => old.includes(item.id) ? old.filter((id) => id !== item.id) : [...old, item.id])}
                    backup={row.overrides[item.id] ?? item.backup}
                    overridden={!!row.overrides[item.id]}
                    onBackup={(backup) => patch(row.serviceId, (current) => ({
                      ...current, overrides: { ...current.overrides, [item.id]: backup },
                    }))}
                    onRestore={() => patch(row.serviceId, (current) => {
                      const overrides = { ...current.overrides };
                      delete overrides[item.id];
                      return { ...current, overrides };
                    })} onCopy={onCopy} onEdit={() => onEditTarget(item)}>
                    <TargetObservationOverride target={item} override={row.observationOverrides?.[item.id]}
                      onChange={(observation) => patch(row.serviceId, (current) => {
                        const observationOverrides = { ...current.observationOverrides };
                        if (observation) observationOverrides[item.id] = observation;
                        else delete observationOverrides[item.id];
                        return { ...current, observationOverrides };
                      })} />
                  </DeploymentTargetRow>
                ))}
              </fieldset>
              {!targets.length && <p className="note">这个服务还没有部署目标，请先到「部署目标」配置。</p>}
              {!!targets.length && !row.targetIds.length && <p className="note">请选择这个服务的部署目标。</p>}
              <details className="workspace-disclosure release-note">
                <summary>本次备注{row.note && ' · 已填写'}</summary>
                <Field label="备注"><input value={row.note ?? ''} disabled={busy}
                  onChange={(event) => patch(row.serviceId, (current) => ({ ...current, note: event.target.value }))} /></Field>
              </details>
            </Card>;
          })}
        </>}
        {step === 1 && <>
          <div className="release-review-summary">
            <strong>核对本次发布</strong>
            <span className="note">{review.length} 个服务 · {previewTargets.length} 个目标 · {policyText}</span>
            {production.length > 0 && <Badge kind="warn">{production.length} 个正式目标</Badge>}
            <ConfirmWarning warnings={warnings} />
          </div>
          {review.map(({ task }, index) => (
            <Card className="release-review" key={task.service.id}>
              <div className="confirm-header">
                <small className="release-order">{index + 1}</small>
                <h3 className="release-service-name"><EntityIcon kind="service" icon={task.service.icon} size={17} strokeWidth={1.75} />{task.service.name}</h3>
                <Badge>{task.build === 'rebuild' ? '重新构建一次' : '使用现有 JAR'}</Badge>
              </div>
              <p className="confirm-brief">{stage(task)} · {task.failurePolicy === 'stop' ? '失败后停止后续目标' : '失败后继续其他目标'}</p>
              {task.note && <p className="note">本次内容：{task.note}</p>}
              <ConfirmTargets task={task} />
              {productionNames(task).length > 0 && <div className="production-confirm">
                <strong>正式环境确认</strong>
                {productionNames(task).map(({ id, name }) => <Field key={id} label={'输入环境名称：' + name}>
                  <input value={names[id] ?? ''} placeholder={name} autoComplete="off"
                    onChange={(event) => setNames((old) => ({ ...old, [id]: event.target.value }))} />
                </Field>)}
              </div>}
              <details className="workspace-disclosure">
                <summary>构建、产物与 Git 详情</summary>
                {task.build === 'rebuild' && <dl className="detail-list">
                  <dt>构建命令</dt><dd className="path">{task.buildContext.command}</dd>
                  <dt>构建目录</dt><dd className="path">{task.buildContext.workDir}</dd>
                  <dt>构建 JDK</dt><dd>{task.buildContext.jdk}</dd>
                </dl>}
                <ArtifactInfo value={task.artifact} />
                <p className="branch">{task.service.git.branch} <HashValue label="Git 提交" value={task.service.git.commit} onCopy={onCopy} /></p>
              </details>
            </Card>
          ))}
          {weak && <label className="check-row warning"><input type="checkbox" checked={allowWeak}
            onChange={(event) => setAllowWeak(event.target.checked)} />确认允许目标在缺少 SHA-256 工具时仅校验字节数</label>}
          {!!servers.length && <Card title="本次认证" className="release-review">
            {servers.map((server) => <Field key={server.id} label={server.name + ' · ' +
              (server.auth === 'password' ? '登录密码' : '私钥口令（未加密可留空）')}
              hint={server.credentialMode === 'windows'
                ? saved.includes(server.id) ? '留空复用已保存的凭据，输入新值将更新。' : '输入后使用当前 Windows 用户加密保存。'
                : '仅用于本次发布，清单暂停或结束后清除。'}>
              <input type="password" autoComplete="off" value={credentials[server.id] ?? ''}
                onChange={(event) => setCredentials((old) => ({ ...old, [server.id]: event.target.value }))} />
            </Field>)}
          </Card>}
        </>}
        {step === 2 && run && <>
          <div className="release-result" role="status">
            <div className="release-heading">
              <strong className="release-service-name">{run.state === 'done' ? run.message : `已处理 ${processed} / ${run.rows.length} 个服务`}</strong>
              {run.state === 'paused' && <Badge kind="warn">已暂停</Badge>}
              {active && current && <span className="note">当前服务 · {current.name}</span>}
            </div>
            {active && <progress aria-label="清单处理进度" max={run.rows.length} value={processed} />}
            {run.state === 'cancelling' && <p className="note">{run.message}</p>}
            {run.state === 'paused' && <p className="note">{awaiting && <strong>{awaiting.name} · </strong>}{run.message}</p>}
            {run.state === 'done' && <div className="row wrap release-totals">
              {(['success', 'partial', 'failed', 'cancelled', 'unknown', 'skipped'] as const).map((state) => {
                const count = run.rows.filter((row) => row.state === state).length;
                return (count > 0 || state === 'success') && <span key={state}>{labels[state]} {count} 个服务</span>;
              })}
            </div>}
            {unverifiedTargets > 0 && <p className="note">{unverifiedTargets} 个目标健康未验证</p>}
          </div>
          <div className="release-run-list">
            {run.rows.map((row, index) => {
              const service = db.services.find((item) => item.id === row.request.serviceId);
              const Row = row.taskId ? 'button' : 'div';
              return <Row className={'release-run-row release-' + row.state} key={row.request.serviceId}
                type={row.taskId ? 'button' : undefined} onClick={row.taskId ? () => onTask(row.taskId!) : undefined}
                aria-label={row.taskId ? '查看 ' + row.name + ' 执行日志' : undefined}>
                <small className="release-order">{index + 1}</small>
                <div className="grow"><div className="row wrap"><strong className="release-run-name"><EntityIcon kind="service" icon={service?.icon} size={16} strokeWidth={1.75} />{row.name}</strong>
                  <Badge kind={row.state === 'success' ? 'good' : row.state === 'failed' || row.state === 'partial' ? 'danger' : row.state === 'unknown' ? 'warn' : ''}>{labels[row.state]}</Badge>
                  {row.elapsed !== undefined && <small>{seconds(row.elapsed)}</small>}</div>
                  <small>{row.targets.join('、')}</small>
                  {active && row === current && liveTask?.id === row.taskId && liveTask &&
                    <LivePhase key={liveTask.id} snapshot={liveTask} />}
                  {!!row.unverifiedTargets && <p className="note">{row.unverifiedTargets} 个目标健康未验证</p>}
                  {row.detail && <p className="note">{row.detail}</p>}
                </div>
                {row.taskId && <span className="row release-log-link">执行日志<ChevronRight size={14} /></span>}
              </Row>;
            })}
          </div>
        </>}
      </div>
      <div className="deployment-footer" aria-label="发布清单操作">
        <div className="deployment-count">
          <strong>{step === 0 ? draft.length + ' 个服务 · ' + selectedTargets.length + ' 个目标' :
            step === 1 ? review.length + ' 个待发布服务' : run?.state === 'done' ? '清单已结束' : '发布进度'}</strong>
          <small>{step === 0 ? '每个服务独立生成部署任务' : step === 1 && production.length
            ? production.filter(({ id, name }) => names[id] === name).length + ' / ' + production.length + ' 个正式目标已确认'
            : step === 1 ? '确认后按顺序执行' : '从服务行进入完整执行日志'}</small>
        </div>
        {step === 0 && <>
          <DeployFailurePolicy manifest value={policy} fallback={defaults} onChange={onPolicy} />
          <Button disabled={!valid || busy || blocked} onClick={() => prepare()}>下一步：确认</Button>
        </>}
        {step === 1 && <>
          <Button variant="neutral" onClick={() => { setConfirmation(undefined); clearApproval(); setError(''); board.current?.scrollTo(0, 0); }}>
            <ArrowLeft size={15} />{resume ? '返回清单' : '返回修改'}
          </Button>
          <Button disabled={!approved || busy || blocked} onClick={() => void action(async () => {
            if (!confirmation) return;
            await api.startRelease(confirmation.token, credentials, { productionWord: '', productionNames: names, allowWeak, protectCurrent: true }, confirmedPolicy, resume);
            clearApproval();
            setConfirmation(undefined);
            setShowRun(true);
            board.current?.scrollTo(0, 0);
          })}><Rocket size={15} />开始发布</Button>
        </>}
        {step === 2 && run?.state === 'running' && <Button variant="danger" onClick={() => setModal('cancel')}>取消清单</Button>}
        {step === 2 && run?.state === 'cancelling' && <Button variant="neutral" disabled>正在取消</Button>}
        {step === 2 && run?.state === 'paused' && <>
          <Button variant="danger" disabled={busy} onClick={() => setModal('end')}>结束清单</Button>
          {unresolved ? <Button disabled={busy} onClick={() => void action(() => api.checkRelease())}>刷新核实结果</Button>
            : <Button disabled={!pending.length || busy || blocked} onClick={() => prepare(true)}>复核未执行服务</Button>}
        </>}
        {step === 2 && run?.state === 'done' && run.id && run.rows.some((row) => row.taskId) &&
          <Button variant="neutral" onClick={() => onHistory(run.id!)}>查看清单历史</Button>}
        {step === 2 && run?.state === 'done' && <Button onClick={() => {
          setDraft((old) => old.map((row) => ({
            ...row,
            // 开始新一轮清单前，正式目标需要重新选择。
            targetIds: row.targetIds.filter((id) => target(id)?.production === false),
          })));
          setShowRun(false);
          setError('');
          board.current?.scrollTo(0, 0);
        }}>返回清单配置</Button>}
      </div>
      {modal === 'add' && <Modal title="添加服务" onClose={() => setModal(undefined)} footer={<>
        <Button variant="neutral" onClick={() => setModal(undefined)}>取消</Button>
        <Button disabled={!picks.length} onClick={() => {
          setDraft((old) => [...old, ...picks.map((serviceId): ReleaseDraft[number] => ({ serviceId, targetIds: [], build: 'rebuild', overrides: {} }))]);
          setModal(undefined);
        }}>加入清单</Button>
      </>}>
        <div className="release-add">{available.map((item) => (
          <label className="row" key={item.id}><Checkbox checked={picks.includes(item.id)} aria-label={item.name}
            onCheckedChange={(checked) => setPicks((old) => checked ? [...old, item.id] : old.filter((id) => id !== item.id))} />
            <EntityIcon kind="service" icon={item.icon} size={16} strokeWidth={1.75} />
            <strong>{item.name}</strong>{item.description && <small>{item.description}</small>}</label>
        ))}</div>
      </Modal>}
      {modal && modal !== 'add' && <Modal title={modal === 'cancel' ? '取消发布清单？' : '结束发布清单？'}
        onClose={() => setModal(undefined)} footer={<>
          <Button variant="neutral" onClick={() => setModal(undefined)}>返回</Button>
          <Button variant="danger" onClick={() => {
            setModal(undefined);
            void action(() => modal === 'cancel' ? api.cancelRelease() : api.endRelease());
          }}>{modal === 'cancel' ? '确认取消' : '确认结束'}</Button>
        </>}>
        <p>{modal === 'cancel' ? '当前任务会在安全点停下，后续服务不会启动。已完成的结果会保留。'
          : '后续服务不会启动，原任务与待核实现场会保留。'}</p>
      </Modal>}
    </section>
  );
}
