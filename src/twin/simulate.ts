import { BASELINE, describeIntervention, paypalActionFor, type Intervention, type Strategy } from "./interventions";
import { hashSeed, Rng } from "./rng";
import {
  METRIC_KEYS,
  REASONS,
  SEGMENTS,
  type Band,
  type MerchantTwin,
  type MetricKey,
  type ReasonId,
  type RunMetrics,
  type SampledParams,
  type SegmentId,
  type Summary,
  type TwinParams,
} from "./types";

// Monthly cohort simulation with Monte Carlo over parameter uncertainty and process noise.
//
// Every strategy in a comparison is evaluated against the same parameter draw and the same
// keyed random streams within a run (common random numbers; keys include segment and leaving
// reason), so differences between strategies reflect
// the intervention rather than sampling noise.

export interface SimulationOptions {
  runs: number;
  horizonMonths: number;
  seed: number;
}

export const DEFAULT_OPTIONS: SimulationOptions = { runs: 1000, horizonMonths: 12, seed: 20261113 };

interface Cohort {
  segment: SegmentId;
  reason: ReasonId;
  count: number;
  /** Amount charged per billing event (monthly price, or the full annual prepayment). */
  price: number;
  plan: "monthly" | "annual";
  /** Remaining months of an offer or annual term; 0 means open-ended. */
  monthsLeft: number;
  offer: boolean;
  /** List-price equivalent of one billing event, for measuring discount cost. */
  fullPrice: number;
  rebound: boolean;
  /** True once the cohort has ever received the save discount; never reset (one save offer per subscriber). */
  offered: boolean;
  billDue: boolean;
}

export interface StrategyResult {
  strategy: Strategy;
  description: string;
  paypalAction: string | null;
  metrics: Record<MetricKey, Summary>;
  /** Paired difference versus the baseline in the same run. */
  vsBaseline: Record<MetricKey, Summary & { probPositive: number }>;
  /** Probability that 12-month gross profit is lower than the baseline. */
  probProfitBelowBaseline: number;
  /** Probability that total value (profit + ending base value) is lower than the baseline. */
  probValueBelowBaseline: number;
  activeBand: Band;
  cumulativeProfitBand: Band;
}

export interface ComparisonResult {
  merchantId: string;
  options: SimulationOptions;
  baselineId: string;
  strategies: StrategyResult[];
}

export function sampleParams(p: TwinParams, rng: Rng): SampledParams {
  const bySegment = <T>(f: (s: SegmentId) => T) =>
    Object.fromEntries(SEGMENTS.map((s) => [s, f(s)])) as Record<SegmentId, T>;
  const beta = (d: { alpha: number; beta: number }) => rng.beta(d.alpha, d.beta);
  return {
    churn: bySegment((s) => beta(p.segments[s].monthlyChurn)),
    elasticity: bySegment((s) => rng.normal(p.segments[s].churnPriceElasticity.mean, p.segments[s].churnPriceElasticity.sd)),
    annualUptake: bySegment((s) => beta(p.segments[s].annualUptake)),
    involuntaryChurn: beta(p.involuntaryChurn),
    acquisition: Math.max(0, rng.normal(p.monthlyAcquisition.mean, p.monthlyAcquisition.sd)),
    acquisitionElasticity: rng.normal(p.acquisitionPriceElasticity.mean, p.acquisitionPriceElasticity.sd),
    newGraduation: beta(p.transitions.newGraduation),
    newToPriceSensitive: beta(p.transitions.newToPriceSensitive),
    coreToAtRisk: beta(p.transitions.coreToAtRisk),
    priceSensitiveToAtRisk: beta(p.transitions.priceSensitiveToAtRisk),
    atRiskRecovery: beta(p.transitions.atRiskRecovery),
    atRiskToCancelIntent: beta(p.transitions.atRiskToCancelIntent),
    cancelIntentToAtRisk: beta(p.transitions.cancelIntentToAtRisk),
    offerRelativeRisk: Object.fromEntries(
      REASONS.map((r) => [r, rng.gamma(p.offerChurnRelativeRisk[r].shape) / p.offerChurnRelativeRisk[r].rate]),
    ) as Record<ReasonId, number>,
    priceReasonShare: bySegment((s) => beta(p.segments[s].priceReasonShare)),
    postOfferMultiplier: Math.max(0.5, rng.normal(p.postOfferChurnMultiplier.mean, p.postOfferChurnMultiplier.sd)),
  };
}

