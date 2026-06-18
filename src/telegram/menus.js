import { escapeHtml, fmtPct, fmtSol, fmtUsd, short } from '../format.js';
import { numSetting, boolSetting, setting, activeStrategy, allStrategies } from '../db/settings.js';
import { openPositionCount, tradingMode, allPositions, getRecapStats } from '../db/positions.js';
import { savedWallets } from '../enrichment/wallets.js';
import { gmgnStatusText } from '../enrichment/gmgn.js';
import { formatPosition } from './format.js';
import { ENABLE_LLM, LLM_API_KEY } from '../config.js';

export function menuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Strategy', callback_data: 'menu:strategy' },
          { text: 'Agent', callback_data: 'menu:agent' },
          { text: 'Filters', callback_data: 'menu:filters' },
        ],
        [
          { text: 'Wallets', callback_data: 'menu:wallets' },
          { text: 'Positions', callback_data: 'menu:positions' },
          { text: 'PnL', callback_data: 'menu:pnl' },
        ],
        [
          { text: '📊 Recap', callback_data: 'menu:recap' },
          { text: '🩺 Health', callback_data: 'menu:health' },
        ],
      ],
    },
  };
}

export function recapText() {
  const { allTime, last24h, openPositions: open } = getRecapStats();
  const strat = activeStrategy();

  function fmtStats(s, label) {
    if (s.closed === 0 && s.open === 0) return `${label}\nNo trades yet.`;
    const winRateLine = s.closed > 0
      ? `Win rate: <b>${s.winRate.toFixed(1)}%</b> (${s.wins}W / ${s.losses}L)`
      : 'Win rate: —';
    const avgLine = s.closed > 0 ? `Avg PnL: <b>${s.avgPnlPct >= 0 ? '+' : ''}${s.avgPnlPct.toFixed(1)}%</b> per trade` : '';
    const totalLine = s.closed > 0
      ? `Total: <b>${s.totalPnlPct >= 0 ? '+' : ''}${s.totalPnlPct.toFixed(1)}%</b> · <b>${s.totalPnlSol >= 0 ? '+' : ''}${s.totalPnlSol.toFixed(4)} SOL</b>`
      : '';
    return [label, `Trades: ${s.closed} closed, ${s.open} open`, winRateLine, avgLine, totalLine].filter(Boolean).join('\n');
  }

  function fmtReasons(byReason, total) {
    if (!total) return '';
    const order = ['SL', 'TRAILING_TP', 'TP', 'PARTIAL_TP', 'PARTIAL_TP2', 'MAX_HOLD', 'MANUAL', 'TIME_EXIT', 'UNKNOWN'];
    const parts = order
      .filter(k => byReason[k] > 0)
      .map(k => `${k}: ${(byReason[k] / total * 100).toFixed(0)}%`);
    return parts.join(' | ');
  }

  const bestLines = allTime.best.length
    ? allTime.best.map((p, i) => {
        const pnl = Number(p.pnl_percent || 0);
        const icon = pnl > 0 ? '🟢' : '🔴';
        return `${icon} ${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}% ${escapeHtml(p.symbol || p.mint?.slice(0, 6) || '?')} (${p.exit_reason || '?'})`;
      })
    : ['—'];

  const reasonsLine = fmtReasons(allTime.byReason, allTime.closed);
  const openLine = open.length
    ? open.map(p => `• ${escapeHtml(p.symbol || p.mint?.slice(0, 6))} #${p.id}`).join('\n')
    : 'None';

  return [
    '📊 <b>Dry-run Recap</b>',
    '',
    fmtStats(allTime, '── All Time ──'),
    '',
    fmtStats(last24h, '── Last 24h ──'),
    '',
    `── Open Positions ──\n${openLine}`,
    '',
    `── Best Trades (All Time) ──\n${bestLines.join('\n')}`,
    '',
    reasonsLine ? `── Exit Reasons ──\n${reasonsLine}` : null,
    '',
    `Strategy: <b>${escapeHtml(strat.name)}</b>`,
  ].filter(v => v !== null).join('\n');
}

