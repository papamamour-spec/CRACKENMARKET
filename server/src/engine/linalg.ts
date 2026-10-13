/** Algèbre linéaire minimale (petites matrices) pour les modules de prévision et d'optimisation. */

export type Matrix = number[][];

export function zeros(r: number, c: number): Matrix {
  return Array.from({ length: r }, () => new Array<number>(c).fill(0));
}

export function transpose(a: Matrix): Matrix {
  return a[0].map((_, j) => a.map((row) => row[j]));
}

export function matMul(a: Matrix, b: Matrix): Matrix {
  const out = zeros(a.length, b[0].length);
  for (let i = 0; i < a.length; i++) for (let k = 0; k < b.length; k++) {
    const aik = a[i][k];
    if (aik === 0) continue;
    for (let j = 0; j < b[0].length; j++) out[i][j] += aik * b[k][j];
  }
  return out;
}

export function matVec(a: Matrix, v: number[]): number[] {
  return a.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
}

export function dot(a: number[], b: number[]): number {
  return a.reduce((s, x, i) => s + x * b[i], 0);
}

/** Résout A x = b par élimination de Gauss avec pivot partiel. */
export function solve(a: Matrix, b: number[]): number[] {
  const n = a.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    [m[col], m[piv]] = [m[piv], m[col]];
    const p = m[col][col];
    if (Math.abs(p) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / p;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}

/** Régression ridge : β = (XᵀX + λI)⁻¹ Xᵀy, avec terme constant ajouté (non pénalisé). */
export function ridge(X: Matrix, y: number[], lambda: number): number[] {
  const Xa = X.map((row) => [1, ...row]);
  const Xt = transpose(Xa);
  const XtX = matMul(Xt, Xa);
  for (let i = 1; i < XtX.length; i++) XtX[i][i] += lambda;
  const Xty = matVec(Xt, y);
  return solve(XtX, Xty);
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Générateur déterministe (mulberry32) pour des simulations reproductibles. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