const round2 = (x: number) => Math.round(x * 100) / 100;

function cohortKey(c: Cohort): string {
  return [c.segment, c.reason, c.plan, c.offer ? 1 : 0, c.rebound ? 1 : 0, c.offered ? 1 : 0, c.monthsLeft, c.price, c.billDue ? 1 : 0].join(":");
}

function merge(cohorts: Cohort[]): Cohort[] {
  const byKey = new Map<string, Cohort>();
  for (const c of cohorts) {
    if (c.count <= 0) continue;
    const k = cohortKey(c);
    const existing = byKey.get(k);
    if (existing) existing.count += c.count;
    else byKey.set(k, { ...c });
  }
  return [...byKey.values()];
}

function monthlyCohort(segment: SegmentId, reason: ReasonId, count: number, price: number): Cohort {
  return { segment, reason, count, price, plan: "monthly", monthsLeft: 0, offer: false, fullPrice: price, rebound: false, offered: false, billDue: false };
}

/** Split a count into price-driven and other subscribers. */
function splitByReason(segment: SegmentId, count: number, price: number, priceShare: number, rng: Rng): Cohort[] {
  const priceDriven = rng.binomial(count, priceShare);
  return [monthlyCohort(segment, "price", priceDriven, price), monthlyCohort(segment, "other", count - priceDriven, price)];
}

