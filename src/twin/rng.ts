// Seeded, dependency-free random number generation for reproducible Monte Carlo runs.

/** FNV-1a hash of the joined parts, used to derive independent, reproducible stream seeds. */
export function hashSeed(...parts: (number | string)[]): number {
  const s = parts.join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  private state: number;
  private spareNormal: number | null = null;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** mulberry32: fast, well-distributed 32-bit generator; uniform in [0, 1). */
  uniform(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  normal(mean = 0, sd = 1): number {
    if (this.spareNormal !== null) {
      const z = this.spareNormal;
      this.spareNormal = null;
      return mean + sd * z;
    }
    let u = 0;
    while (u === 0) u = this.uniform();
    const v = this.uniform();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spareNormal = r * Math.sin(2 * Math.PI * v);
    return mean + sd * r * Math.cos(2 * Math.PI * v);
  }

  /** Marsaglia–Tsang gamma sampler (shape > 0, scale 1). */
  gamma(shape: number): number {
    if (shape < 1) {
      return this.gamma(shape + 1) * Math.pow(this.uniform() || Number.MIN_VALUE, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        x = this.normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.uniform();
      if (u < 1 - 0.0331 * x ** 4) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  beta(alpha: number, beta: number): number {
    const x = this.gamma(alpha);
    const y = this.gamma(beta);
    return x / (x + y);
  }

  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda > 30) return Math.max(0, Math.round(this.normal(lambda, Math.sqrt(lambda))));
    const limit = Math.exp(-lambda);
    let k = 0;
    let p = this.uniform();
    while (p > limit) {
      k++;
      p *= this.uniform();
    }
    return k;
  }

  /**
   * Binomial(n, p). Exact geometric-skip method when the expected count is small,
   * normal approximation (rounded, clamped) when the variance is large enough for it to be accurate.
   */
  binomial(n: number, p: number): number {
    if (n <= 0 || p <= 0) return 0;
    if (p >= 1) return n;
    if (p > 0.5) return n - this.binomial(n, 1 - p);
    const variance = n * p * (1 - p);
    if (variance >= 9) {
      const draw = Math.round(this.normal(n * p, Math.sqrt(variance)));
      return Math.min(n, Math.max(0, draw));
    }
    const logQ = Math.log1p(-p);
    let successes = 0;
    let position = 0;
    for (;;) {
      const u = this.uniform() || Number.MIN_VALUE;
      position += Math.floor(Math.log(u) / logQ) + 1;
      if (position > n) return successes;
      successes++;
    }
  }
}
