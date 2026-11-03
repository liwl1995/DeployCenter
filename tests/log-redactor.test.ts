// @vitest-environment node
import { it, expect } from 'vitest';
import { LineRedactor } from '../electron/log-redactor';
it('容器日志的口令和中文跨分片时仍正确脱敏', () => {
  const redact = new LineRedactor({ password: 'private-fixture' });
  const data = Buffer.from('中文 password=private-fixture\n');
  expect(redact.write(data.subarray(0, 2))).toBe('');
  expect(redact.write(data.subarray(2, 16))).toBe('');
  const output = redact.write(data.subarray(16));
  expect(output).toContain('中文');
  expect(output).not.toContain('private-fixture');
  expect(redact.end()).toBe('');
});