/** Simulate one strategy for one parameter draw. `streamSeed` keys every random draw. */
export function runOnce(
  twin: MerchantTwin,
  s: SampledParams,
  intervention: Intervention,
  horizonMonths: number,
  streamSeed: number,
): RunMetrics {
  const p = twin.params;
  // Streams are keyed by what they model (month, event, segment, leaving reason), not by call order, so the
  // same subscribers draw the same randomness under every strategy. Repeated keys get a suffix.
  const usedKeys = new Map<string, number>();
  const draw = (key: string) => {
    const n = usedKeys.get(key) ?? 0;
    usedKeys.set(key, n + 1);
    return new Rng(hashSeed(streamSeed, key, n));
  };
  let listPrice = p.listPrice;
  let pendingListPrice: number | null = null;

  let cohorts: Cohort[] = merge(
    SEGMENTS.flatMap((seg) => splitByReason(seg, twin.initialActive[seg], listPrice, s.priceReasonShare[seg], draw(`init:reason:${seg}`))),
  );

  const m: RunMetrics = {
    revenue: 0,
    paymentFees: 0,
    fulfilmentCost: 0,
    grossProfit: 0,
    discountCost: 0,
    endingActive: 0,
    discountedSubscribers: 0,
    voluntaryChurn: 0,
    involuntaryChurn: 0,
    newSubscribers: 0,
    endingBaseValue: 0,
    totalValue: 0,
    activeByMonth: [],
    cumulativeProfitByMonth: [],
  };

  // Save-offer helpers: a targeted discount is a policy that applies to the current stock and, during
  // the campaign window, to everyone who enters the target segment. Each subscriber is offered once.
  const iv = intervention.kind === "targeted_discount" ? intervention : null;
  const qualifies = (c: Cohort) =>
    iv !== null && c.count > 0 && c.plan === "monthly" && !c.offered &&
    c.segment === iv.segment && (iv.reason === "any" || c.reason === iv.reason);
  const applyDiscount = (c: Cohort): Cohort => {
    m.discountedSubscribers += c.count;
    return { ...c, price: round2(listPrice * (1 - iv!.discountPct / 100)), fullPrice: listPrice, offer: true, offered: true, monthsLeft: iv!.months };
  };
  /** Campaign entrants first billed in `month` get the offer while the campaign runs. */
  const offerToEntrants = (entrants: Cohort[], month: number) =>
    iv !== null && month < iv.campaignMonths ? entrants.map((c) => (qualifies(c) ? applyDiscount(c) : c)) : entrants;

  // Interventions take effect at the start of month 0.
  if (iv !== null) {
    // The discount is applied merchant-side to every targeted subscriber (no opt-in step),
    // so its cost includes subscribers who would have stayed anyway.
    cohorts = merge(cohorts.map((c) => (qualifies(c) ? applyDiscount(c) : c)));
  } else if (intervention.kind === "list_price_change") {
    // New subscribers see the new price immediately; existing ones from the next cycle,
    // mirroring PayPal's rule that billing within 10 days of a price change is unaffected.
    listPrice = intervention.newPrice;
    pendingListPrice = intervention.newPrice;
  } else if (intervention.kind === "annual_plan") {
    const next: Cohort[] = [];
    for (const c of cohorts) {
      if (intervention.segments.includes(c.segment) && c.plan === "monthly" && !c.offer) {
        const converted = draw(`iv:annual:${c.segment}:${c.reason}`).binomial(c.count, s.annualUptake[c.segment]);
        next.push({ ...c, count: c.count - converted });
        next.push({
          ...c,
          count: converted,
          plan: "annual",
          price: round2(listPrice * 12 * (1 - intervention.discountPct / 100)),
          fullPrice: listPrice * 12,
          monthsLeft: 12,
          billDue: true,
        });
      } else next.push(c);
    }
    cohorts = merge(next);
  }

  for (let t = 0; t < horizonMonths; t++) {
    if (t === 1 && pendingListPrice !== null) {
      for (const c of cohorts) {
        if (c.plan === "monthly" && !c.offer) {
          c.price = pendingListPrice;
          c.fullPrice = pendingListPrice;
        }
      }
      cohorts = merge(cohorts);
    }

    // Acquisition, with demand responding to list price relative to the reference price.
    const lambda = s.acquisition * Math.pow(listPrice / p.referencePrice, -s.acquisitionElasticity);
    const acquired = draw(`m${t}:acq`).poisson(lambda);
    m.newSubscribers += acquired;
    const entrants = splitByReason("new", acquired, listPrice, s.priceReasonShare.new, draw(`m${t}:acq:reason`));
    cohorts = merge([...cohorts, ...offerToEntrants(entrants, t)]);

    // Billing and fulfilment for everyone active at the start of the month.
    for (const c of cohorts) {
      const billed = c.plan === "monthly" || c.billDue;
      if (billed) {
        m.revenue += c.count * c.price;
        m.paymentFees += c.count * (c.price * p.paymentFeeRate + p.paymentFeeFixed);
        m.discountCost += c.count * (c.fullPrice - c.price);
        c.billDue = false;
      }
      m.fulfilmentCost += c.count * (p.unitCost + p.shippingCost);
    }

    // Churn at the end of the month. Annual prepay subscribers cannot churn mid-term.
    for (const c of cohorts) {
      if (c.plan === "annual") continue;
      const key = `m${t}:churn:${c.segment}:${c.reason}:${c.offer ? `o${c.monthsLeft}` : c.rebound ? "r" : c.offered ? "p" : "b"}`;
      let hazard = s.churn[c.segment];
      if (c.offer) hazard *= s.offerRelativeRisk[c.reason];
      else hazard *= Math.pow(c.price / p.referencePrice, s.elasticity[c.segment]);
      if (c.rebound) hazard *= s.postOfferMultiplier;
      hazard = Math.min(0.95, Math.max(0, hazard));
      const rng = draw(key);
      const voluntary = rng.binomial(c.count, hazard);
      const involuntary = rng.binomial(c.count - voluntary, s.involuntaryChurn);
      c.count -= voluntary + involuntary;
      m.voluntaryChurn += voluntary;
      m.involuntaryChurn += involuntary;
    }

    // Offer and annual terms count down; expiring cohorts return to list price.
    for (const c of cohorts) {
      c.rebound = false;
      if (c.monthsLeft > 0 && --c.monthsLeft === 0) {
        if (c.offer) {
          c.offer = false;
          c.rebound = true;
        }
        if (c.plan === "annual") {
          c.plan = "monthly";
          c.segment = "core";
        }
        c.price = listPrice;
        c.fullPrice = listPrice;
      }
    }

    // Segment transitions for monthly subscribers. Discounted subscribers move too (keeping their
    // discount), so a discount never blocks the recovery that would have happened anyway.
    const moved: Cohort[] = [];
    for (const c of cohorts) {
      if (c.plan !== "monthly" || c.count === 0) continue;
      const rng = draw(`m${t}:move:${c.segment}:${c.reason}:${c.offer ? `o${c.monthsLeft}` : c.rebound ? "r" : c.offered ? "p" : "b"}`);
      if (c.segment === "new") {
        const graduated = rng.binomial(c.count, s.newGraduation);
        const toPriceSensitive = rng.binomial(graduated, s.newToPriceSensitive);
        c.count -= graduated;
        moved.push({ ...c, segment: "price_sensitive", count: toPriceSensitive });
        moved.push({ ...c, segment: "core", count: graduated - toPriceSensitive });
      } else if (c.segment === "core") {
        const drift = rng.binomial(c.count, s.coreToAtRisk);
        c.count -= drift;
        moved.push({ ...c, segment: "at_risk", count: drift });
      } else if (c.segment === "price_sensitive") {
        const drift = rng.binomial(c.count, s.priceSensitiveToAtRisk);
        c.count -= drift;
        moved.push({ ...c, segment: "at_risk", count: drift });
      } else if (c.segment === "at_risk") {
        // Same order as the history generator: recovery first, then escalation from the rest.
        const recovered = rng.binomial(c.count, s.atRiskRecovery);
        const escalated = rng.binomial(c.count - recovered, s.atRiskToCancelIntent);
        c.count -= recovered + escalated;
        moved.push({ ...c, segment: "core", count: recovered });
        // Leaving reasons are assessed when someone tries to cancel, so entrants take the cancel-intent mix.
        const priceDriven = rng.binomial(escalated, s.priceReasonShare.cancel_intent);
        moved.push({ ...c, segment: "cancel_intent", reason: "price", count: priceDriven });
        moved.push({ ...c, segment: "cancel_intent", reason: "other", count: escalated - priceDriven });
      } else if (c.segment === "cancel_intent") {
        const deescalated = rng.binomial(c.count, s.cancelIntentToAtRisk);
        c.count -= deescalated;
        moved.push({ ...c, segment: "at_risk", count: deescalated });
      } else {
        const unreachable: never = c.segment;
        throw new Error(`Unhandled segment: ${unreachable}`);
      }
    }
    // Their first discounted bill is next month.
    cohorts = merge([...cohorts, ...offerToEntrants(moved, t + 1)]);

    const active = cohorts.reduce((sum, c) => sum + c.count, 0);
    m.activeByMonth.push(active);
    m.cumulativeProfitByMonth.push(m.revenue - m.paymentFees - m.fulfilmentCost);
  }

  m.grossProfit = m.revenue - m.paymentFees - m.fulfilmentCost;
  m.endingActive = m.activeByMonth[m.activeByMonth.length - 1] ?? 0;
  const tail = tailValuer(p, s, listPrice);
  m.endingBaseValue = cohorts.reduce((sum, c) => sum + c.count * tail(c), 0);
  m.totalValue = m.grossProfit + m.endingBaseValue;
  return m;
}

