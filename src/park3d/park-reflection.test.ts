import { expect, test } from 'bun:test';
import { WebGLRenderTarget } from 'three';
import { ParkReflectionQuality, parkReflectionSize } from './park-reflection';

test('reflection resolution follows landscape, portrait and high-DPI buffers within its pixel budget', () => {
  for (const [width, height] of [[1280, 900], [2560, 1800], [780, 1688], [7680, 4320]]) {
    const size = parkReflectionSize(width!, height!);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(1536);
    expect(size.width * size.height).toBeLessThanOrEqual(1536 * 1536);
    expect(size.width / size.height).toBeCloseTo(width! / height!, 1);
  }
  expect(parkReflectionSize(2560, 1800).width).toBeGreaterThan(768);
});

test('reflection target survives resizing and only reallocates after the new buffer size settles', () => {
  const target = new WebGLRenderTarget(768, 768);
  let releases = 0; target.addEventListener('dispose', () => releases++);
  const quality = new ParkReflectionQuality(target, 4);
  expect(target.samples).toBe(4);
  expect(quality.update(2560, 1800, 0)).toBe(true);
  const warmReleases = releases;
  expect(quality.update(2560, 1800, 100)).toBe(false);
  expect(quality.update(780, 1688, 200)).toBe(false);
  expect(quality.update(790, 1688, 300)).toBe(false);
  expect(quality.update(780, 1688, 451)).toBe(false);
  expect(quality.update(780, 1688, 650)).toBe(false);
  expect(quality.update(780, 1688, 702)).toBe(true);
  expect(target.width).toBeLessThan(target.height);
  expect(releases).toBe(warmReleases + 1);
  expect(quality.update(780, 1688, 900)).toBe(false);
  const conservative = new ParkReflectionQuality(target, 0);
  expect(target.samples).toBe(0);
  expect(conservative.update(780, 1688, 1000)).toBe(false);
  target.dispose();
});