export function recapKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Positions', callback_data: 'menu:positions' },
          { text: 'Refresh', callback_data: 'menu:recap' },
        ],
        [{ text: 'Back', callback_data: 'menu:main' }],
      ],
    },
  };
}

export function filtersText() {
  const strat = activeStrategy();
  return [
    `⚙️ <b>Charon Filters</b> (${escapeHtml(strat.name)})`,
    `Min claim fee: ${fmtSol(strat.min_fee_claim_sol)} SOL`,
    `Min mcap: ${fmtUsd(strat.min_mcap_usd)}`,
    `Max mcap: ${strat.max_mcap_usd > 0 ? fmtUsd(strat.max_mcap_usd) : 'off'}`,
    `Min trading fees: ${fmtSol(strat.min_gmgn_total_fee_sol)} SOL`,
    `Min grad volume: ${fmtUsd(strat.min_graduated_volume_usd)}`,
    `Min holders: ${strat.min_holders || 'off'}`,
    `Max holder: ${strat.max_top20_holder_percent < 100 ? fmtPct(strat.max_top20_holder_percent) : 'off'}`,
    `Min saved holders: ${strat.min_saved_wallet_holders || 'off'}`,
    strat.max_ath_distance_pct < 0 ? `Max ATH distance: ${strat.max_ath_distance_pct}%` : null,
    '',
    `Min sources: ${strat.min_source_count}`,
    `Fee required: ${strat.require_fee_claim ? 'yes' : 'no'}`,
    '',
    `Trending: <b>${boolSetting('trending_enabled', true) ? 'on' : 'off'}</b> · Source: <b>${escapeHtml(setting('trending_source', 'jupiter'))}</b>`,
    `GMGN status: token-info ${escapeHtml(gmgnStatusText('token'))} · trending ${escapeHtml(gmgnStatusText('trending'))}`,
    `Trending interval: ${escapeHtml(setting('trending_interval', '5m'))} · Limit: ${numSetting('trending_limit', 100)}`,
    `Min trend volume: ${fmtUsd(strat.trending_min_volume_usd)} · Min swaps: ${strat.trending_min_swaps}`,
    `Max trend rug: ${fmtPct(strat.trending_max_rug_ratio * 100)} · Max bundler: ${fmtPct(strat.trending_max_bundler_rate * 100)}`,
  ].filter(Boolean).join('\n');
}

export const numericFilterLabels = {
  min_fee_claim_sol: 'minimum creator fee-claim SOL',
  min_mcap_usd: 'minimum mcap USD',
  max_mcap_usd: 'maximum mcap USD',
  min_gmgn_total_fee_sol: 'minimum total trading fees SOL (GMGN)',
  min_graduated_volume_usd: 'minimum graduated volume USD',
  max_top20_holder_percent: 'maximum holder percent',
  min_saved_wallet_holders: 'minimum saved-wallet holders',
  trending_limit: 'trending result limit',
  trending_min_volume_usd: 'minimum trending volume USD',
  trending_min_swaps: 'minimum trending swaps',
  trending_max_rug_ratio: 'maximum trending rug ratio (0.3 = 30%)',
  trending_max_bundler_rate: 'maximum trending bundler rate (0.5 = 50%)',
};

