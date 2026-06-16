import { useMemo } from "react";

/**
 * The Deep — ambient abyss backdrop.
 *
 * Pure CSS/SVG (no WebGL/canvas, per DESIGN.md): a vertical abyss gradient,
 * 2–3 slow-drifting radial "aurora" glows (deep teal + faint indigo), a subtle
 * vignette, a faint grain so the projector never bands, and slow particle drift.
 * Everything animates with transform/opacity only and freezes under
 * prefers-reduced-motion. Deterministic by seed so SSR and client agree.
 */

interface Particle {
  left: number;
  top: number;
  size: number;
  delay: number;
  duration: number;
  drift: number;
  opacity: number;
}

// Tiny deterministic PRNG (mulberry32) so the particle field is identical on
// server and client renders — no Math.random() hydration mismatch.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeParticles(count: number, seed: number): Particle[] {
  const rand = mulberry32(seed);
  const particles: Particle[] = [];
  for (let i = 0; i < count; i += 1) {
    particles.push({
      left: rand() * 100,
      top: rand() * 100,
      size: 1 + rand() * 3,
      delay: -rand() * 40,
      duration: 26 + rand() * 36,
      drift: (rand() - 0.5) * 60,
      opacity: 0.12 + rand() * 0.4,
    });
  }
  return particles;
}

export function Atmosphere() {
  const particles = useMemo(() => makeParticles(46, 0x50616e6f), []);

  return (
    <div className="atmosphere" aria-hidden="true">
      <div className="abyss" />
      <div className="aurora aurora-teal" />
      <div className="aurora aurora-indigo" />
      <div className="aurora aurora-cyan" />
      <div className="particles">
        {particles.map((particle, index) => (
          <span
            key={index}
            className="particle"
            style={{
              left: `${particle.left}%`,
              top: `${particle.top}%`,
              width: `${particle.size}px`,
              height: `${particle.size}px`,
              opacity: particle.opacity,
              "--p-delay": `${particle.delay}s`,
              "--p-dur": `${particle.duration}s`,
              "--p-drift": `${particle.drift}px`,
            } as ParticleStyle}
          />
        ))}
      </div>
      <div className="grain" />
      <div className="vignette" />
    </div>
  );
}

// CSS custom properties are not in React's CSSProperties type; widen narrowly.
type ParticleStyle = React.CSSProperties & {
  "--p-delay": string;
  "--p-dur": string;
  "--p-drift": string;
};
