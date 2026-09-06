import { mulberry32 } from '../../src/ui/tree/spec';

// Original seeded painters, retained for reproducible offline asset baking.
// Runtime loads their PNG output instead of executing ~360,000 canvas marks.
export function paintWalkTexture(ctx: CanvasRenderingContext2D, size: number,
  kind: 'aggregate' | 'pavers' | 'earth' | 'mulch' | 'boards') {
  if (kind === 'aggregate') {
    const rng = mulberry32(8042);
    ctx.fillStyle = "#dedbd4";
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 260000; i++) {
      const light = 130 + rng() * 115;
      ctx.fillStyle = `rgba(${light},${light},${light},.4)`;
      ctx.fillRect(rng() * size, rng() * size, .5 + rng() * 1.3, .5 + rng() * 1.3);
    }
    return;
  }
  const rng = mulberry32(kind === 'pavers' ? 91877 : kind === 'mulch' ? 71193 : 34491);
  ctx.fillStyle = kind === 'pavers' ? '#a6a49e' : '#d0ccc1'; ctx.fillRect(0, 0, size, size);
  if (kind === 'pavers') {
    // Low-contrast joints and rounded worn edges. The 2 m tile contains four
    // half-metre courses across, without high-contrast baked lighting.
    const rowHeight = size / 6, width = size / 4;
    for (let row = 0; row < 6; row++) for (let col = -1; col <= 4; col++) {
      const x = col * width + row % 2 * width / 2, y = row * rowHeight, tone = 210 + rng() * 16;
      ctx.fillStyle = `rgb(${tone},${tone},${tone * .98})`;
      ctx.beginPath(); ctx.roundRect(x + 1.5, y + 1.5, width - 3, rowHeight - 3, 2); ctx.fill();
      ctx.strokeStyle = 'rgba(248,244,232,.18)'; ctx.lineWidth = 1; ctx.stroke();
    }
  } else if (kind === 'boards') {
    for (let plank = 0; plank < 12; plank++) {
      const x = plank * size / 12, tone = 202 + rng() * 24;
      ctx.fillStyle = `rgb(${tone},${tone},${tone * .96})`; ctx.fillRect(x + 1.5, 0, size / 12 - 3, size);
      for (let grain = 0; grain < 9; grain++) {
        ctx.strokeStyle = 'rgba(86,80,69,.1)'; ctx.lineWidth = .7;
        const gx = x + 3 + rng() * (size / 12 - 6);
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.bezierCurveTo(gx - 2, size / 3, gx + 2, size * 2 / 3, gx, size); ctx.stroke();
      }
    }
  }
  for (let i = 0; i < (kind === 'mulch' ? 7500 : 30000); i++) {
    const x = rng() * size, y = rng() * size, light = 125 + rng() * 120;
    ctx.fillStyle = `rgba(${light},${light},${light * .96},${kind === 'mulch' ? .55 : .25})`;
    if (kind === 'mulch') {
      ctx.save(); ctx.translate(x, y); ctx.rotate(rng() * Math.PI);
      ctx.fillRect(-1, -3, 1 + rng() * 2, 3 + rng() * 7); ctx.restore();
    } else {
      const r = .4 + rng() * (kind === 'earth' ? 2.2 : 1);
      ctx.beginPath(); ctx.ellipse(x, y, r, r * .65, rng() * Math.PI, 0, Math.PI * 2); ctx.fill();
    }
  }
}