export const strategyNumericLabels = {
  min_fee_claim_sol: 'minimum creator fee-claim SOL',
  min_mcap_usd: 'minimum mcap USD',
  max_mcap_usd: 'maximum mcap USD',
  min_gmgn_total_fee_sol: 'minimum total trading fees SOL (GMGN)',
  min_graduated_volume_usd: 'minimum graduated volume USD',
  min_holders: 'minimum holders',
  max_top20_holder_percent: 'maximum top holder percent',
  min_saved_wallet_holders: 'minimum saved-wallet holders',
  max_ath_distance_pct: 'maximum ATH distance percent (-40 = 40% below ATH, 0 = off)',
  min_source_count: 'minimum source count',
  token_age_max_ms: 'maximum token age milliseconds',
  trending_min_volume_usd: 'minimum trending volume USD',
  trending_min_swaps: 'minimum trending swaps',
  trending_max_rug_ratio: 'maximum trending rug ratio (0.3 = 30%)',
  trending_max_bundler_rate: 'maximum trending bundler rate (0.5 = 50%)',
  llm_min_confidence: 'LLM minimum confidence percent',
  position_size_sol: 'position size SOL',
  max_open_positions: 'maximum open positions',
  tp_percent: 'take profit percent',
  sl_percent: 'stop loss percent',
  trailing_percent: 'trailing percent',
  partial_tp_at_percent: 'partial TP trigger percent',
  partial_tp_sell_percent: 'partial TP sell percent',
  max_hold_ms: 'maximum hold milliseconds',
};

export function filtersKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Configure in Strategy', callback_data: 'menu:strategy' }],
        [
          { text: 'Trend On/Off', callback_data: 'toggle:trending_enabled' },
          { text: 'Use Jupiter', callback_data: 'set:trending_source:jupiter' },
          { text: 'Use GMGN', callback_data: 'set:trending_source:gmgn' },
        ],
        [
          { text: 'Trend 5m', callback_data: 'set:trending_interval:5m' },
          { text: 'Trend 1h', callback_data: 'set:trending_interval:1h' },
          { text: 'Trend 6h', callback_data: 'set:trending_interval:6h' },
        ],
        [{ text: 'Back', callback_data: 'menu:main' }],
      ],
    },
  };
}

export function agentText() {
  const strat = activeStrategy();
  return [
    '🛶 <b>Charon Agent</b>',
    `Strategy: <b>${escapeHtml(strat.name)}</b>`,
    `Agent: <b>${boolSetting('agent_enabled', true) ? 'on' : 'off'}</b>`,
    `Mode: <b>${escapeHtml(tradingMode())}</b>`,
    `LLM: <b>${strat.use_llm && ENABLE_LLM && LLM_API_KEY ? 'configured' : 'disabled'}</b>`,
    `Confidence: ${fmtPct(strat.llm_min_confidence || numSetting('llm_min_confidence', 75))}`,
    `Open positions: ${openPositionCount()}/${strat.max_open_positions || 'unlimited'}`,
    `Batch candidates: ${numSetting('llm_candidate_pick_count', 10)}`,
    `Candidate freshness: ${Math.round(numSetting('llm_candidate_max_age_ms', 600000) / 1000)}s`,
    `Size: ${fmtSol(strat.position_size_sol)} SOL`,
    `TP/SL: ${fmtPct(strat.tp_percent)} / ${fmtPct(strat.sl_percent)}`,
    `Trailing: ${strat.trailing_enabled ? fmtPct(strat.trailing_percent) : 'off'}`,
    `Circuit breaker: <b>${boolSetting('circuit_breaker_enabled', true) ? 'on' : 'off'}</b> (daily loss limit ${fmtSol(numSetting('daily_loss_limit_sol', 0.35))} SOL)`,
  ].join('\n');
}

