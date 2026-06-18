import axios from 'axios';
import { SIGNAL_SERVER_URL, SIGNAL_SERVER_KEY, SIGNAL_POLL_MS } from '../config.js';
import { now } from '../utils.js';
import { activeStrategy } from '../db/settings.js';
import { storeSignalEvent, trendingSignalPass, trending } from './trending.js';
import { graduated } from './graduated.js';

let candidateHandler = null;
let degenHandler = null;

export function setCandidateHandler(fn) { candidateHandler = fn; }
export function setDegenHandler(fn) { degenHandler = fn; }

const seenSignals = new Map();

function prune(map, ttlMs) {
  const at = now();
  for (const [key, ts] of map) {
    if (at - ts > ttlMs) map.delete(key);
  }
}

function signalKey(signal) {
  const sources = (signal.sources || []).sort().join('+');
  return `${signal.mint}:${sources}`;
}

async function triggerCandidate({ mint, fee, signature, graduatedCoin, trendingToken, route }) {
  if (!candidateHandler) return;
  await candidateHandler({ mint, fee, signature, graduatedCoin, trendingToken, route });
}

export async function fetchServerSignals() {
  try {
    const url = new URL('/api/signals', SIGNAL_SERVER_URL);
    url.searchParams.set('limit', '100');
    url.searchParams.set('minSources', '2');

    const res = await axios.get(url.toString(), {
      timeout: 10_000,
      headers: SIGNAL_SERVER_KEY ? { 'x-api-key': SIGNAL_SERVER_KEY } : {},
    });
    const signals = res.data?.signals || [];

    prune(seenSignals, 10 * 60_000);

    const strat = activeStrategy();
    let processed = 0;
    let triggered = 0;
    let dipAlerts = 0;

    for (const signal of signals) {
      const mint = signal.mint;
      if (!mint) continue;

      // Update graduated map
      if (signal.graduated) {
        graduated.set(mint, {
          ...signal.graduated,
          coinMint: mint,
          seenAt: now(),
          // Server doesn't nest these on the graduated object — pull from top-level
          name: signal.name,
          ticker: signal.symbol,
          volume: signal.volume24h ?? 0,
          marketCap: signal.marketCapUsd ?? 0,
        });
      }

      // Update trending map
      if (signal.trending) {
        const trendingToken = {
          address: mint,
          name: signal.name,
          symbol: signal.symbol,
          price: signal.priceUsd,
          market_cap: signal.marketCapUsd,
          liquidity: signal.liquidityUsd,
          holder_count: signal.holders,
          volume: signal.volume5m ?? signal.volume24h ?? 0,
          // Server sends buys/sells separately; compute swaps so trending_min_swaps works
          swaps: (signal.trending.buys ?? 0) + (signal.trending.sells ?? 0),
          source: signal.sources?.find(s => s.includes('trending')) || 'server',
          seenAt: now(),
          ...signal.trending,
        };
        trending.set(mint, trendingToken);
      }

      // Use source-aware key so a signal that gains more sources later isn't blocked
      const key = signalKey(signal);
      if (seenSignals.has(key)) { processed++; continue; }
      seenSignals.set(key, now());

      // Store signal events
      for (const source of signal.sources) {
        const kind = source.includes('trending') ? 'trending' : source.includes('fee') ? 'fee_claim' : 'graduated';
        storeSignalEvent(mint, kind, source, signal);
      }

      const graduatedCoin = graduated.get(mint) || signal.graduated || null;
      const trendingToken = trending.get(mint) || null;
      const hasFee = Boolean(signal.feeClaim);
      const sourceCount = signal.sourceCount || 1;

      // Strategy gate: check source count
      if (sourceCount < strat.min_source_count) {
        console.log(`[server] skip ${mint.slice(0, 8)} sources=${sourceCount} < min ${strat.min_source_count}`);
        processed++; continue;
      }

      // Strategy gate: fee claim requirement
      if (strat.require_fee_claim && !hasFee) {
        console.log(`[server] skip ${mint.slice(0, 8)} no fee claim (strategy requires it)`);
        processed++; continue;
      }

      // Strategy gate: token age
      if (strat.token_age_max_ms > 0) {
        const tokenAge = signal.ageMs || 0;
        if (tokenAge > strat.token_age_max_ms) {
          console.log(`[server] skip ${mint.slice(0, 8)} age=${Math.round(tokenAge/60000)}m > max ${Math.round(strat.token_age_max_ms/60000)}m`);
          processed++; continue;
        }
      }

      // Determine route
      let route = null;
      if (hasFee && graduatedCoin && trendingToken) route = 'fee_graduated_trending';
      else if (hasFee && graduatedCoin) route = 'fee_graduated';
      else if (hasFee && trendingToken) route = 'fee_trending';
      else if (graduatedCoin && trendingToken) route = 'graduated_trending';
      else if (sourceCount >= 3) route = 'multi_source';
      else if (sourceCount >= 2) route = 'dual_source';
      else route = 'single_source';

      // Build fee object if present
      let fee = null;
      let signature = null;
      if (signal.feeClaim) {
        fee = {
          mint,
          distributed: BigInt(Math.floor(signal.feeClaim.distributedSol * 1e9)),
          shareholders: (signal.feeClaim.shareholders || []).map(h => ({
            pubkey: h.address,
            bps: h.bps,
          })),
        };
        signature = signal.feeClaim.signature;
      }

      // Entry mode logic
      if (strat.entry_mode === 'wait_for_dip' && strat.max_ath_distance_pct < 0) {
        // Dip buy strategy: check if already at target
        const athDist = signal.graduated?.distanceFromAthPercent;
        if (athDist != null && athDist <= strat.max_ath_distance_pct) {
          // Already at dip target, trigger immediately
          await triggerCandidate({ mint, fee, signature, graduatedCoin, trendingToken, route });
          triggered++;
        } else {
          // Store price alert for later
          const { storePriceAlert } = await import('./priceMonitor.js');
          const targetPrice = signal.priceUsd ? signal.priceUsd * (1 + strat.max_ath_distance_pct / 100) : null;
          storePriceAlert({
            mint,
            strategyId: strat.id,
            alertType: 'dip_target',
            targetPriceUsd: targetPrice,
            targetAthDistancePercent: strat.max_ath_distance_pct,
            signal,
            expiresMs: 24 * 60 * 60 * 1000,
          });
          dipAlerts++;
        }
      } else {
        // Immediate entry mode (sniper, smart_money, degen)
        await triggerCandidate({ mint, fee, signature, graduatedCoin, trendingToken, route });
        triggered++;
      }

      processed++;
    }

    const dipPart = dipAlerts > 0 ? `, ${dipAlerts} dip alerts` : '';
    console.log(`[server] ${processed} signals, ${triggered} triggered${dipPart}, tracking ${trending.size}`);
  } catch (err) {
    console.log(`[server] ${err.message}`);
  }
}
