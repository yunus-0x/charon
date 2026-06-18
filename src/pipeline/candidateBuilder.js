import { now, firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn, lamToSol } from '../utils.js';
import { activeStrategy } from '../db/settings.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext } from '../enrichment/jupiter.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { fetchTwitterNarrative } from '../enrichment/twitter.js';
import { gmgnLink } from '../format.js';

export function buildFeeSnapshot(fee, signature) {
  return {
    mint: fee.mint,
    signature,
    distributedSol: lamToSol(fee.distributed),
    receivedAtMs: now(),   // when the bot detected this fee claim (for staleness gating)
    recipients: fee.shareholders.map(holder => ({
      address: holder.pubkey,
      bps: holder.bps,
      percent: holder.bps / 100,
    })),
  };
}

export function signalLabel(signals = {}) {
  return [
    signals.hasFeeClaim ? 'fees' : null,
    signals.hasGraduated ? 'graduated' : null,
    signals.hasTrending ? 'trending' : null,
  ].filter(Boolean).join(' + ') || signals.route || 'unknown';
}

export function filterCandidate(candidate) {
  const strat = activeStrategy();
  const failures = [];
  const mcap = candidate.metrics.marketCapUsd;
  const totalFees = candidate.metrics.gmgnTotalFeesSol;
  const gradVolume = candidate.metrics.graduatedVolumeUsd;
  const maxHolder = candidate.holders.maxHolderPercent;
  const savedCount = candidate.savedWalletExposure.holderCount;
  const feeSol = candidate.feeClaim?.distributedSol;
  const holderCount = Number(candidate.metrics.holderCount || 0);
  const liquidityUsd = Number(candidate.metrics.liquidityUsd || 0);
  const trendingVolume = Number(candidate.trending?.volume ?? 0);
  const trendingSwaps = Number(candidate.trending?.swaps ?? 0);
  const rugRatio = Number(candidate.trending?.rug_ratio ?? 0);
  const bundlerRate = Number(candidate.trending?.bundler_rate ?? 0);
  const hotLevel = Number(candidate.metrics.trendingHotLevel ?? 0);
  const smartDegenCount = Number(candidate.metrics.trendingSmartDegenCount ?? 0);

  // Fee claim check
  if (candidate.feeClaim) {
    const minFee = strat.min_fee_claim_sol ?? 0.5;
    if (minFee > 0 && feeSol < minFee) {
      failures.push(`fee claim: ${feeSol} SOL < min ${minFee} SOL`);
    }
    // Stale fee claims are already priced in by fast wallets — skip them
    if (strat.fee_claim_max_age_ms > 0) {
      const feeAge = Date.now() - (candidate.feeClaim.receivedAtMs || candidate.createdAtMs || 0);
      if (feeAge > strat.fee_claim_max_age_ms) {
        failures.push(`fee claim age: ${Math.round(feeAge/60000)}min > max ${Math.round(strat.fee_claim_max_age_ms/60000)}min (priced in)`);
      }
    }
  } else if (strat.require_fee_claim) {
    failures.push('fee claim: missing (required by strategy)');
  }

  // Market cap checks
  if (strat.min_mcap_usd > 0 && (!Number.isFinite(mcap) || mcap < strat.min_mcap_usd)) {
    failures.push(`market cap min: ${mcap} < ${strat.min_mcap_usd}`);
  }
  if (strat.max_mcap_usd > 0 && Number.isFinite(mcap) && mcap > strat.max_mcap_usd) {
    failures.push(`market cap max: ${mcap} > ${strat.max_mcap_usd}`);
  }

  // GMGN fees — only enforce when GMGN data is available; Jupiter has no equivalent
  if (strat.min_gmgn_total_fee_sol > 0 && candidate.gmgn !== null && totalFees < strat.min_gmgn_total_fee_sol) {
    failures.push(`GMGN total fees: ${totalFees} < ${strat.min_gmgn_total_fee_sol}`);
  }

  // Graduated volume — only enforce when the token actually has graduated data
  if (strat.min_graduated_volume_usd > 0 && candidate.graduation && gradVolume < strat.min_graduated_volume_usd) {
    failures.push(`graduated volume: ${gradVolume} < ${strat.min_graduated_volume_usd}`);
  }

  // Liquidity check — ensures exits are viable
  if (strat.min_liquidity_usd > 0 && liquidityUsd < strat.min_liquidity_usd) {
    failures.push(`liquidity: $${liquidityUsd.toFixed(0)} < min $${strat.min_liquidity_usd}`);
  }

  // Holder count
  if (strat.min_holders > 0 && holderCount < strat.min_holders) {
    failures.push(`holders: ${holderCount} < ${strat.min_holders}`);
  }

  // Top holder concentration
  if (strat.max_top20_holder_percent < 100 && Number.isFinite(maxHolder) && maxHolder > strat.max_top20_holder_percent) {
    failures.push(`max top holder: ${maxHolder}% > ${strat.max_top20_holder_percent}%`);
  }

  // Pre-buy safety audit (Jupiter audit data) — the dominant real risk is rugs that gap
  // through the stop-loss, so reject obvious rug setups BEFORE buying. Each check is only
  // enforced when the underlying audit field is actually present (defensive against missing data).
  const audit = candidate.audit || {};
  if (strat.require_mint_revoked && audit.mintAuthorityDisabled === false) {
    failures.push('audit: mint authority not revoked');
  }
  if (strat.require_freeze_revoked && audit.freezeAuthorityDisabled === false) {
    failures.push('audit: freeze authority not revoked');
  }
  if (strat.max_dev_holder_percent > 0 && Number.isFinite(audit.devBalancePercent) && audit.devBalancePercent > strat.max_dev_holder_percent) {
    failures.push(`audit: dev holds ${audit.devBalancePercent.toFixed(1)}% > max ${strat.max_dev_holder_percent}%`);
  }
  // LP burn — unburned LP lets the dev drain the pool at will; strongest rug predictor
  if (strat.min_lp_burned_percent > 0 && Number.isFinite(audit.lpBurnedPercent) && audit.lpBurnedPercent < strat.min_lp_burned_percent) {
    failures.push(`audit: LP burned ${audit.lpBurnedPercent.toFixed(0)}% < min ${strat.min_lp_burned_percent}%`);
  }

  // Saved wallet holders
  if (strat.min_saved_wallet_holders > 0 && savedCount < strat.min_saved_wallet_holders) {
    failures.push(`saved wallet holders: ${savedCount} < ${strat.min_saved_wallet_holders}`);
  }

  // ATH distance — minimum dip required (e.g. max_ath_distance_pct: -5 = must be ≥5% below ATH)
  if (strat.max_ath_distance_pct < 0) {
    const athDist = candidate.chart?.distanceFromAthPercent;
    if (athDist != null && athDist > strat.max_ath_distance_pct) {
      failures.push(`ATH distance: ${athDist.toFixed(0)}% > target ${strat.max_ath_distance_pct}% (not dipped enough yet)`);
    }
  }

  // ATH distance ceiling — cap how deep the dip can be (e.g. min_ath_distance_pct: -20 = must be ≤20% below ATH)
  if (strat.min_ath_distance_pct != null && Number(strat.min_ath_distance_pct) < 0) {
    const athDist = candidate.chart?.distanceFromAthPercent;
    if (athDist != null && athDist < Number(strat.min_ath_distance_pct)) {
      failures.push(`ATH distance too deep: ${athDist.toFixed(0)}% < floor ${strat.min_ath_distance_pct}% (token declining)`);
    }
  }

  // Trending filters
  if (candidate.trending) {
    if (strat.trending_min_volume_usd > 0 && trendingVolume < strat.trending_min_volume_usd) {
      failures.push(`trending volume: ${trendingVolume} < ${strat.trending_min_volume_usd}`);
    }
    if (strat.trending_min_swaps > 0 && trendingSwaps < strat.trending_min_swaps) {
      failures.push(`trending swaps: ${trendingSwaps} < ${strat.trending_min_swaps}`);
    }
    if (strat.trending_max_rug_ratio > 0 && Number.isFinite(rugRatio) && rugRatio > strat.trending_max_rug_ratio) {
      failures.push(`trending rug ratio: ${rugRatio} > ${strat.trending_max_rug_ratio}`);
    }
    if (strat.trending_max_bundler_rate > 0 && Number.isFinite(bundlerRate) && bundlerRate > strat.trending_max_bundler_rate) {
      failures.push(`trending bundler rate: ${bundlerRate} > ${strat.trending_max_bundler_rate}`);
    }
    if (candidate.trending.is_wash_trading === true || candidate.trending.is_wash_trading === 1) {
      failures.push('trending wash trading');
    }
    // Hot level — momentum strength signal (0=cold, 1=warm, 2=hot, 3=very hot)
    if (strat.min_hot_level > 0 && hotLevel < strat.min_hot_level) {
      failures.push(`hot level: ${hotLevel} < min ${strat.min_hot_level}`);
    }
    // Smart degen count — number of profitable wallets accumulating
    if (strat.min_smart_degen_count > 0 && smartDegenCount < strat.min_smart_degen_count) {
      failures.push(`smart degen count: ${smartDegenCount} < min ${strat.min_smart_degen_count}`);
    }
  }

  // El-Ponyin Layer 3: Volume integrity — organic swaps-per-holder ratio.
  // Wash-traded tokens inflate volume with a small cluster of coordinated wallets.
  // A healthy token has ≥1.5 swaps per unique holder (real community activity).
  if (strat.min_swaps_per_holder > 0) {
    const swapsPerHolder = trendingSwaps / Math.max(1, holderCount);
    if (swapsPerHolder < strat.min_swaps_per_holder) {
      failures.push(`volume integrity: ${swapsPerHolder.toFixed(1)} swaps/holder < min ${strat.min_swaps_per_holder} (possible wash trading)`);
    }
  }

  // El-Ponyin SIA composite score — 5-layer 0-100 score matching ponyin.id's "Should I Ape?" engine.
  // Each layer scores 0-20 pts; minimum sia_min_score required to proceed.
  if (strat.sia_min_score > 0) {
    const siaScore = computeSIAScore(candidate, strat);
    candidate.siaScore = siaScore;
    if (siaScore < strat.sia_min_score) {
      failures.push(`SIA score: ${siaScore}/100 < min ${strat.sia_min_score} (5-layer filter)`);
    }
  }

  return { passed: failures.length === 0, failures, strategy: strat.id };
}