export function agentKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Toggle Agent', callback_data: 'toggle:agent' }],
        [
          { text: 'Dry Run', callback_data: 'set:trading_mode:dry_run' },
          { text: 'Confirm', callback_data: 'set:trading_mode:confirm' },
          { text: 'Live', callback_data: 'set:trading_mode:live' },
        ],
        [
          { text: 'Max Pos 1', callback_data: 'set:max_open_positions:1' },
          { text: 'Max Pos 3', callback_data: 'set:max_open_positions:3' },
          { text: 'Max Pos 5', callback_data: 'set:max_open_positions:5' },
        ],
        [
          { text: 'Batch 5', callback_data: 'set:llm_candidate_pick_count:5' },
          { text: 'Batch 10', callback_data: 'set:llm_candidate_pick_count:10' },
        ],
        [
          { text: 'Fresh 5m', callback_data: 'set:llm_candidate_max_age_ms:300000' },
          { text: 'Fresh 10m', callback_data: 'set:llm_candidate_max_age_ms:600000' },
          { text: 'Fresh 20m', callback_data: 'set:llm_candidate_max_age_ms:1200000' },
        ],
        [{ text: `Circuit Breaker ${boolSetting('circuit_breaker_enabled', true) ? 'on' : 'off'}`, callback_data: 'toggle:circuit_breaker_enabled' }],
        [
          { text: 'Loss Limit 0.2', callback_data: 'set:daily_loss_limit_sol:0.2' },
          { text: '0.35', callback_data: 'set:daily_loss_limit_sol:0.35' },
          { text: '0.5', callback_data: 'set:daily_loss_limit_sol:0.5' },
          { text: '1.0', callback_data: 'set:daily_loss_limit_sol:1' },
        ],
        [{ text: 'Back', callback_data: 'menu:main' }],
      ],
    },
  };
}

export function navKeyboard(rows = []) {
  return {
    reply_markup: {
      inline_keyboard: [
        ...rows,
        [{ text: 'Back', callback_data: 'menu:main' }],
      ],
    },
  };
}

export function mainMenuText() {
  return `🛶 <b>Charon</b>\nDry-run trench agent online.`;
}

export function walletsText() {
  const rows = savedWallets();
  const body = rows.length
    ? rows.map(row => `• <b>${escapeHtml(row.label)}</b>: <code>${escapeHtml(row.address)}</code>`).join('\n')
    : 'No saved wallets. Use /walletadd &lt;label&gt; &lt;address&gt;';
  return `👛 <b>Saved Wallets</b>\n\n${body}`;
}

export function positionsText() {
  const rows = allPositions(12);
  const text = rows.length ? rows.map(formatPosition).join('\n\n') : 'No dry-run positions yet.';
  return `📍 <b>Positions</b>\n\n${text}`;
}

export function strategyMenuText() {
  const strat = activeStrategy();
  const all = allStrategies();
  const entryIcons = { immediate: '⚡', wait_for_dip: '📉', after_confirmation: '🧠' };
  return [
    '🎯 <b>Strategy</b>',
    '',
    `Active: <b>${escapeHtml(strat.name)}</b>`,
    `Entry: ${entryIcons[strat.entry_mode] || '?'} ${strat.entry_mode}`,
    `Min sources: ${strat.min_source_count}`,
    `Fee required: ${strat.require_fee_claim ? 'yes' : 'no'}`,
    `Size: ${fmtSol(strat.position_size_sol)} SOL`,
    `TP/SL: ${fmtPct(strat.tp_percent)} / ${fmtPct(strat.sl_percent)}`,
    `Trailing: ${strat.trailing_enabled ? fmtPct(strat.trailing_percent) : 'off'}`,
    `Max positions: ${strat.max_open_positions}`,
    strat.min_holders > 0 ? `Min holders: ${strat.min_holders}` : null,
    strat.max_ath_distance_pct < 0 ? `Max ATH distance: ${strat.max_ath_distance_pct}%` : null,
    strat.partial_tp ? `Partial TP: ${strat.partial_tp_sell_percent}% at ${fmtPct(strat.partial_tp_at_percent)}` : null,
    strat.max_hold_ms > 0 ? `Max hold: ${Math.round(strat.max_hold_ms / 60000)}m` : null,
    strat.use_llm ? `LLM: yes (min ${strat.llm_min_confidence}%)` : 'LLM: no (rule-based)',
    `Slippage — buy: ${strat.buy_slippage_bps ?? 300} bps (${((strat.buy_slippage_bps ?? 300) / 100).toFixed(1)}%) · sell: ${strat.sell_slippage_bps ?? 1000} bps (${((strat.sell_slippage_bps ?? 1000) / 100).toFixed(1)}%)`,
    strat.conviction_sizing ? `Conviction sizing: ${fmtSol(strat.position_size_min_sol)}–${fmtSol(strat.position_size_max_sol)} SOL by confidence` : null,
    (strat.require_mint_revoked || strat.require_freeze_revoked || strat.max_dev_holder_percent > 0)
      ? `Audit gate: ${[strat.require_mint_revoked ? 'mint-revoked' : null, strat.require_freeze_revoked ? 'freeze-revoked' : null, strat.max_dev_holder_percent > 0 ? `dev ≤${strat.max_dev_holder_percent}%` : null].filter(Boolean).join(', ')}`
      : null,
    '',
    ...all.map(s => `${s.enabled ? '▶' : '○'} ${s.name}`),
  ].filter(Boolean).join('\n');
}

