import type { Task } from '../src/model';
/** 不修补或覆盖损坏记录；无法可靠识别引用关系时，调用方必须保留相关文件。 */
export function parseTaskRecord(raw: string, id?: string): Task {
  const t = JSON.parse(raw) as Task;
  if (
    !t ||
    typeof t.id !== 'string' ||
    (id && t.id !== id) ||
    !/^DC-[a-zA-Z0-9-]+$/.test(t.id) ||
    !['running', 'cancelling', 'success', 'partial', 'failed', 'cancelled', 'interrupted'].includes(
      t.status,
    ) ||
    !['deploy', 'rollback'].includes(t.operation) ||
    typeof t.service?.id !== 'string' ||
    typeof t.service?.name !== 'string' ||
    typeof t.service.git?.branch !== 'string' ||
    typeof t.service.git?.commit !== 'string' ||
    typeof t.service.git?.time !== 'string' ||
    !Number.isFinite(t.elapsed) ||
    !t.artifact ||
    typeof t.artifact.path !== 'string' ||
    !Number.isFinite(t.artifact.size) ||
    t.artifact.size < 0 ||
    (t.artifact.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(t.artifact.sha256)) ||
    !Array.isArray(t.buildSteps) ||
    !Array.isArray(t.targets) ||
    !t.targets.every(
      (r) =>
        typeof r.target?.id === 'string' &&
        typeof r.target?.name === 'string' &&
        typeof r.server?.id === 'string' &&
        typeof r.server?.name === 'string' &&
        Array.isArray(r.steps),
    )
  )
    throw new Error('任务元数据无法读取');
  return t;
}
