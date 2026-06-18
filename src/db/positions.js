import { db } from './connection.js';
import { now, json } from '../utils.js';
import { numSetting, boolSetting, setting, activeStrategy } from './settings.js';

export function getRecapStats() {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const cutoff24h = Date.now() - DAY_MS;

  function statsFor(rows) {
    const closed = rows.filter(r => r.status === 'closed');
    const wins   = closed.filter(r => Number(r.pnl_percent || 0) > 0);
    const losses = closed.filter(r => Number(r.pnl_percent || 0) <= 0);
    const totalPnlPct = closed.reduce((s, r) => s + Number(r.pnl_percent || 0), 0);
    const totalPnlSol = closed.reduce((s, r) => s + Number(r.pnl_sol || 0), 0);
    const byReason = {};
    for (const r of closed) {
      const k = r.exit_reason || 'UNKNOWN';
      byReason[k] = (byReason[k] || 0) + 1;
    }
    const best = [...closed].sort((a, b) => Number(b.pnl_percent || 0) - Number(a.pnl_percent || 0)).slice(0, 3);
    return {
      total: rows.length,
      closed: closed.length,
      open: rows.length - closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? wins.length / closed.length * 100 : null,
      avgPnlPct: closed.length ? totalPnlPct / closed.length : null,
      totalPnlPct,
      totalPnlSol,
      byReason,
      best,
    };
  }

  const allRows  = db.prepare('SELECT * FROM dry_run_positions ORDER BY opened_at_ms DESC').all();
  const rows24h  = allRows.filter(r => Number(r.opened_at_ms || 0) >= cutoff24h);
  const openRows = allRows.filter(r => r.status === 'open');

  return {
    allTime: statsFor(allRows),
    last24h: statsFor(rows24h),
    openPositions: openRows,
  };
}

export function openPositions() {
  return db.prepare('SELECT * FROM dry_run_positions WHERE status = ? ORDER BY opened_at_ms DESC').all('open');
}

export function openPositionCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = ?').get('open').count;
}

export function canOpenMorePositions() {
  const strat = activeStrategy();
  const max = strat.max_open_positions ?? numSetting('max_open_positions', 3);
  if (max <= 0) return true;
  return openPositionCount() < max;
}

export function tradingMode() {
  const mode = setting('trading_mode', 'dry_run');
  return ['dry_run', 'confirm', 'live'].includes(mode) ? mode : 'dry_run';
}

// Conviction-weighted position sizing. When a strategy enables conviction_sizing, the
// buy size scales linearly with the LLM confidence between position_size_min_sol and
// position_size_max_sol — more capital on stronger signals, less on borderline ones.
// Deterministic given (strat, decision.confidence) so every call site resolves the same size.
export function resolvePositionSizeSol(strat, decision) {
  const base = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  if (!strat.conviction_sizing) return base;
  const min = strat.position_size_min_sol ?? base;
  const max = strat.position_size_max_sol ?? base;
  if (max <= min) return base;
  const conf = Number(decision?.confidence);
  if (!Number.isFinite(conf)) return base;
  const floor = strat.llm_min_confidence ?? 0;
  const span = Math.max(1, 100 - floor);
  const t = Math.max(0, Math.min(1, (conf - floor) / span));
  return Math.round((min + (max - min) * t) * 1000) / 1000;
}

// Daily realized PnL (SOL) since UTC midnight — basis for the circuit breaker.
export function dailyRealizedPnlSol() {
  const startOfDayMs = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
  const row = db.prepare(
    "SELECT COALESCE(SUM(pnl_sol), 0) AS pnl FROM dry_run_positions WHERE status = 'closed' AND closed_at_ms >= ?"
  ).get(startOfDayMs);
  return Number(row.pnl || 0);
}

// Circuit breaker: pause new automated entries once today's realized losses exceed the
// configured limit. Protects against a bad cluster of rugs draining the day's capital.
export function circuitBreakerTripped() {
  if (!boolSetting('circuit_breaker_enabled', true)) return false;
  const limit = numSetting('daily_loss_limit_sol', 0.35);
  if (limit <= 0) return false;
  return dailyRealizedPnlSol() <= -limit;
}

export function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

