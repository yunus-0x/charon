import { now, pruneSeen } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { upsertCandidate, updateCandidateStatus, recentEligibleCandidates, candidateById } from '../db/candidates.js';
import { storeDecision, storeBatchDecision, logDecisionEvent } from '../db/decisions.js';
import { buildCandidate, filterCandidate, signalLabel } from './candidateBuilder.js';
import { decideCandidateBatch } from './llm.js';
import { activeStrategy } from '../db/settings.js';
import { createDryRunPosition, createLivePosition, canOpenMorePositions, openPositionCount, tradingMode, circuitBreakerTripped, dailyRealizedPnlSol, reentryBlockedUntil, consecutiveLossPause } from '../db/positions.js';
import { sendBatchReveal, sendTelegram, sendPositionOpen, sendTradeIntent } from '../telegram/send.js';
import { candidateSummary } from '../telegram/format.js';
import { createTradeIntent } from '../db/intents.js';
import { refreshCandidateForExecution } from '../execution/positions.js';
import { executeLiveBuy } from '../execution/router.js';
import { graduated } from '../signals/graduated.js';
import { setDegenHandler } from '../signals/trending.js';
import { setCandidateHandler } from '../signals/feeClaim.js';
import { short } from '../format.js';
import { escapeHtml } from '../format.js';

export const seenSignalCandidates = new Map();

// Throttle circuit-breaker Telegram alerts to once per UTC day so a busy signal feed
// doesn't spam the chat while trading is paused.
let lastCircuitBreakerAlertDay = null;

setDegenHandler(maybeProcessDegenCandidate);
setCandidateHandler(processCandidateFromSignals);