export const TAIL_MONTHS = 24;
export const MONTHLY_DISCOUNT_RATE = 0.01;

/** One month of segment moves as destination probabilities, in the same order as runOnce. */
function moveShares(segment: SegmentId, s: SampledParams): Partial<Record<SegmentId, number>> {
  switch (segment) {
    case "new":
      return { core: s.newGraduation * (1 - s.newToPriceSensitive), price_sensitive: s.newGraduation * s.newToPriceSensitive };
    case "core":
      return { at_risk: s.coreToAtRisk };
    case "price_sensitive":
      return { at_risk: s.priceSensitiveToAtRisk };
    case "at_risk":
      return { core: s.atRiskRecovery, cancel_intent: (1 - s.atRiskRecovery) * s.atRiskToCancelIntent };
    case "cancel_intent":
      return { at_risk: s.cancelIntentToAtRisk };
    default: {
      const unreachable: never = segment;
      throw new Error(`Unhandled segment: ${unreachable}`);
    }
  }
}

export type TailCohort = Pick<Cohort, "segment" | "reason" | "plan" | "monthsLeft" | "offer" | "price" | "rebound">;

/** Tail month in which the post-offer churn spike applies, or 0 for none. */
function reboundMonth(c: TailCohort): number {
  if (c.plan !== "monthly") return 0;
  if (c.rebound) return 1;
  return c.offer && c.monthsLeft > 0 ? c.monthsLeft + 1 : 0;
}

/**
 * Reference implementation: expected discounted margin of one subscriber over the TAIL_MONTHS after
 * the horizon. Propagates expected subscriber mass across segments with the same churn and moves
 * as runOnce, so a saved cancel-intent subscriber is credited with the recoveries they may make.
 * Prepaid annual months owe fulfilment but bring no revenue, churn, or moves; annual subscribers
 * become core afterwards. The post-offer churn spike applies in the month after an offer ends.
 *
 * Known differences from runOnce: the annual expiry month skips that month's moves, and offer
 * relative risk uses the cohort's fixed reason (runOnce re-splits reasons for subscribers entering
 * cancel_intent). The simulation uses the faster tailValuer, which gives the same values.
 */
