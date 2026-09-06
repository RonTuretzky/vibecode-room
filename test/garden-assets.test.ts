import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { FLORA_MODELS } from '../src/ui/garden-flora';

test('packed cutout foliage retains alpha-capable base-color images', () => {
  let cutouts = 0;
  for (const model of FLORA_MODELS) {
    const glb = readFileSync(new URL(`../public/assets/garden/models/${model}.glb`, import.meta.url));
    expect(glb.readUInt32LE(0)).toBe(0x46546c67);
    expect(glb.readUInt32LE(8)).toBe(glb.length);
    const jsonSize = glb.readUInt32LE(12);
    const doc = JSON.parse(glb.subarray(20, 20 + jsonSize).toString());
    const bin = glb.subarray(28 + jsonSize);
    for (const view of doc.bufferViews) {
      expect(view.byteOffset % 4).toBe(0);
      expect(view.byteOffset + view.byteLength).toBeLessThanOrEqual(bin.length);
    }
    for (const material of doc.materials) {
      if (!material.alphaMode || material.alphaMode === 'OPAQUE') continue;
      const image = doc.images[doc.textures[material.pbrMetallicRoughness.baseColorTexture.index].source];
      const view = doc.bufferViews[image.bufferView];
      const bytes = bin.subarray(view.byteOffset, view.byteOffset + view.byteLength);
      // The former JPEGs made alphaTest ineffective and exposed leaf cards.
      expect(image.mimeType, `${model}: ${material.name}`).toBe('image/png');
      expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(bytes.subarray(12, 16).toString()).toBe('IHDR');
      expect(bytes[25]).toBe(6); // RGBA, not an opaque RGB PNG.
      cutouts++;
    }
  }
  expect(cutouts).toBe(7);
});
