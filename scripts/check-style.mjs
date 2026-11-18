import fs from 'node:fs/promises';

const root = new URL('../src/', import.meta.url);
const rules = {
  gap: /^(?:0|normal|var\(--space-\d+\))(?:\s+(?:0|var\(--space-\d+\)))?$/,
  'border-radius': /^(?:0|var\(--radius-(?:control|panel|dialog|pill|circle)\))$/,
  'font-weight': /^(?:400|600|inherit)$/,
};

for (const file of ['style.css', 'design/tokens.css']) {
  const source = (await fs.readFile(new URL(file, root), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, property, value] of source.matchAll(
    /(?:^|[;{])\s*((?:(?:row|column)-)?gap|border-radius|font-weight)\s*:\s*([^;}]+)/gm,
  )) {
    if (!rules[property.endsWith('gap') ? 'gap' : property].test(value.trim())) {
      process.exitCode = 1;
      console.error(`${file}: ${property}: ${value.trim()}，请使用界面设计令牌。`);
    }
  }
}
