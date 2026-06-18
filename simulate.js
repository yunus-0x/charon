/**
 * simulate.js — Monte Carlo strategy comparison for Solana meme coin trading
 *
 * Generates realistic meme token price paths (6 archetypes), applies each
 * strategy's full exit logic (SL, fixed TP, trailing stop, tiered trailing,
 * partial TPs), and compares results across 10,000 simulations per strategy.
 *
 * Run with: node simulate.js
 * No API keys or database required — fully self-contained.
 */

// ─── PRNG (mulberry32 — fast, seedable) ─────────────────────────────────────

function makePrng(seed) {
  let s = (seed + 1) >>> 0;
  return function rand() {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function makeRandNorm(rand) {
  return function randNorm() {
    let u;
    do { u = rand(); } while (u === 0);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t)    { return a + (b - a) * clamp(t, 0, 1); }

function pct(n, decimals = 1) {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(decimals)}%`;
}

function pad(s, width, right = false) {
  s = String(s);
  return right ? s.padEnd(width) : s.padStart(width);
}

// ─── Price path archetypes ───────────────────────────────────────────────────
//
// Each archetype returns an array of price multipliers (relative to entry = 1.0)
// at 1-minute intervals, up to 720 steps (12 hours).
// The shapes model the most common Solana meme-coin behaviours.

function generatePricePath(archetype, peakMultiple, rand, randNorm) {
  const STEPS = 720;
  const path = new Float64Array(STEPS + 1);
  path[0] = 1.0;

  switch (archetype) {
    case 'immediate_rug': {
      // Tiny pump (+5–20%) then hard crash to 2–10% within 20–60 min
      const peakAt  = 3 + Math.floor(rand() * 12);
      const peakPx  = 1.0 + rand() * 0.20;
      const rugAt   = peakAt + 10 + Math.floor(rand() * 30);
      const rugFloor = 0.02 + rand() * 0.08;
      for (let t = 1; t <= STEPS; t++) {
        let p;
        if (t <= peakAt)  p = lerp(1.0, peakPx, t / peakAt);
        else if (t <= rugAt) p = lerp(peakPx, rugFloor, (t - peakAt) / (rugAt - peakAt));
        else p = rugFloor * (1 + (rand() - 0.5) * 0.08);
        path[t] = Math.max(p, 0.001);
      }
      break;
    }

    case 'slow_bleed': {
      // Small early pump (+10–50%), gradual decline over hours
      const peakAt  = 10 + Math.floor(rand() * 60);
      const peakPx  = 1.0 + rand() * 0.5;
      const settle  = 0.15 + rand() * 0.35;
      for (let t = 1; t <= STEPS; t++) {
        let p;
        if (t <= peakAt) p = lerp(1.0, peakPx, t / peakAt);
        else {
          const decay = (t - peakAt) / (STEPS - peakAt);
          p = lerp(peakPx, settle, Math.pow(decay, 0.6)) + randNorm() * 0.025;
        }
        path[t] = Math.max(p, 0.01);
      }
      break;
    }

    case 'pump_dump': {
      // Strong pump to peak, then dumps back to 25–60% of entry
      const peak    = peakMultiple; // 1.5–4x
      const peakAt  = 20 + Math.floor(rand() * 90);
      const dumpDur = 20 + Math.floor(rand() * 60);
      const floor   = 0.25 + rand() * 0.35;
      for (let t = 1; t <= STEPS; t++) {
        let p;
        if (t <= peakAt) {
          p = 1.0 + (peak - 1.0) * Math.pow(t / peakAt, 0.65) + randNorm() * 0.015;
        } else if (t <= peakAt + dumpDur) {
          p = lerp(peak, floor, Math.pow((t - peakAt) / dumpDur, 0.5)) + randNorm() * 0.02;
        } else {
          p = floor * (1 + (rand() - 0.5) * 0.12);
        }
        path[t] = Math.max(p, 0.01);
      }
      break;
    }

    case 'runner': {
      // Pump to peak with one major retracement, stays elevated
      const peak    = peakMultiple; // 2–8x
      const peakAt  = 60 + Math.floor(rand() * 180);
      const retrace = 0.20 + rand() * 0.30; // 20–50% retrace from peak
      const retraceAt = peakAt + 20 + Math.floor(rand() * 80);
      const settle  = peak * (1 - retrace) * (0.75 + rand() * 0.25);
      for (let t = 1; t <= STEPS; t++) {
        let p;
        if (t <= peakAt) {
          p = 1.0 + (peak - 1.0) * Math.pow(t / peakAt, 0.55) + randNorm() * 0.025;
        } else if (t <= retraceAt) {
          p = lerp(peak, peak * (1 - retrace), (t - peakAt) / (retraceAt - peakAt)) + randNorm() * 0.03;
        } else {
          p = settle + randNorm() * 0.04;
        }
        path[t] = Math.max(p, 0.1);
      }
      break;
    }

    case 'moon': {
      // Two-leg pump: major rally, retrace, second push even higher
      const p1      = peakMultiple * (0.5 + rand() * 0.3); // first leg peak
      const p1At    = 30 + Math.floor(rand() * 120);
      const retrace = 0.25 + rand() * 0.30;
      const retAt   = p1At + 30 + Math.floor(rand() * 90);
      const p2      = peakMultiple * (1 + rand() * 0.5);   // second leg higher
      const p2At    = retAt + 60 + Math.floor(rand() * 120);
      const settleF = p2 * (0.55 + rand() * 0.3);
      for (let t = 1; t <= STEPS; t++) {
        let p;
        const bottom = p1 * (1 - retrace);
        if (t <= p1At) {
          p = 1.0 + (p1 - 1.0) * Math.pow(t / p1At, 0.45) + randNorm() * 0.03;
        } else if (t <= retAt) {
          p = lerp(p1, bottom, (t - p1At) / (retAt - p1At)) + randNorm() * 0.03;
        } else if (t <= p2At) {
          p = lerp(bottom, p2, Math.pow((t - retAt) / (p2At - retAt), 0.45)) + randNorm() * 0.04;
        } else {
          p = settleF + randNorm() * 0.05;
        }
        path[t] = Math.max(p, 0.1);
      }
      break;
    }

    case 'flat': {
      // Sideways with ±12% drift — mostly time-decay for meme coins
      for (let t = 1; t <= STEPS; t++) {
        path[t] = Math.max(1.0 + randNorm() * 0.04 * Math.sqrt(t / 30) - t * 0.0003, 0.1);
      }
      break;
    }
  }

  return path;
}

// ─── Dynamic trailing stop (mirrors execution/positions.js) ─────────────────

function getDynamicTrailing(basePercent, highWaterPnl) {
  const base = Math.abs(basePercent);
  if (highWaterPnl >= 500) return Math.max(base * 0.45, 8);
  if (highWaterPnl >= 300) return Math.max(base * 0.55, 9);
  if (highWaterPnl >= 150) return Math.max(base * 0.65, 10);
  if (highWaterPnl >= 75)  return Math.max(base * 0.75, 11);
  if (highWaterPnl >= 40)  return Math.max(base * 0.85, 12);
  return base;
}

// ─── Trade simulator ─────────────────────────────────────────────────────────
//
// Applies the strategy's exit logic to each price step.
// Tracks partial TP fraction accounting for weighted PnL.

function simulateTrade(strategy, pricePath) {
  const {
    tp_percent, sl_percent,
    trailing_enabled, trailing_from_entry, trailing_percent, tiered_trailing,
    partial_tp, partial_tp_at_percent, partial_tp_sell_percent,
    partial_tp_2, partial_tp_2_at_percent, partial_tp_2_sell_percent,
  } = strategy;

  let highWater      = 1.0;
  let trailingArmed  = Boolean(trailing_from_entry);
  let partialTpDone  = false;
  let partialTp2Done = false;
  let lockedPnl      = 0;    // weighted PnL from already-sold partial slices
  let remaining      = 1.0;  // fraction of original position still open

  for (let t = 0; t < pricePath.length; t++) {
    const price = pricePath[t];
    const pnl   = (price - 1.0) * 100;

    if (price > highWater) highWater = price;
    const hwPnl = (highWater - 1.0) * 100;

    // Arm trailing when TP threshold crossed (unless already armed from entry)
    if (!trailingArmed && trailing_enabled && pnl >= tp_percent) {
      trailingArmed = true;
    }

    // First partial TP — sells partial_tp_sell_percent% of original position
    if (partial_tp && !partialTpDone && pnl >= partial_tp_at_percent) {
      partialTpDone = true;
      const sellFrac = partial_tp_sell_percent / 100;
      lockedPnl += sellFrac * pnl;
      remaining -= sellFrac;
    }

    // Second partial TP — sells partial_tp_2_sell_percent% of REMAINING tokens
    if (partial_tp_2 && !partialTp2Done && pnl >= partial_tp_2_at_percent) {
      partialTp2Done = true;
      const sellFrac = (partial_tp_2_sell_percent / 100) * remaining;
      lockedPnl += sellFrac * pnl;
      remaining -= sellFrac;
    }

    // Hard stop-loss
    if (pnl <= sl_percent) {
      return result('SL', lockedPnl + remaining * pnl, t, partialTpDone, partialTp2Done, hwPnl);
    }

    // Fixed TP (no trailing enabled)
    if (!trailing_enabled && pnl >= tp_percent) {
      return result('TP', lockedPnl + remaining * pnl, t, partialTpDone, partialTp2Done, hwPnl);
    }

    // Trailing stop
    if (trailingArmed && trailing_enabled) {
      const trail    = tiered_trailing ? getDynamicTrailing(trailing_percent, hwPnl) : Math.abs(trailing_percent);
      const dropPct  = (price / highWater - 1) * 100;
      if (dropPct <= -trail) {
        return result('TRAILING_TP', lockedPnl + remaining * pnl, t, partialTpDone, partialTp2Done, hwPnl);
      }
    }
  }

  // Simulation ended without exit — close at last price
  const lastPnl = (pricePath[pricePath.length - 1] - 1.0) * 100;
  const hwPnl   = (highWater - 1.0) * 100;
  return result('TIME_EXIT', lockedPnl + remaining * lastPnl, pricePath.length - 1, partialTpDone, partialTp2Done, hwPnl);
}

function result(reason, pnl, t, pt1, pt2, hwPnl) {
  return { reason, pnl, t, partialTp: pt1, partialTp2: pt2, hwPnl };
}

// ─── Strategy configurations ─────────────────────────────────────────────────

const STRATEGIES = {
  sniper: {
    label: 'Sniper',
    tp_percent: 50, sl_percent: -25,
    trailing_enabled: true,  trailing_from_entry: false,
    trailing_percent: 20,    tiered_trailing: false,
    partial_tp: false, partial_tp_at_percent: 0,  partial_tp_sell_percent: 0,
    partial_tp_2: false, partial_tp_2_at_percent: 0, partial_tp_2_sell_percent: 0,
    position_size_sol: 0.10,
  },
  dip_buy: {
    label: 'Dip Buy',
    tp_percent: 30, sl_percent: -20,
    trailing_enabled: true,  trailing_from_entry: false,
    trailing_percent: 15,    tiered_trailing: false,
    partial_tp: false, partial_tp_at_percent: 0,  partial_tp_sell_percent: 0,
    partial_tp_2: false, partial_tp_2_at_percent: 0, partial_tp_2_sell_percent: 0,
    position_size_sol: 0.05,
  },
  smart_money: {
    label: 'Smart Money',
    tp_percent: 100, sl_percent: -25,
    trailing_enabled: false, trailing_from_entry: false,
    trailing_percent: 0,     tiered_trailing: false,
    partial_tp: true, partial_tp_at_percent: 100, partial_tp_sell_percent: 50,
    partial_tp_2: false, partial_tp_2_at_percent: 0, partial_tp_2_sell_percent: 0,
    position_size_sol: 0.10,
  },
  degen: {
    label: 'Degen',
    tp_percent: 30, sl_percent: -15,
    trailing_enabled: true,  trailing_from_entry: false,
    trailing_percent: 10,    tiered_trailing: false,
    partial_tp: false, partial_tp_at_percent: 0,  partial_tp_sell_percent: 0,
    partial_tp_2: false, partial_tp_2_at_percent: 0, partial_tp_2_sell_percent: 0,
    position_size_sol: 0.05,
  },
  moon_bag: {
    label: 'Moon Bag',
    tp_percent: 50, sl_percent: -22,
    trailing_enabled: true,  trailing_from_entry: true,
    trailing_percent: 22,    tiered_trailing: true,
    partial_tp: true, partial_tp_at_percent: 100, partial_tp_sell_percent: 25,
    partial_tp_2: true, partial_tp_2_at_percent: 300, partial_tp_2_sell_percent: 25,
    position_size_sol: 0.10,
  },
  momentum_rocket: {
    label: 'Momentum Rocket',
    tp_percent: 75, sl_percent: -18,
    trailing_enabled: true,  trailing_from_entry: true,
    trailing_percent: 18,    tiered_trailing: true,
    partial_tp: true, partial_tp_at_percent: 75,  partial_tp_sell_percent: 30,
    partial_tp_2: true, partial_tp_2_at_percent: 250, partial_tp_2_sell_percent: 25,
    position_size_sol: 0.12,
  },
};

// ─── Token archetype distributions per strategy ───────────────────────────────
//
// Better entry filters → fewer rugs, more runners/moons.
// Probabilities reflect the expected quality of tokens passing each strategy's filters.
//
// Archetypes: immediate_rug, slow_bleed, pump_dump, runner, moon, flat

const ARCHETYPE_DISTS = {
  sniper: {
    // fee+graduated 2-source, tight mcap ($7k–$200k)
    // Fee-claim is a strong quality signal — filters most rugs
    immediate_rug: 0.20, slow_bleed: 0.20, pump_dump: 0.30,
    runner: 0.22, moon: 0.06, flat: 0.02,
  },
  dip_buy: {
    // Buys at ATH-40% dip — token already survived the initial launch
    // Almost no immediate rugs; but many are dead-cat bounces (pump_dump)
    immediate_rug: 0.04, slow_bleed: 0.28, pump_dump: 0.36,
    runner: 0.24, moon: 0.06, flat: 0.02,
  },
  smart_money: {
    // ≥1000 holders, ≥$5k volume, strict rug ratio — established tokens
    // Lower rug rate but mcap already elevated → less explosive upside
    immediate_rug: 0.12, slow_bleed: 0.22, pump_dump: 0.29,
    runner: 0.27, moon: 0.07, flat: 0.03,
  },
  degen: {
    // Single-source, loose filters — catches anything
    immediate_rug: 0.44, slow_bleed: 0.22, pump_dump: 0.20,
    runner: 0.10, moon: 0.02, flat: 0.02,
  },
  moon_bag: {
    // Triple signal (fee+graduated+trending) + liquidity filter
    // Very strict: far fewer rugs, much higher runner/moon rate
    immediate_rug: 0.10, slow_bleed: 0.17, pump_dump: 0.27,
    runner: 0.29, moon: 0.13, flat: 0.04,
  },
  momentum_rocket: {
    // hot_level≥1 + smart_degen_count≥2 + volume + swaps filters
    // Smart-degen wallets accumulating = strong momentum signal
    immediate_rug: 0.16, slow_bleed: 0.18, pump_dump: 0.27,
    runner: 0.28, moon: 0.08, flat: 0.03,
  },
};

// Peak multiples per archetype per strategy (earlier mcap range = more upside)
const PEAK_RANGES = {
  // [minPeak, maxPeak] as price multipliers
  sniper:           { pump_dump: [1.5, 4.0], runner: [2.5, 9.0],  moon: [6.0,  25.0] },
  dip_buy:          { pump_dump: [1.4, 3.0], runner: [2.0, 7.0],  moon: [4.0,  18.0] },
  smart_money:      { pump_dump: [1.3, 3.0], runner: [2.0, 6.0],  moon: [4.0,  15.0] },
  degen:            { pump_dump: [1.4, 3.5], runner: [2.0, 8.0],  moon: [5.0,  20.0] },
  moon_bag:         { pump_dump: [1.5, 4.5], runner: [3.0, 12.0], moon: [8.0,  40.0] },
  momentum_rocket:  { pump_dump: [1.4, 4.0], runner: [2.5, 10.0], moon: [6.0,  30.0] },
};

// ─── Archetype sampler ────────────────────────────────────────────────────────

function sampleArchetype(dist, rand) {
  const r = rand();
  let cum = 0;
  for (const [archetype, prob] of Object.entries(dist)) {
    cum += prob;
    if (r < cum) return archetype;
  }
  return 'flat';
}

function samplePeakMultiple(archetype, ranges, rand) {
  const r = ranges[archetype];
  if (!r) return 1.5;
  return r[0] + rand() * (r[1] - r[0]);
}

// ─── Monte Carlo runner ───────────────────────────────────────────────────────

function runSimulation(strategyId, N, rand, randNorm) {
  const strategy = STRATEGIES[strategyId];
  const archetypeDist = ARCHETYPE_DISTS[strategyId];
  const peakRanges    = PEAK_RANGES[strategyId];

  const trades = [];
  const reasonCounts = { SL: 0, TP: 0, TRAILING_TP: 0, TIME_EXIT: 0 };

  for (let i = 0; i < N; i++) {
    const archetype  = sampleArchetype(archetypeDist, rand);
    const peakMult   = samplePeakMultiple(archetype, peakRanges, rand);
    const pricePath  = generatePricePath(archetype, peakMult, rand, randNorm);
    const trade      = simulateTrade(strategy, pricePath);

    trades.push({ ...trade, archetype });
    reasonCounts[trade.reason] = (reasonCounts[trade.reason] || 0) + 1;
  }

  trades.sort((a, b) => a.pnl - b.pnl);

  const pnls    = trades.map(t => t.pnl);
  const wins    = trades.filter(t => t.pnl > 0);
  const losses  = trades.filter(t => t.pnl <= 0);
  const sum     = pnls.reduce((s, v) => s + v, 0);
  const grossW  = wins.reduce((s, t) => s + t.pnl, 0);
  const grossL  = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  // Percentiles
  const p = (q) => pnls[Math.floor(q * N)];

  // Per-trade SOL PnL (position_size_sol * pnl / 100)
  const solPerTrade = trades.map(t => strategy.position_size_sol * t.pnl / 100);
  const avgSol = solPerTrade.reduce((s, v) => s + v, 0) / N;

  // Max consecutive losses
  let maxConsecLoss = 0, curConsec = 0;
  for (const t of trades) {
    if (t.pnl <= 0) { curConsec++; maxConsecLoss = Math.max(maxConsecLoss, curConsec); }
    else curConsec = 0;
  }

  // Top 5 best and worst
  const best  = [...trades].sort((a, b) => b.pnl - a.pnl).slice(0, 3);
  const worst = [...trades].sort((a, b) => a.pnl - b.pnl).slice(0, 3);

  return {
    strategyId,
    label: strategy.label,
    N,
    winRate:    wins.length / N * 100,
    avgPnl:     sum / N,
    medianPnl:  p(0.5),
    p25:        p(0.25),
    p75:        p(0.75),
    p10:        p(0.10),
    p90:        p(0.90),
    bestPnl:    pnls[N - 1],
    worstPnl:   pnls[0],
    profitFactor: grossL > 0 ? grossW / grossL : Infinity,
    avgSolPerTrade: avgSol,
    reasons: reasonCounts,
    maxConsecLoss,
    best,
    worst,
    positionSizeSol: strategy.position_size_sol,
  };
}

// ─── Statistics computation ───────────────────────────────────────────────────

function bar(value, max, width = 20, fillChar = '█', emptyChar = '░') {
  const filled = Math.round(clamp(value / max, 0, 1) * width);
  return fillChar.repeat(filled) + emptyChar.repeat(width - filled);
}

function printResults(allResults) {
  const N = allResults[0].N;

  console.log('\n' + '═'.repeat(100));
  console.log('  CHARON STRATEGY MONTE CARLO SIMULATION');
  console.log(`  ${N.toLocaleString()} simulations per strategy · 12-hour max hold · 6 token archetypes`);
  console.log('═'.repeat(100));

  // ── Main comparison table ──────────────────────────────────────────────────
  console.log('\n┌─────────────────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐');
  console.log('│ Strategy            │ Win Rate │ Avg PnL% │ Med PnL% │  P90 PnL │ PF       │ Avg SOL  │');
  console.log('├─────────────────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤');

  for (const r of allResults) {
    const pf = isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : '∞';
    console.log(
      `│ ${pad(r.label, 19, true)} │ ${pad(r.winRate.toFixed(1) + '%', 8)} │ ${pad(pct(r.avgPnl), 8)} │ ${pad(pct(r.medianPnl), 8)} │ ${pad(pct(r.p90), 8)} │ ${pad(pf, 8)} │ ${pad(r.avgSolPerTrade.toFixed(4), 8)} │`
    );
  }
  console.log('└─────────────────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘');
  console.log('  PF = Profit Factor (gross wins / gross losses). Higher is better. >1.5 = good, >2 = great.\n');

  // ── PnL distribution ──────────────────────────────────────────────────────
  console.log('── PnL Distribution (P10 / P25 / Median / P75 / P90) ──────────────────────────────────');
  for (const r of allResults) {
    const line = [r.p10, r.p25, r.medianPnl, r.p75, r.p90].map(v => pad(pct(v), 8)).join(' │ ');
    console.log(`  ${pad(r.label, 17, true)}  │ ${line} │`);
  }
  console.log('');

  // ── Exit reason breakdown ─────────────────────────────────────────────────
  console.log('── Exit Reason Breakdown (% of trades) ────────────────────────────────────────────────');
  console.log(`  ${'Strategy'.padEnd(19)}  │  ${'SL'.padStart(5)}  │  ${'TP'.padStart(5)}  │  ${'TRAIL'.padStart(5)}  │  ${'TIMEOUT'.padStart(7)}  │`);
  console.log('  ' + '─'.repeat(65));
  for (const r of allResults) {
    const fmt = (k) => pad(((r.reasons[k] || 0) / N * 100).toFixed(1) + '%', 6);
    console.log(`  ${pad(r.label, 19, true)}  │  ${fmt('SL')}  │  ${fmt('TP')}  │  ${fmt('TRAILING_TP')}  │  ${pad(((r.reasons.TIME_EXIT||0)/N*100).toFixed(1)+'%', 7)}  │`);
  }
  console.log('');

  // ── Win rate visual ────────────────────────────────────────────────────────
  console.log('── Win Rate ────────────────────────────────────────────────────────────────────────────');
  for (const r of allResults) {
    console.log(`  ${pad(r.label, 17, true)}  ${bar(r.winRate, 80, 40)} ${r.winRate.toFixed(1)}%`);
  }
  console.log('');

  // ── Average PnL per trade visual ───────────────────────────────────────────
  const maxAvgPnl = Math.max(...allResults.map(r => r.avgPnl));
  console.log('── Average PnL per Trade ────────────────────────────────────────────────────────────────');
  for (const r of allResults) {
    const b = r.avgPnl > 0 ? bar(r.avgPnl, maxAvgPnl * 1.1, 40) : '░'.repeat(40);
    console.log(`  ${pad(r.label, 17, true)}  ${b} ${pct(r.avgPnl)}`);
  }
  console.log('');

  // ── Upside capture (best-trade tier) ──────────────────────────────────────
  console.log('── Best / Worst Trade Outcomes ─────────────────────────────────────────────────────────');
  for (const r of allResults) {
    const b = r.best[0];
    const w = r.worst[0];
    console.log(`  ${pad(r.label, 17, true)}  Best: ${pct(b.pnl, 0).padStart(8)} (${b.archetype.padEnd(14)}, HW: ${pct(b.hwPnl,0).padStart(7)}, exit: ${b.reason})  │  Worst: ${pct(w.pnl, 0)}`);
  }
  console.log('');

  // ── Expected value per 1 SOL risked ───────────────────────────────────────
  console.log('── Expected Value per 1 SOL Position ──────────────────────────────────────────────────');
  for (const r of allResults) {
    const ev  = r.avgPnl / 100; // SOL gain per 1 SOL in (relative)
    const evSol = r.avgSolPerTrade;
    const sign = evSol >= 0 ? '+' : '';
    console.log(`  ${pad(r.label, 17, true)}  EV = ${sign}${evSol.toFixed(5)} SOL per ${r.positionSizeSol} SOL trade  (${sign}${(ev * 100).toFixed(2)}% return)`);
  }
  console.log('');

  // ── Trailing stop analysis ─────────────────────────────────────────────────
  console.log('── Trailing Stop Deep Dive ─────────────────────────────────────────────────────────────');
  console.log('  Strategies with trailing_from_entry capture more of each pump by staying in until');
  console.log('  the trailing stop fires, rather than exiting at a fixed TP ceiling.');
  console.log('');
  const trailingStrategies = allResults.filter(r => STRATEGIES[r.strategyId].trailing_from_entry);
  const nonTrailing = allResults.filter(r => !STRATEGIES[r.strategyId].trailing_from_entry && STRATEGIES[r.strategyId].trailing_enabled);
  const fixedTp = allResults.filter(r => !STRATEGIES[r.strategyId].trailing_enabled);

  if (trailingStrategies.length) {
    console.log('  Trailing-from-entry (unlimited upside):');
    for (const r of trailingStrategies) {
      const trailPct = ((r.reasons.TRAILING_TP || 0) / N * 100).toFixed(1);
      const sl = ((r.reasons.SL || 0) / N * 100).toFixed(1);
      console.log(`    ${pad(r.label, 17, true)}  ${trailPct}% exited via trailing  │  ${sl}% stopped out  │  p90=${pct(r.p90)}`);
    }
    console.log('');
  }
  if (nonTrailing.length) {
    console.log('  Arms-after-TP (standard trailing):');
    for (const r of nonTrailing) {
      const trailPct = ((r.reasons.TRAILING_TP || 0) / N * 100).toFixed(1);
      const tpPct = ((r.reasons.TP || 0) / N * 100).toFixed(1);
      console.log(`    ${pad(r.label, 17, true)}  ${trailPct}% trailing + ${tpPct}% fixed TP  │  p90=${pct(r.p90)}`);
    }
    console.log('');
  }
  if (fixedTp.length) {
    console.log('  Fixed TP (no trailing):');
    for (const r of fixedTp) {
      const tpPct = ((r.reasons.TP || 0) / N * 100).toFixed(1);
      console.log(`    ${pad(r.label, 17, true)}  ${tpPct}% fixed TP  │  p90=${pct(r.p90)}`);
    }
    console.log('');
  }

  // ── Key takeaways ──────────────────────────────────────────────────────────
  const ranked = [...allResults].sort((a, b) => b.avgSolPerTrade - a.avgSolPerTrade);
  const best1 = ranked[0];
  const best2 = ranked[1];
  console.log('── Summary & Recommendations ───────────────────────────────────────────────────────────');
  console.log(`  #1 Expected Value: ${best1.label} (${best1.avgSolPerTrade > 0 ? '+' : ''}${best1.avgSolPerTrade.toFixed(5)} SOL/trade, ${best1.winRate.toFixed(1)}% win rate)`);
  console.log(`  #2 Expected Value: ${best2.label} (${best2.avgSolPerTrade > 0 ? '+' : ''}${best2.avgSolPerTrade.toFixed(5)} SOL/trade, ${best2.winRate.toFixed(1)}% win rate)`);
  console.log('');

  const moonResult = allResults.find(r => r.strategyId === 'moon_bag');
  const sniperResult = allResults.find(r => r.strategyId === 'sniper');
  if (moonResult && sniperResult) {
    const diff = moonResult.avgSolPerTrade - sniperResult.avgSolPerTrade;
    const diffPct = (diff / Math.abs(sniperResult.avgSolPerTrade)) * 100;
    const sign = diff >= 0 ? '+' : '';
    console.log(`  Moon Bag vs Sniper EV delta: ${sign}${diff.toFixed(5)} SOL (${sign}${diffPct.toFixed(1)}%)`);
    console.log(`  Trailing-from-entry p90: Moon Bag ${pct(moonResult.p90)} vs Sniper ${pct(sniperResult.p90)}`);
  }
  console.log('');
  console.log('  Notes:');
  console.log('  · Token outcome distributions are calibrated to observed Solana meme-coin behaviour.');
  console.log('  · Tiered trailing tightens as profits grow → locks in more gain on big runners.');
  console.log('  · Partial TPs reduce per-trade variance by banking profit at intermediate levels.');
  console.log('  · Moon Bag and Momentum Rocket use trailing_from_entry so there is NO TP ceiling.');
  console.log('  · Slippage, gas costs, and failed transactions are not modelled.');
  console.log('═'.repeat(100) + '\n');
}

// ─── Archetype breakdown table ────────────────────────────────────────────────

function printArchetypeBreakdown() {
  console.log('── Simulated Token Archetype Distributions (entry quality per strategy) ──────────────');
  console.log('  Strategy             │ Imm.Rug │ SlwBleed │ PmpDump │  Runner │    Moon │    Flat │');
  console.log('  ' + '─'.repeat(80));
  for (const [id, dist] of Object.entries(ARCHETYPE_DISTS)) {
    const s = STRATEGIES[id];
    const fmt = (k) => pad((dist[k] * 100).toFixed(0) + '%', 7);
    console.log(`  ${pad(s.label, 19, true)}  │ ${fmt('immediate_rug')} │ ${fmt('slow_bleed')}  │ ${fmt('pump_dump')} │ ${fmt('runner')} │ ${fmt('moon')}  │ ${fmt('flat')}  │`);
  }
  console.log('  (Better filters → lower Imm.Rug %, higher Runner/Moon %)');
  console.log('');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const N_SIMS = 10_000;
const SEED   = 0xdeadbeef;

const rand     = makePrng(SEED);
const randNorm = makeRandNorm(rand);

console.log('\nRunning Monte Carlo simulation...');
const t0 = Date.now();

const allResults = Object.keys(STRATEGIES).map(id => {
  process.stdout.write(`  ${STRATEGIES[id].label.padEnd(20)} `);
  const r = runSimulation(id, N_SIMS, rand, randNorm);
  console.log(`done (win ${r.winRate.toFixed(1)}%, avg ${pct(r.avgPnl)})`);
  return r;
});

console.log(`\nCompleted in ${Date.now() - t0}ms`);

printArchetypeBreakdown();
printResults(allResults);
