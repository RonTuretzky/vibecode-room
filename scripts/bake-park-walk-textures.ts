import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const output = new URL('public/assets/park/walks/', root);
const kinds = ['aggregate', 'pavers', 'earth', 'mulch', 'boards'] as const;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

if (process.argv.includes('--check')) {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', output), 'utf8'));
  for (const kind of kinds) {
    const bytes = await readFile(new URL(`${kind}.png`, output));
    const entry = manifest.textures.find((t: { name: string }) => t.name === kind);
    if (!entry || digest(bytes) !== entry.sha256 || bytes.readUInt32BE(16) !== entry.size || bytes.readUInt32BE(20) !== entry.size) {
      throw new Error(`Baked walk texture mismatch: ${kind}`);
    }
  }
  console.log('Five baked walk textures match their manifest.');
} else {
  const build = await Bun.build({ entrypoints: [fileURLToPath(new URL('scripts/lib/park-walk-texture-paint.ts', root))], target: 'browser', format: 'esm' });
  if (!build.success) throw new Error(build.logs.join('\n'));
  const source = await build.outputs[0]!.text();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    const images = await page.evaluate(async ({ source, kinds }) => {
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const { paintWalkTexture } = await import(/* @vite-ignore */ url);
      URL.revokeObjectURL(url);
      return kinds.map(name => {
        const canvas = document.createElement('canvas'), size = name === 'aggregate' ? 1024 : 512;
        canvas.width = canvas.height = size;
        paintWalkTexture(canvas.getContext('2d')!, size, name);
        return { name, size, data: canvas.toDataURL('image/png').split(',')[1]! };
      });
    }, { source, kinds });
    await mkdir(output, { recursive: true });
    const textures = [];
    for (const { name, size, data } of images) {
      const bytes = Buffer.from(data, 'base64');
      await writeFile(new URL(`${name}.png`, output), bytes);
      textures.push({ name, size, bytes: bytes.length, sha256: digest(bytes) });
    }
    await writeFile(new URL('manifest.json', output), JSON.stringify({
      source: 'Original seeded canvas painters in scripts/lib/park-walk-texture-paint.ts; illustrative materials, not surveyed finishes.',
      textures,
    }, null, 2) + '\n');
    console.log(textures);
  } finally { await browser.close(); }
}