export function tailValue(p: TwinParams, s: SampledParams, c: TailCohort, listPrice: number): number {
  const fulfilment = p.unitCost + p.shippingCost;
  const margin = (price: number) => price * (1 - p.paymentFeeRate) - p.paymentFeeFixed - fulfilment;
  const emptyMass = () => Object.fromEntries(SEGMENTS.map((seg) => [seg, 0])) as Record<SegmentId, number>;
  const spike = reboundMonth(c);
  let mass = emptyMass();
  mass[c.plan === "annual" ? "core" : c.segment] = 1;
  let value = 0;
  for (let k = 1; k <= TAIL_MONTHS; k++) {
    const discount = Math.pow(1 + MONTHLY_DISCOUNT_RATE, -k);
    const total = SEGMENTS.reduce((sum, seg) => sum + mass[seg], 0);
    if (c.plan === "annual" && k <= c.monthsLeft) {
      value -= discount * total * fulfilment;
      continue;
    }
    const onOffer = c.offer && k <= c.monthsLeft;
    value += discount * total * margin(onOffer ? c.price : listPrice);
    const next = emptyMass();
    for (const seg of SEGMENTS) {
      if (mass[seg] === 0) continue;
      const effect = onOffer ? s.offerRelativeRisk[c.reason] : Math.pow(listPrice / p.referencePrice, s.elasticity[seg]);
      const hazard = Math.min(0.95, s.churn[seg] * effect * (k === spike ? s.postOfferMultiplier : 1));
      const surviving = mass[seg] * (1 - hazard) * (1 - s.involuntaryChurn);
      let staying = surviving;
      for (const [to, share] of Object.entries(moveShares(seg, s)) as [SegmentId, number][]) {
        next[to] += surviving * share;
        staying -= surviving * share;
      }
      next[seg] += staying;
    }
    mass = next;
  }
  return value;
}

/** One tail month's transition matrix, row-major [from * n + to], for survivors only. */
function stepMatrix(p: TwinParams, s: SampledParams, listPrice: number, offerRisk: number | null, spike: number): Float64Array {
  const n = SEGMENTS.length;
  const matrix = new Float64Array(n * n);
  SEGMENTS.forEach((seg, i) => {
    const effect = offerRisk ?? Math.pow(listPrice / p.referencePrice, s.elasticity[seg]);
    const survive = (1 - Math.min(0.95, s.churn[seg] * effect * spike)) * (1 - s.involuntaryChurn);
    let staying = 1;
    for (const [to, share] of Object.entries(moveShares(seg, s)) as [SegmentId, number][]) {
      matrix[i * n + SEGMENTS.indexOf(to)] += survive * share;
      staying -= share;
    }
    matrix[i * n + i] += survive * staying;
  });
  return matrix;
}

/**
 * Per-run tail valuer giving the same values as tailValue. It builds the one-month transition
 * matrices once and backward-recurses V[n][segment], the value of a list-price monthly subscriber
 * with n months left, so each cohort costs a few vector operations instead of a 24-month walk.
 */