export function strategyKeyboard() {
  const strat = activeStrategy();
  const all = allStrategies();
  const selector = all.map(s => [{
    text: `${s.enabled ? '▶ ' : ''}${s.name}`,
    callback_data: `strategy:select:${s.id}`,
  }]);
  const config = [
    [
      { text: `TP +${strat.tp_percent}%`, callback_data: 'stratinput:tp_percent' },
      { text: `SL ${strat.sl_percent}%`, callback_data: 'stratinput:sl_percent' },
    ],
    [
      { text: `Size ${strat.position_size_sol} SOL`, callback_data: 'stratinput:position_size_sol' },
      { text: `Max Pos ${strat.max_open_positions}`, callback_data: 'stratinput:max_open_positions' },
    ],
    [
      { text: `Min Mcap ${strat.min_mcap_usd > 0 ? fmtUsd(strat.min_mcap_usd) : 'off'}`, callback_data: 'stratinput:min_mcap_usd' },
      { text: `Max Mcap ${strat.max_mcap_usd > 0 ? fmtUsd(strat.max_mcap_usd) : 'off'}`, callback_data: 'stratinput:max_mcap_usd' },
    ],
    [
      { text: `Trail ${strat.trailing_enabled ? fmtPct(strat.trailing_percent) : 'off'}`, callback_data: 'stratinput:trailing_percent' },
      { text: `Min Src ${strat.min_source_count}`, callback_data: 'stratinput:min_source_count' },
    ],
    [
      { text: `Fee Req ${strat.require_fee_claim ? 'on' : 'off'}`, callback_data: 'stratcfg:require_fee_claim' },
      { text: `LLM ${strat.use_llm ? 'on' : 'off'}`, callback_data: 'stratcfg:use_llm' },
    ],
    [
      { text: `Min Holders ${strat.min_holders}`, callback_data: 'stratinput:min_holders' },
      { text: `Conf ${strat.llm_min_confidence}%`, callback_data: 'stratinput:llm_min_confidence' },
    ],
    [
      { text: `Partial TP ${strat.partial_tp ? 'on' : 'off'}`, callback_data: 'stratcfg:partial_tp' },
      { text: `Max Hold ${strat.max_hold_ms > 0 ? Math.round(strat.max_hold_ms/60000)+'m' : 'off'}`, callback_data: 'stratinput:max_hold_ms' },
    ],
    [
      { text: `Claim Fee ${fmtSol(strat.min_fee_claim_sol)} SOL`, callback_data: 'stratinput:min_fee_claim_sol' },
      { text: `Trading Fees ${fmtSol(strat.min_gmgn_total_fee_sol)} SOL`, callback_data: 'stratinput:min_gmgn_total_fee_sol' },
    ],
    [
      { text: `Grad Vol ${fmtUsd(strat.min_graduated_volume_usd)}`, callback_data: 'stratinput:min_graduated_volume_usd' },
      { text: `Max Holder ${strat.max_top20_holder_percent < 100 ? fmtPct(strat.max_top20_holder_percent) : 'off'}`, callback_data: 'stratinput:max_top20_holder_percent' },
    ],
    [
      { text: `Saved ${strat.min_saved_wallet_holders || 'off'}`, callback_data: 'stratinput:min_saved_wallet_holders' },
      { text: `ATH ${strat.max_ath_distance_pct < 0 ? `${strat.max_ath_distance_pct}%` : 'off'}`, callback_data: 'stratinput:max_ath_distance_pct' },
    ],
    [
      { text: `Age ${strat.token_age_max_ms > 0 ? Math.round(strat.token_age_max_ms / 60000) + 'm' : 'off'}`, callback_data: 'stratinput:token_age_max_ms' },
      { text: `Trend Vol ${fmtUsd(strat.trending_min_volume_usd)}`, callback_data: 'stratinput:trending_min_volume_usd' },
    ],
    [
      { text: `Trend Swaps ${strat.trending_min_swaps}`, callback_data: 'stratinput:trending_min_swaps' },
      { text: `Max Rug ${fmtPct(strat.trending_max_rug_ratio * 100)}`, callback_data: 'stratinput:trending_max_rug_ratio' },
    ],
    [
      { text: `Max Bundler ${fmtPct(strat.trending_max_bundler_rate * 100)}`, callback_data: 'stratinput:trending_max_bundler_rate' },
      { text: `Partial Sell ${strat.partial_tp_sell_percent}%`, callback_data: 'stratinput:partial_tp_sell_percent' },
    ],
    [
      { text: `Partial At ${strat.partial_tp_at_percent}%`, callback_data: 'stratinput:partial_tp_at_percent' },
    ],
    [
      { text: `Buy Slip ${strat.buy_slippage_bps ?? 300}bps`, callback_data: 'stratcfg:buy_slippage_bps' },
      { text: `Sell Slip ${strat.sell_slippage_bps ?? 1000}bps`, callback_data: 'stratcfg:sell_slippage_bps' },
    ],
    [
      { text: `Conviction ${strat.conviction_sizing ? 'on' : 'off'}`, callback_data: 'stratcfg:conviction_sizing' },
      { text: `Dev Max ${strat.max_dev_holder_percent > 0 ? strat.max_dev_holder_percent + '%' : 'off'}`, callback_data: 'stratcfg:max_dev_holder_percent' },
    ],
    [
      { text: `Size Min ${fmtSol(strat.position_size_min_sol ?? strat.position_size_sol)}`, callback_data: 'stratcfg:position_size_min_sol' },
      { text: `Size Max ${fmtSol(strat.position_size_max_sol ?? strat.position_size_sol)}`, callback_data: 'stratcfg:position_size_max_sol' },
    ],
    [
      { text: `Mint Rev ${strat.require_mint_revoked ? 'on' : 'off'}`, callback_data: 'stratcfg:require_mint_revoked' },
      { text: `Freeze Rev ${strat.require_freeze_revoked ? 'on' : 'off'}`, callback_data: 'stratcfg:require_freeze_revoked' },
    ],
  ];
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '── Select Strategy ──', callback_data: 'noop' }],
        ...selector,
        [{ text: '── Configure ──', callback_data: 'noop' }],
        ...config,
        [{ text: 'Back', callback_data: 'menu:main' }],
      ],
    },
  };
}