// Ponyin.id "Should I Ape?" — composite on-chain score across 5 layers (0-100).
// Layer 1 (Contract Security): mint/freeze revoked, LP burned, dev holdings.
// Layer 2 (Bundle Integrity): bundler rate, top holder concentration.
// Layer 3 (Volume Integrity): organic swap density, rug ratio.
// Layer 4 (Marketing Timing): fee claim freshness.
// Layer 5 (Dip Confirmation): price distance from recent ATH.
function computeSIAScore(candidate, strat) {
  const audit = candidate.audit || {};
  let score = 0;

  // Layer 1: Contract Security (0-20 pts)
  if (audit.mintAuthorityDisabled !== false) score += 5;
  if (audit.freezeAuthorityDisabled !== false) score += 5;
  const lpBurned = Number(audit.lpBurnedPercent ?? 0);
  if (lpBurned >= 90) score += 7;
  else if (lpBurned >= 80) score += 4;
  else if (lpBurned >= 50) score += 2;
  const devPct = Number(audit.devBalancePercent ?? 0);
  if (devPct <= 2) score += 3;
  else if (devPct <= 5) score += 1;

  // Layer 2: Bundle Integrity (0-20 pts)
  const bundlerRate = Number(candidate.trending?.bundler_rate ?? 1);
  if (bundlerRate <= 0.10) score += 20;
  else if (bundlerRate <= 0.20) score += 14;
  else if (bundlerRate <= 0.35) score += 7;
  else if (bundlerRate <= 0.45) score += 3;

  // Layer 3: Volume Integrity (0-20 pts)
  const holderCount = Number(candidate.metrics.holderCount || 1);
  const trendingSwaps = Number(candidate.trending?.swaps ?? 0);
  const swapsPerHolder = trendingSwaps / Math.max(1, holderCount);
  if (swapsPerHolder >= 3)  score += 10;
  else if (swapsPerHolder >= 1.5) score += 6;
  else if (swapsPerHolder >= 0.5) score += 2;
  const rugRatio = Number(candidate.trending?.rug_ratio ?? 1);
  if (rugRatio <= 0.10) score += 10;
  else if (rugRatio <= 0.20) score += 6;
  else if (rugRatio <= 0.30) score += 2;

  // Layer 4: Marketing Timing (0-20 pts) — fee claim freshness
  const feeAgeMins = candidate.feeClaim
    ? (Date.now() - (candidate.feeClaim.receivedAtMs || Date.now())) / 60000
    : 999;
  if (feeAgeMins <= 3)  score += 20;
  else if (feeAgeMins <= 7)  score += 14;
  else if (feeAgeMins <= 10) score += 8;
  else if (feeAgeMins <= 15) score += 3;

  // Layer 5: Dip Confirmation (0-20 pts) — sweet spot 5-15% below recent ATH
  const athDist = Number(candidate.chart?.distanceFromAthPercent ?? 0);
  if (athDist >= -15 && athDist <= -5)  score += 20; // ideal dip zone
  else if (athDist >= -20 && athDist < -5)  score += 12; // deeper dip, still ok
  else if (athDist > -5 && athDist >= -2)   score += 5;  // near ATH, less ideal entry
  else if (athDist < -20)                   score += 2;  // too deep — may be declining

  return Math.min(100, score);
}