export function tailValuer(p: TwinParams, s: SampledParams, listPrice: number): (c: TailCohort) => number {
  const n = SEGMENTS.length;
  const d = 1 / (1 + MONTHLY_DISCOUNT_RATE);
  const fulfilment = p.unitCost + p.shippingCost;
  const margin = (price: number) => price * (1 - p.paymentFeeRate) - p.paymentFeeFixed - fulfilment;
  const listMargin = margin(listPrice);
  const step = stepMatrix(p, s, listPrice, null, 1);
  const reboundStep = stepMatrix(p, s, listPrice, null, s.postOfferMultiplier);
  const offerSteps: Partial<Record<ReasonId, Float64Array>> = {};

  const times = (mass: ArrayLike<number>, matrix: Float64Array) => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) if (mass[i]) for (let j = 0; j < n; j++) out[j] += mass[i] * matrix[i * n + j];
    return out;
  };
  const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += a[i] * b[i];
    return sum;
  };
  const total = (a: ArrayLike<number>) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += a[i];
    return sum;
  };

  const values: Float64Array[] = [new Float64Array(n)];
  for (let k = 1; k <= TAIL_MONTHS; k++) {
    const cur = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let ahead = 0;
      for (let j = 0; j < n; j++) ahead += step[i * n + j] * values[k - 1][j];
      cur[i] = d * (listMargin + ahead);
    }
    values.push(cur);
  }

  /** Value of `mass` entering a rebound month at list price with `months` tail months left, scaled to now. */
  const reboundValue = (mass: Float64Array, months: number) =>
    d * (total(mass) * listMargin + dot(times(mass, reboundStep), values[months - 1]));
  const unit = (segment: SegmentId) => {
    const mass = new Float64Array(n);
    mass[SEGMENTS.indexOf(segment)] = 1;
    return mass;
  };

  return (c) => {
    if (c.plan === "annual") {
      const owed = Math.min(c.monthsLeft, TAIL_MONTHS);
      let value = 0;
      let factor = 1;
      for (let k = 1; k <= owed; k++) {
        factor *= d;
        value -= factor * fulfilment;
      }
      return value + factor * values[TAIL_MONTHS - owed][SEGMENTS.indexOf("core")];
    }
    if (!c.offer || c.monthsLeft === 0) {
      return c.rebound ? reboundValue(unit(c.segment), TAIL_MONTHS) : values[TAIL_MONTHS][SEGMENTS.indexOf(c.segment)];
    }
    const offerStep = (offerSteps[c.reason] ??= stepMatrix(p, s, listPrice, s.offerRelativeRisk[c.reason], 1));
    const offerMargin = margin(c.price);
    const months = Math.min(c.monthsLeft, TAIL_MONTHS);
    let mass = unit(c.segment);
    let value = 0;
    let factor = 1;
    for (let k = 1; k <= months; k++) {
      factor *= d;
      value += factor * total(mass) * offerMargin;
      mass = times(mass, offerStep);
    }
    return value + factor * (months < TAIL_MONTHS ? reboundValue(mass, TAIL_MONTHS - months) : 0);
  };
}

export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function summarize(values: number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  return { mean, p10: percentile(sorted, 0.1), p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9) };
}

function band(series: number[][], horizon: number): Band {
  const out: Band = { p10: [], p50: [], p90: [] };
  for (let t = 0; t < horizon; t++) {
    const s = series.map((r) => r[t]).sort((a, b) => a - b);
    out.p10.push(percentile(s, 0.1));
    out.p50.push(percentile(s, 0.5));
    out.p90.push(percentile(s, 0.9));
  }
  return out;
}

/** Compare strategies under common random numbers. A baseline is added if none is supplied. */
export function compareStrategies(
  twin: MerchantTwin,
  strategies: Strategy[],
  options: Partial<SimulationOptions> = {},
): ComparisonResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const baseline = strategies.find((s) => s.intervention.kind === "baseline") ?? BASELINE;
  const all = strategies.includes(baseline) ? strategies : [baseline, ...strategies];

  const runs: RunMetrics[][] = all.map(() => []);
  for (let r = 0; r < opts.runs; r++) {
    const sampled = sampleParams(twin.params, new Rng(hashSeed(opts.seed, "params", r)));
    const streamSeed = hashSeed(opts.seed, "run", r);
    all.forEach((strategy, i) => {
      runs[i].push(runOnce(twin, sampled, strategy.intervention, opts.horizonMonths, streamSeed));
    });
  }

  const baselineRuns = runs[all.indexOf(baseline)];
  const results = all.map((strategy, i): StrategyResult => {
    const own = runs[i];
    const metrics = {} as StrategyResult["metrics"];
    const vsBaseline = {} as StrategyResult["vsBaseline"];
    for (const key of METRIC_KEYS) {
      metrics[key] = summarize(own.map((r) => r[key]));
      const deltas = own.map((r, j) => r[key] - baselineRuns[j][key]);
      vsBaseline[key] = { ...summarize(deltas), probPositive: deltas.filter((d) => d > 0).length / deltas.length };
    }
    const below = (key: MetricKey) => own.filter((r, j) => r[key] < baselineRuns[j][key]).length / own.length;
    return {
      strategy,
      description: describeIntervention(strategy.intervention, twin.params.listPrice),
      paypalAction: paypalActionFor(strategy.intervention),
      metrics,
      vsBaseline,
      probProfitBelowBaseline: below("grossProfit"),
      probValueBelowBaseline: below("totalValue"),
      activeBand: band(own.map((r) => r.activeByMonth), opts.horizonMonths),
      cumulativeProfitBand: band(own.map((r) => r.cumulativeProfitByMonth), opts.horizonMonths),
    };
  });

  return { merchantId: twin.merchant.id, options: opts, baselineId: baseline.id, strategies: results };
}