// Re-entry cooldown: never catch the falling knife on a token you just exited. A token that
// stopped you out is in a downtrend — re-buying it on the next signal is how a single bad
// token turns into 4-5 losing trades. Returns cooldown info if blocked, else null.
//   reentry_cooldown_ms       — block any re-entry within this window after a close
//   reentry_loss_cooldown_ms  — longer block when the last exit was a loss
export function reentryBlockedUntil(mint) {
  const strat = activeStrategy();
  const anyCd = Number(strat.reentry_cooldown_ms || 0);
  const lossCd = Number(strat.reentry_loss_cooldown_ms || 0);
  if (anyCd <= 0 && lossCd <= 0) return null;
  const last = db.prepare(`
    SELECT closed_at_ms, pnl_percent, exit_reason FROM dry_run_positions
    WHERE mint = ? AND status = 'closed' AND closed_at_ms IS NOT NULL
    ORDER BY closed_at_ms DESC LIMIT 1
  `).get(mint);
  if (!last || !last.closed_at_ms) return null;
  const wasLoss = Number(last.pnl_percent || 0) <= 0;
  const cd = wasLoss ? Math.max(anyCd, lossCd) : anyCd;
  if (cd <= 0) return null;
  const until = Number(last.closed_at_ms) + cd;
  if (now() >= until) return null;
  return { until, wasLoss, lastPnl: Number(last.pnl_percent || 0), exitReason: last.exit_reason };
}

// Consecutive-loss pause: when the last K closed trades are all losses and the most recent
// closed within the pause window, stop opening new positions. Stops the bot from grinding
// capital into a losing session. Naturally resets once a win lands or the window elapses.
export function consecutiveLossPause() {
  const strat = activeStrategy();
  const k = Number(strat.consecutive_loss_limit || 0);
  const pauseMs = Number(strat.consecutive_loss_pause_ms || 0);
  if (k <= 0 || pauseMs <= 0) return false;
  const recent = db.prepare(`
    SELECT pnl_percent, closed_at_ms FROM dry_run_positions
    WHERE status = 'closed' AND closed_at_ms IS NOT NULL
    ORDER BY closed_at_ms DESC LIMIT ?
  `).all(k);
  if (recent.length < k) return false;
  if (!recent.every(r => Number(r.pnl_percent || 0) <= 0)) return false;
  const lastClose = Number(recent[0].closed_at_ms || 0);
  return (now() - lastClose) < pauseMs;
}

export function createDryRunPosition(candidateId, candidate, decision, reason = 'llm_buy') {
  const strat = activeStrategy();
  const sizeSol = resolvePositionSizeSol(strat, decision);
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  // Strategy exit params take precedence — they are tuned per-strategy. The LLM's
  // generic suggestion is only a fallback when the strategy doesn't define a value.
  const tp = Number(strat.tp_percent ?? decision.suggested_tp_percent ?? numSetting('default_tp_percent', 50));
  const sl = Number(strat.sl_percent ?? decision.suggested_sl_percent ?? numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  // Guard against a zero/invalid trail width: 0 silently becomes 20% downstream
  // (getDynamicTrailingPercent's || 20 fallback) while the UI shows 0.0% — confusing and wider than intended.
  const stratTrail = Number(strat.trailing_percent);
  const trailingPercent = stratTrail > 0 ? stratTrail : numSetting('default_trailing_percent', 20);
  const trailingFromEntry = strat.trailing_from_entry ? 1 : 0;

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return existing.id;

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, trailing_from_entry,
        llm_decision_id, strategy_id, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      trailingFromEntry,
      decision.id || null,
      strat.id,
      json({ candidate, decision, reason, strategy: strat.id }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return positionId;
  })();
}

export function createLivePosition(candidateId, candidate, decision, swap, reason = 'live_buy') {
  const strat = activeStrategy();
  const sizeSol = resolvePositionSizeSol(strat, decision);
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const tp = Number(strat.tp_percent ?? decision.suggested_tp_percent ?? numSetting('default_tp_percent', 50));
  const sl = Number(strat.sl_percent ?? decision.suggested_sl_percent ?? numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const stratTrail = Number(strat.trailing_percent);
  const trailingPercent = stratTrail > 0 ? stratTrail : numSetting('default_trailing_percent', 20);
  const trailingFromEntry = strat.trailing_from_entry ? 1 : 0;

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return existing.id;

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, trailing_from_entry, llm_decision_id,
        execution_mode, entry_signature, token_amount_raw, strategy_id, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'live', ?, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      trailingFromEntry,
      decision.id || null,
      swap.signature,
      swap.outputAmount || null,
      strat.id,
      json({ candidate, decision, reason, swap, strategy: strat.id }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision, swap }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return positionId;
  })();
}