export function candidateButtons(candidateId, decision = null) {
  const verdict = String(decision?.verdict || '').toUpperCase();
  if (verdict && verdict !== 'BUY') {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: `Skipped: ${verdict}`, callback_data: 'noop' }],
          [
            { text: 'View Candidate', callback_data: `cand:${candidateId}` },
            { text: 'Ignore', callback_data: `ign:${candidateId}` },
          ],
          [{ text: 'Positions', callback_data: 'menu:positions' }],
        ],
      },
    };
  }
  if (verdict === 'BUY') {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Positions', callback_data: 'menu:positions' },
            { text: 'Dry Buy', callback_data: `buy:${candidateId}` },
          ],
          [{ text: 'Ignore', callback_data: `ign:${candidateId}` }],
        ],
      },
    };
  }
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'View Candidate', callback_data: `cand:${candidateId}` },
          { text: 'Dry Buy', callback_data: `buy:${candidateId}` },
        ],
        [
          { text: 'Set TP/SL', callback_data: `tpsl:c:${candidateId}` },
          { text: 'Ignore', callback_data: `ign:${candidateId}` },
        ],
        [{ text: 'Positions', callback_data: 'menu:positions' }],
      ],
    },
  };
}

export function batchRevealButtons(batchId, rows, decision, triggerCandidateId = null) {
  const selectedId = Number(decision.selected_candidate_id || 0);
  const triggerId = Number(triggerCandidateId || 0);
  const keyboard = [];
  if (selectedId) keyboard.push([{ text: 'Reveal Pick', callback_data: `cand:${selectedId}` }]);
  keyboard.push([{ text: 'Reveal Batch', callback_data: `batch:${batchId}` }]);
  if (triggerId && triggerId !== selectedId) keyboard.push([{ text: 'Reveal Trigger', callback_data: `cand:${triggerId}` }]);
  keyboard.push([{ text: 'Positions', callback_data: 'menu:positions' }]);
  return { reply_markup: { inline_keyboard: keyboard } };
}

