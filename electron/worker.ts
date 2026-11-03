import type {} from 'electron';
import { MemoryCredentials } from './native-capabilities';
import { Deployment } from './deployment';
import { errorText, type ControlMessage, type WorkerMessage } from './contracts';
import type { TrustRequest } from '../src/platform';
const port = process.parentPort;
let deployment: Deployment | undefined;
let secrets = new MemoryCredentials({});
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
port?.on('message', (event) => {
  const message = event.data as ControlMessage;
  if (message.kind === 'begin') {
    secrets = new MemoryCredentials(message.value.credentials);
    deployment = new Deployment(message.value, send, ask);
    void deployment.run().catch((e) => send({ kind: 'fatal', error: errorText(e) }));
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