export async function buildCandidate({ mint, fee = null, signature = null, graduatedCoin = null, trendingToken = null, route }) {
  const strat = activeStrategy();

  // Fetch all independent external sources in parallel — reduces entry latency ~60%
  const [gmgn, jupiterAsset, holders, chart] = await Promise.all([
    fetchGmgnTokenInfo(mint),
    fetchJupiterAsset(mint),
    fetchJupiterHolders(mint),
    fetchJupiterChartContext(mint),
  ]);
  // Second wave: depends on first-wave results
  const [savedWalletExposure, twitterNarrative] = await Promise.all([
    fetchSavedWalletExposure(mint, holders),
    fetchTwitterNarrative(graduatedCoin || jupiterAsset, gmgn),
  ]);
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), jupiterAsset?.usdPrice, trendingToken?.price);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    jupiterAsset?.mcap,
    jupiterAsset?.fdv,
    trendingToken?.market_cap,
    graduatedCoin?.marketCap,
    graduatedCoin?.usd_market_cap,
  );
  const signalRoute = route || [
    fee ? 'fee' : null,
    graduatedCoin ? 'graduated' : null,
    trendingToken ? 'trending' : null,
  ].filter(Boolean).join('_');

  const candidate = {
    token: {
      mint,
      name: gmgn?.name || jupiterAsset?.name || trendingToken?.name || graduatedCoin?.name || '',
      symbol: gmgn?.symbol || jupiterAsset?.symbol || trendingToken?.symbol || graduatedCoin?.ticker || '',
      gmgnUrl: gmgn?.link?.gmgn || gmgnLink(mint),
      twitter: graduatedCoin?.twitter || jupiterAsset?.twitter || gmgn?.link?.twitter_username || trendingToken?.twitter || '',
      website: graduatedCoin?.website || jupiterAsset?.website || gmgn?.link?.website || '',
      telegram: graduatedCoin?.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? jupiterAsset?.liquidity ?? trendingToken?.liquidity ?? 0),
      holderCount: Number(gmgn?.holder_count ?? jupiterAsset?.holderCount ?? trendingToken?.holder_count ?? graduatedCoin?.numHolders ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? jupiterAsset?.fees ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? 0),
      graduatedVolumeUsd: Number(graduatedCoin?.volume ?? 0),
      graduatedMarketCapUsd: Number(graduatedCoin?.marketCap ?? 0),
      trendingVolumeUsd: Number(trendingToken?.volume ?? 0),
      trendingSwaps: Number(trendingToken?.swaps ?? 0),
      trendingHotLevel: Number(trendingToken?.hot_level ?? 0),
      trendingSmartDegenCount: Number(trendingToken?.smart_degen_count ?? 0),
    },
    signals: {
      route: signalRoute,
      label: signalLabel({
        hasFeeClaim: Boolean(fee),
        hasGraduated: Boolean(graduatedCoin),
        hasTrending: Boolean(trendingToken),
      }),
      hasFeeClaim: Boolean(fee),
      hasGraduated: Boolean(graduatedCoin),
      hasTrending: Boolean(trendingToken),
      triggerSignature: signature,
      strategy: strat.id,
    },
    graduation: graduatedCoin,
    trending: trendingToken,
    feeClaim: fee ? buildFeeSnapshot(fee, signature) : null,
    // Safety audit fields surfaced from Jupiter asset data for pre-buy rug gating.
    // null = unknown (not enforced); false/number = known value the filter can act on.
    audit: {
      mintAuthorityDisabled: jupiterAsset?.audit?.mintAuthorityDisabled ?? null,
      freezeAuthorityDisabled: jupiterAsset?.audit?.freezeAuthorityDisabled ?? null,
      topHoldersPercent: Number.isFinite(Number(jupiterAsset?.audit?.topHoldersPercentage)) ? Number(jupiterAsset.audit.topHoldersPercentage) : null,
      devBalancePercent: Number.isFinite(Number(jupiterAsset?.audit?.devBalancePercentage)) ? Number(jupiterAsset.audit.devBalancePercentage) : null,
      lpBurnedPercent: Number.isFinite(Number(jupiterAsset?.audit?.lpBurnedPercentage)) ? Number(jupiterAsset.audit.lpBurnedPercentage) : null,
    },
    gmgn,
    jupiterAsset,
    holders,
    chart,
    savedWalletExposure,
    twitterNarrative,
    createdAtMs: now(),
  };

  // Composite momentum score — used to rank candidates before LLM review.
  // Higher = stronger opportunity quality and timing.
  const _feeSol = candidate.feeClaim?.distributedSol || 0;
  const _holders = candidate.metrics.holderCount || 0;
  const _swaps = candidate.metrics.trendingSwaps || 0;
  const _is3Way = candidate.signals.hasFeeClaim && candidate.signals.hasGraduated && candidate.signals.hasTrending;
  candidate.momentumScore = (
    Math.log10(Math.max(1, _feeSol * 100)) *
    Math.sqrt(Math.max(1, _holders)) *
    Math.min(1, _swaps / 100 + 0.1) *
    (_is3Way ? 1.5 : 1.0)
  );

  candidate.filters = filterCandidate(candidate);
  return candidate;
}