export async function processCandidateFromSignals(signals) {
  // Skip if max positions reached — don't waste enrichment/LLM calls
  if (!canOpenMorePositions()) {
    const max = numSetting('max_open_positions', 3);
    console.log(`[agent] max positions reached (${openPositionCount()}/${max}), skipping ${signals.mint.slice(0, 8)}...`);
    return;
  }

  // Re-entry cooldown — never re-buy a token we just exited (especially a loser). This is
  // the single biggest fix for the death-spiral where one bleeding token gets bought 4-5×.
  const cooldown = reentryBlockedUntil(signals.mint);
  if (cooldown) {
    const mins = Math.ceil((cooldown.until - now()) / 60000);
    console.log(`[agent] reentry cooldown ${signals.mint.slice(0, 8)} for ${mins}m (last exit ${cooldown.lastPnl.toFixed(1)}% ${cooldown.exitReason || ''})`);
    return;
  }

  const candidate = await buildCandidate(signals);
  const signature = signals.signature || null;
  const candidateId = upsertCandidate(candidate, signature);
  if (!candidate.filters.passed) {
    console.log(`[candidate] filtered ${candidate.token.mint.slice(0, 8)}... ${candidate.filters.failures.join('; ')}`);
    return;
  }

  const strat = activeStrategy();
  let rows, batchDecision, batchId;

  if (!strat.use_llm) {
    const selfRow = candidateById(candidateId);
    rows = selfRow ? [selfRow] : [];
    batchId = null;
    batchDecision = {
      verdict: 'BUY',
      confidence: 100,
      selected_candidate_id: candidateId,
      selected_mint: candidate.token.mint,
      selected_row: selfRow,
      reason: `Strategy '${strat.id}' is rule-based (use_llm: false); filters passed.`,
      risks: [],
      suggested_tp_percent: strat.tp_percent ?? numSetting('default_tp_percent', 50),
      suggested_sl_percent: strat.sl_percent ?? numSetting('default_sl_percent', -25),
      raw: null,
    };
  } else {
    rows = recentEligibleCandidates(numSetting('llm_candidate_pick_count', 10));
    batchDecision = await decideCandidateBatch(rows, candidateId);
    batchId = storeBatchDecision(candidateId, rows, batchDecision);
  }
  const selectedRow = batchDecision.selected_row;
  const selectedThisCandidate = selectedRow?.id === candidateId;
  const currentDecision = selectedThisCandidate
    ? batchDecision
    : {
        ...batchDecision,
        verdict: 'WATCH',
        reason: selectedRow
          ? `Batch #${batchId} screened ${rows.length}; selected ${short(selectedRow.candidate.token.mint)} instead. ${batchDecision.reason || ''}`.trim()
          : `Batch #${batchId} screened ${rows.length}; no buy selected. ${batchDecision.reason || ''}`.trim(),
      };
  const currentDecisionId = storeDecision(candidateId, candidate, currentDecision);
  currentDecision.id = currentDecisionId;
  updateCandidateStatus(candidateId, currentDecision.verdict.toLowerCase());

  if (selectedRow && !selectedThisCandidate) {
    const selectedDecisionId = storeDecision(selectedRow.id, selectedRow.candidate, batchDecision);
    batchDecision.id = selectedDecisionId;
    updateCandidateStatus(selectedRow.id, batchDecision.verdict.toLowerCase());
  } else if (selectedThisCandidate) {
    batchDecision.id = currentDecisionId;
  }

  // Use per-strategy confidence threshold (falls back to global setting if not set)
  const minConfidence = strat.llm_min_confidence ?? numSetting('llm_min_confidence', 75);
  const passesConfidence = batchDecision.verdict === 'BUY' && batchDecision.confidence >= minConfidence;
  // Circuit breaker: pause new automated entries after today's realized losses exceed the limit.
  const cbTripped = circuitBreakerTripped();
  // Consecutive-loss pause: stop grinding capital into a losing session.
  const lossPaused = consecutiveLossPause();
  // The LLM may select a different token than the trigger — re-check its cooldown too.
  const selectedCooldown = selectedRow ? reentryBlockedUntil(selectedRow.candidate.token.mint) : null;
  const willAutoBuy = selectedRow && boolSetting('agent_enabled', true)
    && !cbTripped && !lossPaused && !selectedCooldown && passesConfidence;

  // Alert (once/day) when the circuit breaker blocks a trade that would otherwise fire.
  if (cbTripped && selectedRow && boolSetting('agent_enabled', true) && passesConfidence) {
    const today = new Date().toISOString().slice(0, 10);
    if (lastCircuitBreakerAlertDay !== today) {
      lastCircuitBreakerAlertDay = today;
      const limit = numSetting('daily_loss_limit_sol', 0.35);
      await sendTelegram([
        '🛑 <b>Circuit breaker active — entries paused</b>',
        '',
        `Today's realized PnL: ${dailyRealizedPnlSol().toFixed(3)} SOL (limit −${limit} SOL)`,
        'New automated buys are paused until UTC midnight or until the limit is raised.',
      ].join('\n')).catch(() => {});
    }
  }

  // Skip batch reveal in dry_run when auto-buying — sendPositionOpen is the relevant notification
  if (batchId && !(tradingMode() === 'dry_run' && willAutoBuy)) {
    await sendBatchReveal(batchId, rows, batchDecision, candidateId);
  }

  if (willAutoBuy) {
    if (!canOpenMorePositions()) {
      const max = numSetting('max_open_positions', 3);
      console.log(`[agent] max open positions reached (${openPositionCount()}/${max}), skipping buy ${selectedRow.candidate.token.mint}`);
      logDecisionEvent({
        batchId,
        triggerCandidateId: candidateId,
        selectedRow,
        rows,
        decision: batchDecision,
        action: 'entry_skipped_max_positions',
        guardrails: { maxOpenPositions: max, openPositions: openPositionCount() },
      });
      return;
    }
    await handleApprovedBuy(selectedRow, batchDecision, batchId, rows, candidateId);

    // Secondary pick — if LLM found a second exceptional candidate, try to enter it too
    const secondaryRow = batchDecision.secondary_row;
    const secondaryConf = batchDecision.secondary_confidence || 0;
    if (secondaryRow && secondaryConf >= minConfidence && canOpenMorePositions()
        && !reentryBlockedUntil(secondaryRow.candidate.token.mint)) {
      const secondaryDecision = { ...batchDecision, selected_row: secondaryRow, confidence: secondaryConf,
        selected_candidate_id: secondaryRow.id, selected_mint: secondaryRow.candidate.token.mint };
      console.log(`[agent] secondary pick: ${secondaryRow.candidate.token.mint.slice(0, 8)} conf=${secondaryConf}`);
      await handleApprovedBuy(secondaryRow, secondaryDecision, batchId, rows, candidateId);
    }
  } else {
    logDecisionEvent({
      batchId,
      triggerCandidateId: candidateId,
      selectedRow,
      rows,
      decision: batchDecision,
      action: cbTripped && passesConfidence ? 'entry_skipped_circuit_breaker'
        : lossPaused && passesConfidence ? 'entry_skipped_consecutive_losses'
        : selectedCooldown && passesConfidence ? 'entry_skipped_reentry_cooldown'
        : selectedRow ? 'entry_not_approved' : 'no_candidate_selected',
      guardrails: {
        agentEnabled: boolSetting('agent_enabled', true),
        confidenceThreshold: minConfidence,
        openPositions: openPositionCount(),
        maxOpenPositions: numSetting('max_open_positions', 3),
        circuitBreaker: { tripped: cbTripped, dailyPnlSol: dailyRealizedPnlSol(), limitSol: numSetting('daily_loss_limit_sol', 0.35) },
        consecutiveLossPause: lossPaused,
        reentryCooldown: selectedCooldown ? { mint: selectedRow.candidate.token.mint, lastPnl: selectedCooldown.lastPnl } : null,
      },
    });
  }
}