export function positionButtons(positionId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Dry Sell', callback_data: `sell:${positionId}` },
          { text: 'Refresh', callback_data: `pos:${positionId}` },
        ],
        [
          { text: 'TP +25%', callback_data: `tp:${positionId}:25` },
          { text: 'TP +50%', callback_data: `tp:${positionId}:50` },
        ],
        [
          { text: 'SL -15%', callback_data: `sl:${positionId}:-15` },
          { text: 'SL -25%', callback_data: `sl:${positionId}:-25` },
        ],
        [{ text: 'Trail On/Off', callback_data: `trail:${positionId}` }],
      ],
    },
  };
}

export function intentButtons(intentId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Confirm Buy', callback_data: `intent:${intentId}:confirm` },
          { text: 'Reject', callback_data: `intent:${intentId}:reject` },
        ],
        [{ text: 'Positions', callback_data: 'menu:positions' }],
      ],
    },
  };
}

export async function sendTpSlDefaults(chatId, query = null) {
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Default TP +25%', callback_data: 'set:default_tp_percent:25' },
          { text: 'Default TP +50%', callback_data: 'set:default_tp_percent:50' },
        ],
        [
          { text: 'Default SL -15%', callback_data: 'set:default_sl_percent:-15' },
          { text: 'Default SL -25%', callback_data: 'set:default_sl_percent:-25' },
        ],
        [
          { text: 'Trail On', callback_data: 'set:default_trailing_enabled:true' },
          { text: 'Trail Off', callback_data: 'set:default_trailing_enabled:false' },
        ],
        [{ text: 'Back', callback_data: 'menu:main' }],
      ],
    },
  };
  if (query) return editMenuMessage(query, agentText(), keyboard);
  const { bot } = await import('./bot.js');
  await bot.sendMessage(chatId, agentText(), { parse_mode: 'HTML', ...keyboard });
}

async function editMenuMessage(query, text, extra = {}) {
  const { TELEGRAM_CHAT_ID } = await import('../config.js');
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  const messageId = query.message?.message_id;
  const { bot } = await import('./bot.js');
  if (!messageId) {
    return bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (err) {
    if (/message is not modified/i.test(err.message)) return null;
    return bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }
}
