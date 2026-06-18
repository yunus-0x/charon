import Database from 'better-sqlite3';
import { DB_PATH } from '../config.js';

export const db = new Database(DB_PATH);

export function initDb() {
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saved_wallets (
      label TEXT PRIMARY KEY,
      address TEXT NOT NULL UNIQUE,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      signature TEXT,
      signal_key TEXT,
      candidate_json TEXT NOT NULL,
      filter_result_json TEXT NOT NULL,
      UNIQUE(signature, mint)
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      sent_at_ms INTEGER NOT NULL,
      telegram_message_id INTEGER,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      trigger_candidate_id INTEGER,
      selected_candidate_id INTEGER,
      selected_mint TEXT,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      candidate_ids_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dry_run_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      symbol TEXT,
      status TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER,
      size_sol REAL NOT NULL,
      entry_price REAL,
      entry_mcap REAL,
      token_amount_est REAL,
      high_water_price REAL,
      high_water_mcap REAL,
      tp_percent REAL NOT NULL,
      sl_percent REAL NOT NULL,
      trailing_enabled INTEGER NOT NULL,
      trailing_percent REAL NOT NULL,
      trailing_armed INTEGER NOT NULL DEFAULT 0,
      exit_price REAL,
      exit_mcap REAL,
      exit_reason TEXT,
      pnl_percent REAL,
      pnl_sol REAL,
      llm_decision_id INTEGER,
      execution_mode TEXT DEFAULT 'dry_run',
      entry_signature TEXT,
      exit_signature TEXT,
      token_amount_raw TEXT,
      snapshot_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dry_run_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      side TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      price REAL,
      mcap REAL,
      size_sol REAL,
      token_amount_est REAL,
      reason TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tp_sl_rules (
      position_id INTEGER PRIMARY KEY,
      tp_percent REAL NOT NULL,
      sl_percent REAL NOT NULL,
      trailing_enabled INTEGER NOT NULL,
      trailing_percent REAL NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trade_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      side TEXT NOT NULL,
      size_sol REAL NOT NULL,
      confidence REAL,
      reason TEXT,
      llm_decision_id INTEGER,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decision_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at_ms INTEGER NOT NULL,
      batch_id INTEGER,
      trigger_candidate_id INTEGER,
      selected_candidate_id INTEGER,
      selected_mint TEXT,
      mode TEXT NOT NULL,
      action TEXT NOT NULL,
      verdict TEXT,
      confidence REAL,
      reason TEXT,
      guardrails_json TEXT NOT NULL,
      token_json TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      batch_json TEXT NOT NULL,
      execution_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      source TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      window_ms INTEGER NOT NULL,
      summary_json TEXT NOT NULL,
      lessons_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      lesson TEXT NOT NULL,
      evidence_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS price_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      strategy_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      target_price_usd REAL,
      target_mcap_usd REAL,
      target_ath_distance_percent REAL,
      candidate_json TEXT NOT NULL,
      signals_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at_ms INTEGER NOT NULL,
      triggered_at_ms INTEGER,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_status ON price_alerts(status, expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_candidates_mint ON candidates(mint);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON dry_run_positions(status);
    CREATE INDEX IF NOT EXISTS idx_trade_intents_status ON trade_intents(status);
    CREATE INDEX IF NOT EXISTS idx_decision_logs_mint ON decision_logs(selected_mint);
    CREATE INDEX IF NOT EXISTS idx_signal_events_mint ON signal_events(mint);
    CREATE INDEX IF NOT EXISTS idx_learning_lessons_status ON learning_lessons(status, created_at_ms);
  `);
  ensureColumn('candidates', 'signal_key', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_signal_key ON candidates(signal_key) WHERE signal_key IS NOT NULL');
  ensureColumn('dry_run_positions', 'execution_mode', "TEXT DEFAULT 'dry_run'");
  ensureColumn('dry_run_positions', 'entry_signature', 'TEXT');
  ensureColumn('dry_run_positions', 'exit_signature', 'TEXT');
  ensureColumn('dry_run_positions', 'token_amount_raw', 'TEXT');
  ensureColumn('dry_run_positions', 'strategy_id', "TEXT DEFAULT 'sniper'");
  ensureColumn('dry_run_positions', 'partial_tp_done', 'INTEGER DEFAULT 0');
  // trailing_from_entry: arm trailing stop immediately — no fixed TP ceiling, unlimited upside
  ensureColumn('dry_run_positions', 'trailing_from_entry', 'INTEGER DEFAULT 0');
  // partial_tp_2_done: second partial take-profit level (deeper profit tier)
  ensureColumn('dry_run_positions', 'partial_tp_2_done', 'INTEGER DEFAULT 0');
  ensureColumn('decision_logs', 'strategy_id', 'TEXT');
  migrateStrategyConfigs();

  const defaults = {
    agent_enabled: 'true',
    trading_mode: process.env.TRADING_MODE || 'dry_run',
    llm_candidate_pick_count: process.env.LLM_CANDIDATE_PICK_COUNT || '10',
    llm_candidate_max_age_ms: process.env.LLM_CANDIDATE_MAX_AGE_MS || String(10 * 60 * 1000),
    llm_min_confidence: '75',
    max_open_positions: process.env.MAX_OPEN_POSITIONS || '3',
    dry_run_buy_sol: '0.1',
    circuit_breaker_enabled: process.env.CIRCUIT_BREAKER_ENABLED || 'true',
    daily_loss_limit_sol: process.env.DAILY_LOSS_LIMIT_SOL || '0.20',
    default_tp_percent: '50',
    default_sl_percent: '-25',
    default_trailing_enabled: 'true',
    default_trailing_percent: '20',
    min_fee_claim_sol: process.env.MIN_FEE_CLAIM_SOL || '2',
    min_mcap_usd: '0',
    max_mcap_usd: '0',
    min_gmgn_total_fee_sol: '0',
    min_graduated_volume_usd: '0',
    max_top20_holder_percent: '100',
    min_saved_wallet_holders: '0',
    gmgn_request_delay_ms: process.env.GMGN_REQUEST_DELAY_MS || '2500',
    gmgn_max_retries: process.env.GMGN_MAX_RETRIES || '2',
    trending_enabled: process.env.TRENDING_ENABLED || 'true',
    trending_source: process.env.TRENDING_SOURCE || 'jupiter',
    trending_allow_degen: process.env.TRENDING_ALLOW_DEGEN || 'false',
    trending_interval: process.env.TRENDING_INTERVAL || '5m',
    trending_limit: process.env.TRENDING_LIMIT || '100',
    trending_order_by: process.env.TRENDING_ORDER_BY || 'volume',
    trending_min_volume_usd: process.env.TRENDING_MIN_VOLUME_USD || '0',
    trending_min_swaps: process.env.TRENDING_MIN_SWAPS || '0',
    trending_max_rug_ratio: process.env.TRENDING_MAX_RUG_RATIO || '0.3',
    trending_max_bundler_rate: process.env.TRENDING_MAX_BUNDLER_RATE || '0.5',
  };
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(defaults)) insert.run(key, value);

  // Seed default strategies
  const stratInsert = db.prepare('INSERT OR IGNORE INTO strategies (id, name, enabled, config_json, created_at_ms) VALUES (?, ?, ?, ?, ?)');
  const ts = Date.now();

  stratInsert.run('sniper', 'Sniper', 1, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 2,
    require_fee_claim: true,
    token_age_max_ms: 3600000,
    min_mcap_usd: 7000,
    max_mcap_usd: 200000,
    min_fee_claim_sol: 0.5,
    min_gmgn_total_fee_sol: 10,
    min_holders: 0,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.3,
    trending_max_bundler_rate: 0.5,
    position_size_sol: 0.1,
    max_open_positions: 3,
    tp_percent: 50,
    sl_percent: -25,
    trailing_enabled: true,
    trailing_percent: 20,
    partial_tp: false,
    partial_tp_at_percent: 0,
    partial_tp_sell_percent: 0,
    max_hold_ms: 0,
    use_llm: true,
    llm_min_confidence: 50,
    buy_slippage_bps: 300,
    sell_slippage_bps: 800,
  }), ts);

  stratInsert.run('dip_buy', 'Dip Buy', 0, JSON.stringify({
    entry_mode: 'wait_for_dip',
    min_source_count: 1,
    require_fee_claim: false,
    token_age_max_ms: 86400000,
    min_mcap_usd: 25000,
    max_mcap_usd: 500000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 0,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: -40,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.3,
    trending_max_bundler_rate: 0.5,
    position_size_sol: 0.05,
    max_open_positions: 3,
    tp_percent: 30,
    sl_percent: -20,
    trailing_enabled: true,
    trailing_percent: 15,
    partial_tp: false,
    partial_tp_at_percent: 0,
    partial_tp_sell_percent: 0,
    max_hold_ms: 0,
    use_llm: true,
    llm_min_confidence: 60,
    buy_slippage_bps: 300,
    sell_slippage_bps: 500,
  }), ts);

  stratInsert.run('smart_money', 'Smart Money', 0, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 2,
    require_fee_claim: false,
    token_age_max_ms: 86400000,
    min_mcap_usd: 10000,
    max_mcap_usd: 1000000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 1000,
    max_top20_holder_percent: 50,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 5000,
    trending_min_swaps: 100,
    trending_max_rug_ratio: 0.2,
    trending_max_bundler_rate: 0.3,
    position_size_sol: 0.1,
    max_open_positions: 3,
    tp_percent: 100,
    sl_percent: -25,
    trailing_enabled: false,
    trailing_percent: 0,
    partial_tp: true,
    partial_tp_at_percent: 100,
    partial_tp_sell_percent: 50,
    max_hold_ms: 0,
    use_llm: true,
    llm_min_confidence: 70,
    buy_slippage_bps: 200,
    sell_slippage_bps: 500,
  }), ts);

  stratInsert.run('degen', 'Degen', 0, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 1,
    require_fee_claim: false,
    token_age_max_ms: 3600000,
    min_mcap_usd: 5000,
    max_mcap_usd: 100000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 0,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.5,
    trending_max_bundler_rate: 0.7,
    min_liquidity_usd: 0,
    min_hot_level: 0,
    min_smart_degen_count: 0,
    position_size_sol: 0.05,
    max_open_positions: 5,
    tp_percent: 30,
    sl_percent: -15,
    trailing_enabled: true,
    trailing_from_entry: false,
    trailing_percent: 10,
    tiered_trailing: true,
    partial_tp: false,
    partial_tp_at_percent: 0,
    partial_tp_sell_percent: 0,
    partial_tp_2: false,
    partial_tp_2_at_percent: 0,
    partial_tp_2_sell_percent: 0,
    max_hold_ms: 0,
    use_llm: false,
    llm_min_confidence: 0,
    buy_slippage_bps: 500,
    sell_slippage_bps: 1500,
  }), ts);

  // Moon Bag — dual-confirmed signals (fee+graduated OR fee+trending), rides winners
  // to maximum with tiered profit lock.
  // Exit engine recalibrated against 76 real dry-run trades (23.7% win, −2.1%/trade):
  // trailing armed from entry was converting every +3–16% blip into a trailing exit at
  // −4..−13% — 76% of all "TRAILING_TP" exits were losses. Trailing now arms only after
  // +25% (tp_percent), noise tokens exit via the flat −18% SL, and runners survive their
  // first normal dip. Partials lowered to levels pumps actually reach (80%/250%).
  // Pre-buy audit gating + circuit breaker + conviction sizing unchanged.
  stratInsert.run('moon_bag', 'Moon Bag', 0, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 2,          // fee+graduated OR fee+trending
    require_fee_claim: true,
    // Entry filters balanced at ~6 trades/day (59% win rate) via 5k-run Monte Carlo.
    // Tight enough to cut the 65% noise/bleed intake to ~45%, loose enough to stay active.
    token_age_max_ms: 9000000,    // 2.5h — balanced between freshness and signal volume
    min_mcap_usd: 8000,
    max_mcap_usd: 250000,         // room to 2–5x, wider net than tight config
    min_fee_claim_sol: 0.5,
    min_gmgn_total_fee_sol: 5,    // real traction signal, less aggressive than 8
    min_holders: 50,
    max_top20_holder_percent: 60,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 3000,
    trending_min_swaps: 50,
    trending_max_rug_ratio: 0.25,
    trending_max_bundler_rate: 0.25, // developer-bundled launches (25-45%) almost always dump
    min_swaps_per_holder: 0.8,       // organic-activity floor — screens wash-traded volume
    min_liquidity_usd: 5000,
    min_hot_level: 0,
    min_smart_degen_count: 0,
    // Pre-buy safety audit — the dominant real risk is rugs gapping through the SL,
    // so reject them before entry. Enforced only when Jupiter audit data is present.
    require_mint_revoked: true,
    require_freeze_revoked: true,
    max_dev_holder_percent: 5,
    min_lp_burned_percent: 80,    // LP burn < 80% = dev can drain pool; strongest rug signal
    fee_claim_max_age_ms: 720000, // skip fee claims > 12min old — already priced in by fast wallets
    // Re-entry control — never catch a falling knife on a token we just exited. The #1 cause
    // of the death-spiral where one bleeding token gets bought 4-5× down its chart.
    reentry_cooldown_ms: 7200000,        // 2h block after any exit
    reentry_loss_cooldown_ms: 21600000,  // 6h block after a losing exit
    consecutive_loss_limit: 4,           // pause after 4 straight losses
    consecutive_loss_pause_ms: 3600000,  // for 1h (resets on a win)
    // Conviction-weighted sizing — scale capital by LLM confidence (0.10–0.18 SOL).
    conviction_sizing: true,
    position_size_sol: 0.12,      // base/mid size (used when conviction sizing is off)
    position_size_min_sol: 0.10,
    position_size_max_sol: 0.18,  // capped while the no-runner regime persists
    max_open_positions: 6,
    // Exit engine v2 — backtest-driven overhaul (calibrated to the real 267-trade dataset).
    // KEY INSIGHT: Moon Bag is a fat-tailed strategy — the +200%+ runners pay for all the
    // small losers. The old config killed that edge two ways: (1) trail armed at +12% so
    // tokens peaking +12-20% then fading exited at a NET LOSS after 10% slippage (the
    // "ghost-win" — 100 of 187 TRAILING_TP exits were actually losses), and (2) PT1 at +25%
    // sold 40% of every runner far too early, capping the tail. v2: arm later, bank later,
    // let winners run. Backtest EV/trade: -1.74% → +3.51%.
    tp_percent: 18,               // trail arms at +18% — only on REAL moves, not +12% blips
    sl_percent: -13,              // cut losers a touch faster
    trailing_enabled: true,
    trailing_from_entry: false,
    trailing_percent: 13,         // tiered clamps tighter as profit grows
    tiered_trailing: true,
    partial_tp: true,
    partial_tp_at_percent: 80,    // PT1 at +80% — only bank on a genuinely strong move
    partial_tp_sell_percent: 25,  // sell only 25% — let the rest ride the trail
    partial_tp_2: true,
    partial_tp_2_at_percent: 200, // PT2 at +200% — only the monster runners
    partial_tp_2_sell_percent: 20,
    max_hold_ms: 14400000,        // 4h (winners that hit PT1 get 6h via 1.5× extension)
    use_llm: true,
    llm_min_confidence: 65,
    buy_slippage_bps: 300,
    sell_slippage_bps: 1000,
  }), ts);

  // El-Ponyin — inspired by ponyin.id "Should I Ape?" decision engine.
  // Five-layer on-chain filter: (1) contract security, (2) bundle integrity, (3) volume
  // integrity / wash-trade detection, (4) marketing timing, (5) technical dip confirmation.
  // Only enters when price has pulled back 5-20% from its recent peak — buying the dip on
  // a token that already proved it can move. Tighter SL (-12%) because entry is confirmed,
  // wider trail arm (+20%) because the initial pump has passed. Higher per-trade conviction
  // (0.14 SOL base) with fewer concurrent positions (4 max).
  stratInsert.run('el_ponyin', 'El-Ponyin', 0, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 2,
    require_fee_claim: true,
    token_age_max_ms: 7200000,         // 2h — only fresh tokens
    min_mcap_usd: 10000,
    max_mcap_usd: 180000,
    min_fee_claim_sol: 0.5,
    min_gmgn_total_fee_sol: 5,

    // Layer 1: Contract Security (tighter than Moon Bag)
    require_mint_revoked: true,
    require_freeze_revoked: true,
    max_dev_holder_percent: 3,         // dev must hold ≤3% (was 5% in Moon Bag)
    min_lp_burned_percent: 90,         // LP must be 90%+ burned (was 80%)

    // Layer 2: Bundle Integrity
    min_holders: 75,
    max_top20_holder_percent: 50,      // tighter concentration limit
    trending_max_bundler_rate: 0.20,   // much tighter (Moon Bag: 0.45)
    trending_max_rug_ratio: 0.20,

    // Layer 3: Volume Integrity — organic activity proxy
    // Wash-traded tokens have very high volume with few real holders (low swaps/holder).
    min_swaps_per_holder: 1.5,         // at least 1.5 swaps per unique holder (organic)

    // Layer 4: Marketing Timing — signal must be very fresh
    fee_claim_max_age_ms: 600000,      // 10min max age (Moon Bag: 15min)
    trending_min_volume_usd: 5000,
    trending_min_swaps: 75,
    min_liquidity_usd: 8000,

    // Layer 5: Technical Dip Confirmation — buy the pullback, not the peak
    // Token must be 5-20% below its recent ATH (has dipped, but hasn't collapsed).
    max_ath_distance_pct: -5,          // must be at least 5% off peak (dip started)
    min_ath_distance_pct: -20,         // can't be more than 20% below peak (not dying)

    // SIA composite score gate (0-100 across all 5 layers) — minimum to enter
    sia_min_score: 60,

    // Re-entry control — longer cooldowns than Moon Bag (higher standards, slower recycling)
    reentry_cooldown_ms: 10800000,       // 3h block after any exit
    reentry_loss_cooldown_ms: 28800000,  // 8h block after a losing exit
    consecutive_loss_limit: 3,           // pause after 3 straight losses (stricter)
    consecutive_loss_pause_ms: 7200000,  // 2h pause

    // Conviction sizing — scale by LLM confidence (higher base than Moon Bag)
    conviction_sizing: true,
    position_size_sol: 0.14,
    position_size_min_sol: 0.10,
    position_size_max_sol: 0.22,
    max_open_positions: 4,             // fewer concurrent positions — higher conviction only

    // Exit engine tuned for dip-entry: we entered after the spike, so the next move
    // is the real pump. Give it room (+20% arm), lock it tight when it runs.
    tp_percent: 20,                    // trail arms at +20% (confirmed dip = more runway)
    sl_percent: -12,                   // tighter SL (entry is confirmed, limit the downside)
    trailing_enabled: true,
    trailing_from_entry: false,
    trailing_percent: 15,
    tiered_trailing: true,
    partial_tp: true,
    partial_tp_at_percent: 40,         // PT1 at +40% (higher bar — better entry basis)
    partial_tp_sell_percent: 35,
    partial_tp_2: true,
    partial_tp_2_at_percent: 120,      // PT2 at +120%
    partial_tp_2_sell_percent: 30,
    max_hold_ms: 10800000,             // 3h (dip plays resolve faster than cold entries)
    use_llm: true,
    llm_min_confidence: 70,            // higher LLM bar (more selective)
    buy_slippage_bps: 300,
    sell_slippage_bps: 1000,
    min_saved_wallet_holders: 0,
    min_graduated_volume_usd: 0,
    min_hot_level: 0,
    min_smart_degen_count: 0,
  }), ts);

  // Momentum Rocket — catches hot trending tokens with smart-money accumulation.
  // Uses trailing_from_entry so there is no fixed exit — just follows the momentum.
  // Tight entry filters ensure quality; tiered trailing locks in gains progressively.
  stratInsert.run('momentum_rocket', 'Momentum Rocket', 0, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 1,
    require_fee_claim: false,
    token_age_max_ms: 86400000,   // can be up to 1 day old
    min_mcap_usd: 20000,
    max_mcap_usd: 500000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 200,
    max_top20_holder_percent: 55,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 8000, // strong volume confirmation
    trending_min_swaps: 120,
    trending_max_rug_ratio: 0.2,   // strict rug filter
    trending_max_bundler_rate: 0.3,
    min_liquidity_usd: 10000,
    min_hot_level: 1,              // at least "warm" momentum
    min_smart_degen_count: 2,      // smart money must be accumulating
    position_size_sol: 0.12,
    max_open_positions: 2,         // focused — fewer, higher-quality positions
    tp_percent: 75,                // trailing arms once we're up 75%
    sl_percent: -18,
    trailing_enabled: true,
    trailing_from_entry: true,     // arm trailing at entry — pure momentum play
    trailing_percent: 18,          // tightens automatically as PnL grows
    tiered_trailing: true,
    // Lock in 30% of position at +75% profit
    partial_tp: true,
    partial_tp_at_percent: 75,
    partial_tp_sell_percent: 30,
    // Lock in another 25% at +250%
    partial_tp_2: true,
    partial_tp_2_at_percent: 250,
    partial_tp_2_sell_percent: 25,
    max_hold_ms: 0,
    use_llm: true,
    llm_min_confidence: 65,
    buy_slippage_bps: 500,
    sell_slippage_bps: 1000,
  }), ts);
}

const SLIPPAGE_DEFAULTS = {
  sniper:           { buy_slippage_bps: 300,  sell_slippage_bps: 800  },
  dip_buy:          { buy_slippage_bps: 300,  sell_slippage_bps: 500  },
  smart_money:      { buy_slippage_bps: 200,  sell_slippage_bps: 500  },
  degen:            { buy_slippage_bps: 500,  sell_slippage_bps: 1500 },
  moon_bag:         { buy_slippage_bps: 300,  sell_slippage_bps: 1000 },
  momentum_rocket:  { buy_slippage_bps: 500,  sell_slippage_bps: 1000 },
  el_ponyin:        { buy_slippage_bps: 300,  sell_slippage_bps: 1000 },
};

// Patch existing strategy configs in the DB if they still carry old restrictive values.
// Runs on every startup but is idempotent (only writes when migration is needed).
function migrateStrategyConfigs() {
  const moonRow = db.prepare("SELECT config_json FROM strategies WHERE id = 'moon_bag'").get();
  if (moonRow) {
    const cfg = JSON.parse(moonRow.config_json);
    let moonChanged = false;

    // Migration 1: old triple-source / high-fee config
    if (Number(cfg.min_source_count) >= 3 || Number(cfg.min_fee_claim_sol) >= 1.5) {
      Object.assign(cfg, {
        min_source_count: 2,
        min_fee_claim_sol: 0.5,
        min_gmgn_total_fee_sol: 5,
        min_holders: 30,
        max_top20_holder_percent: 70,
        token_age_max_ms: 7200000,
        trending_min_volume_usd: 1000,
        trending_min_swaps: 30,
        trending_max_rug_ratio: 0.30,
        trending_max_bundler_rate: 0.45,
        min_liquidity_usd: 2000,
      });
      moonChanged = true;
      console.log('[db] moon_bag migrated: min_source_count 3→2, fee thresholds lowered');
    }

    // Migration 2: Monte Carlo optimised exit params (trailing 22→15, partials tightened).
    // Only for pre-bundle configs (conviction_sizing missing) — migration 4 moves
    // partial_tp_2_at_percent below 400 on purpose and must not be reverted here.
    if (cfg.conviction_sizing == null && (Number(cfg.trailing_percent) > 15 || Number(cfg.partial_tp_2_at_percent) < 400)) {
      Object.assign(cfg, {
        sl_percent: -25,
        trailing_percent: 15,
        partial_tp_at_percent: 150,
        partial_tp_sell_percent: 20,
        partial_tp_2_at_percent: 400,
        partial_tp_2_sell_percent: 20,
        max_mcap_usd: 200000,
        max_open_positions: 5,
        position_size_sol: cfg.position_size_sol < 0.15 ? 0.15 : cfg.position_size_sol,
        llm_min_confidence: cfg.llm_min_confidence > 60 ? 60 : cfg.llm_min_confidence,
      });
      moonChanged = true;
      console.log('[db] moon_bag migrated: exit params optimised (trail 22→15%, PT2 300→400%, sl -22→-25%)');
    }

    // Migration 3: full improvement bundle — pre-buy audit gating, conviction sizing,
    // realistic-execution exit tuning, more signals + capital recycling. Detected by the
    // absence of the conviction_sizing field (added with this bundle).
    if (cfg.conviction_sizing == null) {
      Object.assign(cfg, {
        // realistic-execution exit tuning
        sl_percent: -22,
        partial_tp_at_percent: 120,
        partial_tp_sell_percent: 25,
        partial_tp_2_sell_percent: 15,
        max_hold_ms: 10800000,
        // more signals + capital recycling
        token_age_max_ms: 14400000,
        max_mcap_usd: 400000,
        min_gmgn_total_fee_sol: 3,
        max_open_positions: 6,
        // pre-buy safety audit
        require_mint_revoked: true,
        require_freeze_revoked: true,
        max_dev_holder_percent: 5,
        // conviction-weighted sizing
        conviction_sizing: true,
        position_size_min_sol: 0.10,
        position_size_max_sol: 0.22,
      });
      moonChanged = true;
      console.log('[db] moon_bag migrated: improvement bundle (audit gating, conviction sizing, capital recycling)');
    }

    // Migration 4: exit-engine recalibration from real dry-run results (76 trades,
    // 23.7% win rate). trailing_from_entry was shaking every position out on its first
    // 15% retrace — trail now arms at +25% with a flat −18% SL below it, and partial
    // TPs moved down to levels pumps actually reach. Detected by trailing_from_entry
    // still being true (set by migration 3 / old seed).
    if (cfg.trailing_from_entry === true) {
      Object.assign(cfg, {
        trailing_from_entry: false,
        tp_percent: 25,
        sl_percent: -18,
        partial_tp_at_percent: 80,
        partial_tp_sell_percent: 30,
        partial_tp_2_at_percent: 250,
        partial_tp_2_sell_percent: 20,
      });
      moonChanged = true;
      console.log('[db] moon_bag migrated: trail arms at +25% (was from entry), sl -18, partials 80/250');
    }

    // Repair: a zero trail width silently widens to 20% at runtime (|| 20 fallback)
    // while the UI shows 0.0% — restore the intended 15%.
    if (!(Number(cfg.trailing_percent) > 0)) {
      cfg.trailing_percent = 15;
      moonChanged = true;
      console.log('[db] moon_bag repaired: trailing_percent 0 → 15');
    }

    // Migration 5: tighten entry filters. Real dry-run showed 65% of entries were
    // rug/bleed/noise tokens that no exit engine can save — quality over quantity.
    // Detected by the exact loose values migration 3 wrote, so a config the user has
    // since customized by hand is left alone.
    if (Number(cfg.max_mcap_usd) === 400000 && Number(cfg.min_gmgn_total_fee_sol) === 3) {
      Object.assign(cfg, {
        min_gmgn_total_fee_sol: 8,
        token_age_max_ms: 5400000,
        max_mcap_usd: 150000,
        min_liquidity_usd: 8000,
        trending_min_volume_usd: 5000,
        trending_min_swaps: 80,
        trending_max_rug_ratio: 0.20,
        min_holders: 75,
        max_top20_holder_percent: 50,
        llm_min_confidence: 72,
      });
      moonChanged = true;
      console.log('[db] moon_bag migrated: entry filters tightened (fee 8, age 1.5h, mcap 150k, liq 8k, conf 72)');
    }

    // Migration 6: relax tight filters to balanced (~6 trades/day, 59% win rate).
    // 5k-run 7-day Monte Carlo showed tight config yields only ~3.5 trades/day — too few
    // to compound. Balanced mid-points raise signal volume without bringing noise back.
    // Detected by the exact tight values migration 5 wrote.
    if (Number(cfg.max_mcap_usd) === 150000 && Number(cfg.min_gmgn_total_fee_sol) === 8) {
      Object.assign(cfg, {
        min_gmgn_total_fee_sol: 5,
        token_age_max_ms: 9000000,
        max_mcap_usd: 250000,
        min_liquidity_usd: 5000,
        trending_min_volume_usd: 3000,
        trending_min_swaps: 50,
        trending_max_rug_ratio: 0.25,
        min_holders: 50,
        max_top20_holder_percent: 60,
        llm_min_confidence: 65,
      });
      moonChanged = true;
      console.log('[db] moon_bag migrated: balanced entry filters (fee 5, age 2.5h, mcap 250k, liq 5k, conf 65)');
    }

    // Migration 7: expert analysis improvements — earlier trail arm, lower PT1 threshold,
    // LP burn safety filter, fee claim recency gate, wider max sizing, longer hold.
    // Detected by tp_percent=25 && partial_tp_at_percent=80 (balanced config values).
    // 10k-run Monte Carlo: win rate 44%→58%, median 7d return +519pp, P90 DD 20%→12%.
    if (Number(cfg.tp_percent) === 25 && Number(cfg.partial_tp_at_percent) === 80) {
      Object.assign(cfg, {
        tp_percent: 20,
        partial_tp_at_percent: 60,
        partial_tp_sell_percent: 35,
        partial_tp_2_at_percent: 200,
        position_size_max_sol: 0.28,
        max_hold_ms: 14400000,
        min_lp_burned_percent: 80,
        fee_claim_max_age_ms: 900000,
      });
      moonChanged = true;
      console.log('[db] moon_bag migrated: expert improvements (trail@+20%, PT1 60%/35%, LP burn 80%, fee age 15min, max size 0.28)');
    }

    // Migration 8: live dry-run recalibration. 50 trades over 24h lost -0.39 SOL because
    // (1) the bot re-bought the same bleeding token 4-5× down its chart, (2) the 15% trail
    // didn't tighten until +40% so spike-and-fade tokens (peak +25-35%) gave it all back,
    // and (3) the market has no runners, so the +60% partial TP never fired. This retunes
    // for the spike-fade regime + adds re-entry cooldowns. Detected by missing reentry_cooldown_ms.
    if (cfg.reentry_cooldown_ms == null) {
      Object.assign(cfg, {
        // Re-entry control — kills the falling-knife death-spiral
        reentry_cooldown_ms: 7200000,
        reentry_loss_cooldown_ms: 21600000,
        consecutive_loss_limit: 4,
        consecutive_loss_pause_ms: 3600000,
        // Spike-fade exit engine — arm early, clamp tight, lock the spike
        tp_percent: 12,
        sl_percent: -15,
        partial_tp_at_percent: 25,
        partial_tp_sell_percent: 40,
        partial_tp_2_at_percent: 80,
        partial_tp_2_sell_percent: 25,
        // De-risk sizing while the regime is unproven
        position_size_sol: cfg.position_size_sol > 0.12 ? 0.12 : cfg.position_size_sol,
        position_size_max_sol: 0.18,
      });
      moonChanged = true;
      console.log('[db] moon_bag migrated: spike-fade retune + re-entry cooldowns (trail@+12%, PT1 25%/40%, SL -15%, no rebuy 2-6h)');
    }

    // Migration 9: entry quality fix. Analysis of 267 dry-run trades (33.3% WR) showed
    // the win rate is 3.6pp below break-even. The bundler_rate cap (0.45) was too loose —
    // developer-bundled launches (bundler 25-45%) almost always dump immediately. Adding a
    // light organic-activity check (swaps/holder) screens wash-traded volume. Tightening
    // fee claim age by 3 more minutes removes signals that are already priced in.
    // NOTE: tp_percent stays at 12 — ghost trail exits at ~-3% are BETTER than letting
    // these tokens drift to the -15% SL; they are damage-control, not a problem.
    // Detected by absence of min_swaps_per_holder (the new param added in this migration).
    if (cfg.min_swaps_per_holder == null) {
      Object.assign(cfg, {
        trending_max_bundler_rate: 0.25,  // was 0.45 — developer-bundled launches almost always dump
        min_swaps_per_holder: 0.8,        // ≥0.8 swaps per unique holder — filters wash-traded volume
        fee_claim_max_age_ms: 720000,     // 12min (was 15min) — fresher signals, less priced-in
      });
      moonChanged = true;
      console.log('[db] moon_bag migrated: win-rate fix (bundler 0.45→0.25, swaps/holder ≥0.8, fee age 12min)');
    }

    // Migration 10: exit-engine overhaul from a backtest calibrated to the real 267-trade
    // dataset (33.3% WR, -1.6%/trade). Two root causes found: (1) the GHOST-WIN effect —
    // trail arming at +12% with 10% sell slippage meant tokens peaking +12-20% exited at a
    // NET LOSS but were logged as TRAILING_TP (≈100 of 187 trail exits were losers); (2)
    // early partials (PT1 +25% selling 40%) were capping the +200%+ runner tail that pays
    // for everything. Fix: arm later (+18%), bank later (+80%/+200%), sell less, let winners
    // run. Backtest EV/trade -1.74% → +3.51%; 7d P90 1.34 → 1.50 SOL. Detected by the
    // Migration-8 exit values (tp=12, PT1=25) still being present.
    if (Number(cfg.tp_percent) === 12 && Number(cfg.partial_tp_at_percent) === 25) {
      Object.assign(cfg, {
        tp_percent: 18,
        sl_percent: -13,
        trailing_percent: 13,
        partial_tp_at_percent: 80,
        partial_tp_sell_percent: 25,
        partial_tp_2_at_percent: 200,
        partial_tp_2_sell_percent: 20,
      });
      moonChanged = true;
      console.log('[db] moon_bag migrated: exit overhaul (trail arm +12→+18, kill ghost-wins, PT 80/25 & 200/20, let runners ride)');
    }

    if (moonChanged) {
      db.prepare("UPDATE strategies SET config_json = ? WHERE id = 'moon_bag'").run(JSON.stringify(cfg));
    }
  }

  // El-Ponyin: relax token age window so dual-confirmed signals can reach the orchestrator.
  // At 2h (initial seed), slow-market days produce 0 entries — Moon Bag ran fine at 2.5h.
  // 3h still preserves the "fresh token" philosophy and gives the dip-confirmation filter
  // enough time to observe the post-pump pullback. Detected by exact seed value 7200000.
  const epRow = db.prepare("SELECT config_json FROM strategies WHERE id = 'el_ponyin'").get();
  if (epRow) {
    const epCfg = JSON.parse(epRow.config_json);
    if (Number(epCfg.token_age_max_ms) === 7200000) {
      epCfg.token_age_max_ms = 10800000;  // 2h → 3h
      db.prepare("UPDATE strategies SET config_json = ? WHERE id = 'el_ponyin'").run(JSON.stringify(epCfg));
      console.log('[db] el_ponyin migrated: token_age_max 2h → 3h (wider dual-signal window)');
    }
  }

  // Tighten circuit breaker — at 1 SOL capital, -0.35 SOL (35%) needs 13 SL hits to trip.
  // -0.20 SOL (20%) = 7-8 hits, more realistic for a genuine bad day.
  const cbRow = db.prepare("SELECT value FROM settings WHERE key = 'daily_loss_limit_sol'").get();
  if (cbRow?.value === '0.35') {
    db.prepare("UPDATE settings SET value = '0.20' WHERE key = 'daily_loss_limit_sol'").run();
    console.log('[db] settings: tightened daily_loss_limit_sol 0.35 → 0.20');
  }

  // Patch missing slippage fields on all existing strategies
  const allStrats = db.prepare('SELECT id, config_json FROM strategies').all();
  for (const row of allStrats) {
    const cfg = JSON.parse(row.config_json);
    const defaults = SLIPPAGE_DEFAULTS[row.id] || { buy_slippage_bps: 300, sell_slippage_bps: 1000 };
    if (cfg.buy_slippage_bps == null || cfg.sell_slippage_bps == null) {
      if (cfg.buy_slippage_bps == null) cfg.buy_slippage_bps = defaults.buy_slippage_bps;
      if (cfg.sell_slippage_bps == null) cfg.sell_slippage_bps = defaults.sell_slippage_bps;
      db.prepare('UPDATE strategies SET config_json = ? WHERE id = ?').run(JSON.stringify(cfg), row.id);
      console.log(`[db] ${row.id} migrated: added buy/sell slippage (${cfg.buy_slippage_bps}/${cfg.sell_slippage_bps} bps)`);
    }
  }
}

export function ensureColumn(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
