import type {} from 'electron';
import { MemoryCredentials } from './native-capabilities';
import { Deployment } from './deployment';
import { errorText, type ControlMessage, type WorkerMessage } from './contracts';
import type { Receipt } from './workbench';
import type { Task } from '../src/model';
import type { TrustRequest } from '../src/platform';
const port = process.parentPort;
let deployment: Deployment | undefined;
let secrets = new MemoryCredentials({});
const handoffs = new Map<string, (error?: string) => void>();
const trust = new Map<string, (value: boolean) => void>();
const send = (message: WorkerMessage) => {
  if (message.kind === 'fatal') message.error = secrets.redact(message.error);
  port?.postMessage(message);
  if (message.kind === 'done') secrets.clear();
};
function ask(request: TrustRequest, key: string) {
  return new Promise<boolean>((resolve) => {
    trust.set(request.id, resolve);
    send({ kind: 'trust', request, key });
  });
}
function persist(task: Task, targetId: string, receipt: Receipt) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      handoffs.delete(receipt.owner);
      reject(new Error('本机保存确认超时，远端工作台已保留'));
    }, 60000);
    handoffs.set(receipt.owner, (error) => {
      clearTimeout(timer);
      handoffs.delete(receipt.owner);
      if (error) reject(new Error(error));
      else resolve();
    });
    send({ kind: 'handoff', task, targetId, receipt });
  });
}
port?.on('message', (event) => {
  const message = event.data as ControlMessage;
  if (message.kind === 'begin') {
    secrets = new MemoryCredentials(message.value.credentials);
    deployment = new Deployment(message.value, send, ask, undefined, persist);
    void deployment.run().catch((e) => send({ kind: 'fatal', error: errorText(e) }));
  } else if (message.kind === 'handoff-result') {
    handoffs.get(message.owner)?.(message.error);
  } else if (message.kind === 'cancel') {
    for (const resolve of trust.values()) resolve(false);
    trust.clear();
    void deployment?.cancel();
  } else {
    trust.get(message.id)?.(message.accepted);
    trust.delete(message.id);
  }
});
process.on('uncaughtException', (e) => send({ kind: 'fatal', error: errorText(e) }));
process.on('unhandledRejection', (e) => send({ kind: 'fatal', error: errorText(e) }));