export async function handleApprovedBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const mode = tradingMode();
  const freshSelectedRow = await refreshCandidateForExecution(selectedRow);
  const executionRows = rows.map(row => row.id === freshSelectedRow.id ? freshSelectedRow : row);
  if (!freshSelectedRow.candidate.filters?.passed) {
    updateCandidateStatus(freshSelectedRow.id, 'stale_rejected');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'entry_rejected_fresh_filters',
      guardrails: {
        failures: freshSelectedRow.candidate.filters?.failures || [],
        refreshedAtMs: freshSelectedRow.candidate.executionRefresh?.refreshedAtMs,
      },
    });
    await sendTelegram([
      '🛑 <b>Execution rejected on fresh check</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Failures: ${escapeHtml((freshSelectedRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
    ].join('\n'));
    return;
  }

  if (mode === 'dry_run') {
    const positionId = await createDryRunPosition(freshSelectedRow.id, freshSelectedRow.candidate, decision, `llm_batch_${batchId}`);
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'dry_run_entry',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { positionId },
    });
    await sendPositionOpen(positionId);
    return;
  }

  if (mode === 'confirm') {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'pending_confirmation');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'confirm_intent_created',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId },
    });
    await sendTradeIntent(intentId, freshSelectedRow.candidate, decision);
    return;
  }

  try {
    await executeLiveBuy(freshSelectedRow, decision, batchId, executionRows, triggerCandidateId);
  } catch (err) {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'execution_failed');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'live_entry_failed',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId, error: err.message },
    });
    await sendTelegram([
      '🛑 <b>Live trade failed</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Intent #${intentId} stored.`,
      `Error: ${escapeHtml(err.message)}`,
    ].join('\n'));
  }
}

export async function maybeProcessDegenCandidate(mint, trendingToken) {
  if (!boolSetting('trending_allow_degen', false)) return;
  const graduatedCoin = graduated.get(mint);
  if (!graduatedCoin) return;
  pruneSeen(seenSignalCandidates, 10 * 60 * 1000);
  const bucket = Math.floor(now() / (5 * 60 * 1000));
  const key = `graduated_trending:${mint}:${bucket}`;
  if (seenSignalCandidates.has(key)) return;
  seenSignalCandidates.set(key, now());
  await processCandidateFromSignals({
    mint,
    graduatedCoin,
    trendingToken,
    route: 'graduated_trending',
  });
}
