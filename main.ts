// gta6-trophy-rarity-forecast-01: a trophy earn-rate forecaster (Node 22, stdlib only).
//
// Idea: a trophy's Exophase earn rate is a ratio, rate = earners / players-tracked,
// and the two sides move for different reasons. Players-tracked jumps when Exophase
// refreshes its counts (hours apart, irregularly); earners grow as players progress
// through the game. So instead of extrapolating the rate itself, this program
// forecasts the two counts separately on a log-time scale and divides:
//
//   * snapshots: consecutive reads with identical (players, rates) are one Exophase
//     snapshot; only snapshots carry information, the flat reads between them do not.
//   * players-tracked N(t): least-squares line of ln N against ln(1 + hours since
//     release), read at the target, with the extrapolated step damped (growth
//     decelerates as the launch rush passes) and capped.
//   * earners E_i(t) per trophy: least-squares line of ln(E_i + 0.5) against the
//     same log-time, shrunk toward the pooled slope across trophies (and the
//     trophy's tier median) because single-trophy counts are small and noisy, then
//     read at the target with the same damping. Slopes are floored at 0: earners
//     never un-earn a trophy.
//   * median rate = 100 * E_i(target) / N(target).
//
// When the whole history is a single flat snapshot (the practice cases: every read
// identical since launch night), no trend can be fitted. The program then falls back
// to a launch-day refresh prior, calibrated on the practice refresh itself: the
// first refresh after launch multiplied players-tracked ~6x (638 -> 3,868) while
// earner counts barely moved for most trophies, so rates fell to roughly a fifth.
// The prior assumes the next refresh multiplies N by M = 1 + 5.5 * (1 - exp(-age/3)),
// where age is the snapshot's age at the target in hours (about 5.3-5.5x for the
// practice cases), and lets earner counts grow a little more for trophies that
// already had many earners, G(c) = 1 + 0.02 * max(0, c - 3.5)^2, because early,
// easy trophies pick up new earners fastest. A trophy at 100% in every snapshot
// stays at 100%: everyone tracked has it, within minutes of starting.
//
// Spread: quantiles are normal on the logit scale around the median, with
// sigma_i = sqrt(0.30^2 + (0.38 * sqrt(horizon_days))^2 + se_i^2), where se_i is
// the trend fit's prediction standard error (0 in the flat regime). The floor
// keeps the band honest when the history says nothing at all: the practice
// baseline's 0.125-logit band covered none of the refreshed rates.
//
// Reads every <id>.in in the input directory (MAKEFUN_INPUT_DIR or /input) and
// writes <id>.out to the output directory (MAKEFUN_OUTPUT_DIR or /output).
// Deterministic: pure functions of the case file, no clock, no randomness, no I/O
// besides the case files, no network.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Scored quantile levels, in row order. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Standard normal quantiles at those levels. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

/** Damping applied to any extrapolated log-time step (growth decelerates). */
const DAMP = 0.85;
/** Floor / cap on the logit spread of a trophy's forecast. */
const SIGMA_FLOOR = 0.3;
const SIGMA_CAP = 1.2;
/** Random-walk part of the spread, logit units per square-root day. */
const SIGMA_RW = 0.38;

interface Trophy {
  id: number;
  tier: string;
}

interface Read {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}

interface Case {
  levels: number[];
  horizon_minutes: number;
  target: string;
  game: { release_date?: string };
  trophies: Trophy[];
  history: Read[];
}

interface Snapshot {
  /** Hours since release when this snapshot was first seen. */
  x: number;
  atMs: number;
  players: number;
  rates: Array<number | null>;
}

const clampRate = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampRate(pct);
  return Math.log(p / (100 - p));
};
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10000) / 10000;
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

interface Fit {
  slope: number;
  intercept: number;
  residSd: number;
  n: number;
  xbar: number;
  sxx: number;
}

/** Ordinary least squares of y on x; returns slope/intercept/residual spread. */
function ols(xs: number[], ys: number[]): Fit {
  const n = xs.length;
  const xbar = xs.reduce((a, b) => a + b, 0) / n;
  const ybar = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - xbar) ** 2;
    sxy += (xs[i] - xbar) * (ys[i] - ybar);
  }
  const slope = sxx > 1e-12 ? sxy / sxx : 0;
  const intercept = ybar - slope * xbar;
  let rss = 0;
  for (let i = 0; i < n; i++) rss += (ys[i] - (intercept + slope * xs[i])) ** 2;
  const residSd = n > 2 ? Math.sqrt(rss / (n - 2)) : 0;
  return { slope, intercept, residSd, n, xbar, sxx };
}

/** Hours from the release anchor (release_date at 00:00 UTC) to an ISO time. */
function hoursSinceRelease(anchorMs: number, iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 0;
  return Math.max(0, (ms - anchorMs) / 3600000);
}

/** Collapse the read history into distinct snapshots, first-seen time each. */
function snapshotsOf(c: Case, anchorMs: number): Snapshot[] {
  const out: Snapshot[] = [];
  let prevKey = '';
  for (const r of c.history) {
    const key = `${r.players_tracked}|${JSON.stringify(r.rates)}`;
    if (key === prevKey) continue;
    prevKey = key;
    out.push({
      x: Math.log1p(hoursSinceRelease(anchorMs, r.at)),
      atMs: Date.parse(r.at),
      players: r.players_tracked,
      rates: r.rates,
    });
  }
  return out;
}

/** Last non-null rate for trophy i over the snapshots, walking back in time. */
function lastRate(snaps: Snapshot[], i: number): number | null {
  for (let s = snaps.length - 1; s >= 0; s--) {
    const r = snaps[s].rates[i];
    if (r !== null && r !== undefined) return r;
  }
  return null;
}

function forecastCase(c: Case): Array<{ id: number; q: number[] }> {
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`levels ${JSON.stringify(c.levels)} are not ${JSON.stringify(LEVELS)}`);
  }
  if (c.history.length === 0) throw new Error('case has no history');

  // Release anchor: release_date at 00:00 UTC, else the first read's day.
  let anchorMs = Date.parse(`${c.game?.release_date ?? ''}T00:00:00Z`);
  if (Number.isNaN(anchorMs)) anchorMs = Date.parse(c.history[0].at);
  const targetMs = Date.parse(c.target);
  const xTarget = Math.log1p(Math.max(0, (targetMs - anchorMs) / 3600000));
  const horizonDays = c.horizon_minutes / 1440;

  const snaps = snapshotsOf(c, anchorMs);
  const last = snaps[snaps.length - 1];
  const flat = snaps.length === 1;

  // ---- Players-tracked at the target -------------------------------------
  let nTarget: number;
  if (flat) {
    // No refresh observed: launch-day prior. The snapshot's age at the target
    // measures how much tracked-base growth is hidden behind the stale page.
    const ageHours = Math.max(0, (targetMs - snaps[0].atMs) / 3600000);
    const mult = Math.min(6, 1 + 5.5 * (1 - Math.exp(-ageHours / 3)));
    nTarget = last.players * mult;
  } else {
    const fitN = ols(
      snaps.map((s) => s.x),
      snaps.map((s) => Math.log(Math.max(1, s.players))),
    );
    const slopeN = Math.min(1.5, Math.max(0, fitN.slope));
    const step = Math.exp(slopeN * (xTarget - last.x));
    nTarget = last.players * Math.pow(step, DAMP);
    // Guard against runaway extrapolation, but allow the tracked base to grow
    // several-fold over the 4.5-day horizon: launch week is still the steep
    // part of the curve (the practice refresh alone was a 6x jump).
    nTarget = Math.min(nTarget, last.players * 4);
    nTarget = Math.max(nTarget, last.players);
  }

  // ---- Per-trophy earner trends ------------------------------------------
  const nT = c.trophies.length;
  const slopes: number[] = new Array(nT).fill(0);
  const residSds: number[] = [];
  const fits: Array<Fit | null> = [];
  for (let i = 0; i < nT; i++) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const s of snaps) {
      const r = s.rates[i];
      if (r === null || r === undefined) continue;
      xs.push(s.x);
      ys.push(Math.log((r * s.players) / 100 + 0.5));
    }
    if (xs.length >= 2 && !flat) {
      const f = ols(xs, ys);
      fits.push(f);
      if (f.n >= 3) residSds.push(f.residSd);
      slopes[i] = f.slope;
    } else {
      fits.push(null);
    }
  }
  const poolSlope = median(slopes.filter((_, i) => fits[i] !== null && fits[i]!.n >= 3));
  const tierSlope = new Map<string, number>();
  for (const tier of new Set(c.trophies.map((t) => t.tier))) {
    const vals = slopes.filter((_, i) => c.trophies[i].tier === tier && fits[i] !== null && fits[i]!.n >= 3);
    if (vals.length > 0) tierSlope.set(tier, median(vals));
  }
  const residPool = residSds.length > 0 ? Math.min(0.6, Math.max(0.08, median(residSds))) : 0.12;

  // ---- Assemble one row per trophy ---------------------------------------
  const rows: Array<{ id: number; q: number[] }> = [];
  for (let i = 0; i < nT; i++) {
    const t = c.trophies[i];
    const rLast = lastRate(snaps, i);
    const eLast = rLast === null ? 0 : (rLast * last.players) / 100;

    // A trophy every tracked player holds stays held: forecast it at 100%.
    if (rLast !== null && rLast >= 99.995) {
      rows.push({ id: t.id, q: [99.99, 99.99, 99.99, 99.99, 99.99] });
      continue;
    }

    let eTarget: number;
    let se = 0;
    if (flat) {
      // Launch-day prior: earners grow a little, fastest where they already
      // have a foothold (early, easy trophies accumulate new earners first).
      const growth = 1 + 0.02 * Math.max(0, eLast - 3.5) ** 2;
      eTarget = eLast * growth;
    } else {
      const f = fits[i];
      if (f === null) {
        eTarget = eLast;
        se = residPool * 1.5;
      } else {
        const w = f.n / (f.n + 4);
        const pool = tierSlope.has(t.tier)
          ? 0.6 * poolSlope + 0.4 * tierSlope.get(t.tier)!
          : poolSlope;
        let b = w * f.slope + (1 - w) * pool;
        b = Math.min(1.6, Math.max(0, b));
        const step = Math.exp(b * (xTarget - last.x));
        eTarget = (eLast + 0.5) * Math.pow(step, DAMP) - 0.5;
        const lev = f.sxx > 1e-12 ? (xTarget - f.xbar) ** 2 / f.sxx : 1;
        se = f.residSd * Math.sqrt(1 + 1 / f.n + lev);
        if (!Number.isFinite(se)) se = residPool;
      }
      eTarget = Math.max(eTarget, eLast);
    }
    eTarget = Math.max(0, eTarget);

    const med = clampRate((100 * eTarget) / nTarget);
    const sigma = Math.min(
      SIGMA_CAP,
      Math.max(SIGMA_FLOOR, Math.sqrt(SIGMA_FLOOR ** 2 + (SIGMA_RW * Math.sqrt(horizonDays)) ** 2 + se * se)),
    );
    const base = logit(med);
    const q = Z.map((z) => round4(clampRate(invLogit(base + z * sigma))));
    // Enforce non-decreasing after rounding.
    for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
    rows.push({ id: t.id, q });
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR)
  .filter((f) => f.endsWith('.in'))
  .sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
