/**
 * MEXC Zero-Fee Adaptive Grid Bot — SERVIDOR 100% DADOS REAIS (ZERO SIMULAÇÕES SINTÉTICAS)
 * - Mede Pings Reais (RTT ms) continuamente contra https://api.mexc.com/api/v3/time & bookTicker
 * - Executa ordens Paper Trading EXCLUSIVAMENTE quando o Orderbook Real (Bid/Ask) ou
 *   as Velas Reais (/api/v3/klines) da MEXC cruzam o preço da ordem Limit.
 */

const http = require("http");
const https = require("https");
const { performance } = require("perf_hooks");

const PORT = process.env.PORT || 8000;
const mexcAgent = new https.Agent({ keepAlive: true, maxSockets: 12 });

function requestMexc(path) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = https.get(
      {
        hostname: "api.mexc.com",
        path,
        agent: mexcAgent,
        timeout: 8000,
        headers: { "User-Agent": "MEXC-ZeroFee-Grid-Render24x7/3.0" },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          const latencyMs = Number((performance.now() - t0).toFixed(2));
          if (res.statusCode !== 200) {
            return reject(new Error(`MEXC HTTP ${res.statusCode}`));
          }
          try {
            resolve({ data: JSON.parse(raw), latencyMs });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
  });
}

function calcRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return 50.0;
  let gain = 0,
    loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (loss === 0) return 100.0;
  return Number((100 - 100 / (1 + gain / loss)).toFixed(2));
}

function calcATRPercent(klines, period = 14) {
  if (!klines || klines.length < period + 1) return 0.28;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const h = klines[i].high;
    const l = klines[i].low;
    const pc = klines[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const recent = trs.slice(-period);
  const atr = recent.reduce((a, b) => a + b, 0) / recent.length;
  const lastClose = klines[klines.length - 1].close;
  return lastClose > 0 ? Number(((atr / lastClose) * 100).toFixed(4)) : 0.28;
}

const state = {
  mode: "REAL_DATA_PAPER_ACCOUNT",
  symbol: (process.env.SYMBOL || "SOLUSDT").toUpperCase(),
  interval: "5m",
  is_running: true,
  started_at: new Date().toISOString(),
  telemetry: {
    last_ping_ms: 0,
    min_ping_ms: 9999,
    avg_ping_ms: 0,
    total_pings: 0,
    mexc_server_time: 0,
    mexc_server_iso: "",
    clock_offset_ms: 0,
    ping_history: [],
    candles_loaded: 0,
    window_start_iso: "",
    window_end_iso: "",
    window_volume_usdt: 0,
  },
  market: {
    last_price: 0,
    best_bid: 0,
    bid_qty: 0,
    best_ask: 0,
    ask_qty: 0,
    spread_bps: 0,
    rsi_14: 50.0,
    atr_pct: 0.28,
    regime: "CONECTANDO À MEXC...",
  },
  wallet: {
    initial_usdt: Number(process.env.INITIAL_USDT || 1000.0),
    usdt_free: 1000.0,
    usdt_locked: 0.0,
    coin_locked: 0.0,
    coin_value_usdt: 0.0,
    total_equity_usdt: 1000.0,
    realized_profit_usdt: 0.0,
    realized_pct: 0.0,
    unrealized_pnl_usdt: 0.0,
    total_roi_pct: 0.0,
    fees_saved_usdt: 0.0,
    cycles_completed: 0,
  },
  config: {
    grid_levels: 9,
    effective_spacing_pct: 0.42,
    take_profit_pct: 0.52,
    order_size_pct: 10.0,
  },
  open_orders: [],
  trade_history: [],
  klines: [],
  logs: [],
  _orderSeq: 1000,
};

function recordPing(ms, serverTime = null) {
  state.telemetry.last_ping_ms = ms;
  state.telemetry.total_pings += 1;
  if (ms < state.telemetry.min_ping_ms) state.telemetry.min_ping_ms = ms;
  state.telemetry.ping_history.push(ms);
  if (state.telemetry.ping_history.length > 30) state.telemetry.ping_history.shift();
  const sum = state.telemetry.ping_history.reduce((a, b) => a + b, 0);
  state.telemetry.avg_ping_ms = Number((sum / state.telemetry.ping_history.length).toFixed(2));
  if (serverTime) {
    state.telemetry.mexc_server_time = serverTime;
    state.telemetry.mexc_server_iso = new Date(serverTime).toISOString();
    state.telemetry.clock_offset_ms = serverTime - Date.now();
  }
}

function addLog(msg) {
  const ts = new Date().toISOString().slice(11, 19) + " UTC";
  state.logs.unshift(`[${ts}] ${msg}`);
  if (state.logs.length > 80) state.logs.pop();
}

function updateWalletTotals() {
  const p = state.market.last_price;
  if (p <= 0) return;
  state.wallet.coin_value_usdt = Number((state.wallet.coin_locked * p).toFixed(2));
  state.wallet.total_equity_usdt = Number(
    (state.wallet.usdt_free + state.wallet.usdt_locked + state.wallet.coin_value_usdt).toFixed(2)
  );
  state.wallet.total_roi_pct = Number(
    (((state.wallet.total_equity_usdt - state.wallet.initial_usdt) / state.wallet.initial_usdt) * 100).toFixed(2)
  );
  state.wallet.realized_pct = Number(
    ((state.wallet.realized_profit_usdt / state.wallet.initial_usdt) * 100).toFixed(2)
  );
  state.wallet.unrealized_pnl_usdt = Number(
    (state.wallet.total_equity_usdt - state.wallet.initial_usdt - state.wallet.realized_profit_usdt).toFixed(2)
  );
}

function deployRealGridAt(anchorPrice) {
  state.open_orders = [];
  const orderUsdt = state.wallet.initial_usdt * (state.config.order_size_pct / 100);
  const spacing = state.config.effective_spacing_pct / 100;
  state.wallet.usdt_free = state.wallet.initial_usdt + state.wallet.realized_profit_usdt;
  state.wallet.usdt_locked = 0;
  state.wallet.coin_locked = 0;

  for (let s = 1; s <= 3; s++) {
    if (state.wallet.usdt_free >= orderUsdt) {
      state.wallet.usdt_free -= orderUsdt;
      const qty = orderUsdt / anchorPrice;
      state.wallet.coin_locked += qty;
      const sellPrice = anchorPrice * (1 + spacing * s);
      state.open_orders.push({
        id: `MEXC-${++state._orderSeq}`,
        side: "SELL",
        price: Number(sellPrice.toFixed(6)),
        quantity: qty,
        notional_usdt: Number((sellPrice * qty).toFixed(2)),
        linked_buy_price: anchorPrice,
        expected_profit_usdt: Number(((sellPrice - anchorPrice) * qty).toFixed(2)),
      });
    }
  }

  for (let b = 1; b <= 6; b++) {
    if (state.wallet.usdt_free >= orderUsdt) {
      state.wallet.usdt_free -= orderUsdt;
      state.wallet.usdt_locked += orderUsdt;
      const buyPrice = anchorPrice * (1 - spacing * b);
      state.open_orders.push({
        id: `MEXC-${++state._orderSeq}`,
        side: "BUY",
        price: Number(buyPrice.toFixed(6)),
        quantity: orderUsdt / buyPrice,
        notional_usdt: Number(orderUsdt.toFixed(2)),
        linked_buy_price: buyPrice,
        expected_profit_usdt: 0,
      });
    }
  }

  state.open_orders.sort((a, b) => b.price - a.price);
  updateWalletTotals();
}

function processRealMarketCandleOrTick(lowPrice, highPrice, closePrice, timeStr, triggerSource = "MEXC_CANDLE") {
  state.market.last_price = closePrice;
  if (!state.is_running) return;
  const tpRatio = 1 + state.config.take_profit_pct / 100;
  const orderUsdt = state.wallet.initial_usdt * (state.config.order_size_pct / 100);
  const spawned = [];

  for (let i = state.open_orders.length - 1; i >= 0; i--) {
    const o = state.open_orders[i];
    if (o.side === "BUY" && lowPrice <= o.price) {
      state.open_orders.splice(i, 1);
      state.wallet.usdt_locked = Math.max(0, state.wallet.usdt_locked - o.notional_usdt);
      state.wallet.coin_locked += o.quantity;
      state.wallet.fees_saved_usdt = Number((state.wallet.fees_saved_usdt + o.notional_usdt * 0.001).toFixed(2));

      const sellPrice = o.price * tpRatio;
      spawned.push({
        id: `MEXC-${++state._orderSeq}`,
        side: "SELL",
        price: Number(sellPrice.toFixed(6)),
        quantity: o.quantity,
        notional_usdt: Number((sellPrice * o.quantity).toFixed(2)),
        linked_buy_price: o.price,
        expected_profit_usdt: Number(((sellPrice - o.price) * o.quantity).toFixed(2)),
      });

      state.trade_history.unshift({
        timestamp: timeStr,
        side: "BUY",
        price: o.price,
        real_candle_extreme: `Low Real: $${lowPrice.toFixed(4)}`,
        source: triggerSource,
        quote_qty: o.notional_usdt,
        realized_pnl_usdt: 0,
        realized_pnl_pct: 0,
      });
    } else if (o.side === "SELL" && highPrice >= o.price) {
      state.open_orders.splice(i, 1);
      state.wallet.coin_locked = Math.max(0, state.wallet.coin_locked - o.quantity);
      const proceeds = o.price * o.quantity;
      const entry = o.linked_buy_price || o.price / tpRatio;
      const netPnl = (o.price - entry) * o.quantity;
      const pnlPct = ((o.price - entry) / entry) * 100;

      state.wallet.usdt_free += proceeds;
      state.wallet.realized_profit_usdt = Number((state.wallet.realized_profit_usdt + netPnl).toFixed(2));
      state.wallet.fees_saved_usdt = Number((state.wallet.fees_saved_usdt + proceeds * 0.001).toFixed(2));
      state.wallet.cycles_completed += 1;

      if (state.wallet.usdt_free >= orderUsdt) {
        state.wallet.usdt_free -= orderUsdt;
        state.wallet.usdt_locked += orderUsdt;
        spawned.push({
          id: `MEXC-${++state._orderSeq}`,
          side: "BUY",
          price: Number(entry.toFixed(6)),
          quantity: orderUsdt / entry,
          notional_usdt: Number(orderUsdt.toFixed(2)),
          linked_buy_price: entry,
          expected_profit_usdt: 0,
        });
      }

      state.trade_history.unshift({
        timestamp: timeStr,
        side: "SELL",
        price: o.price,
        real_candle_extreme: `High Real: $${highPrice.toFixed(4)}`,
        source: triggerSource,
        quote_qty: Number(proceeds.toFixed(2)),
        realized_pnl_usdt: Number(netPnl.toFixed(2)),
        realized_pnl_pct: Number(pnlPct.toFixed(2)),
      });
    }
  }

  state.open_orders.push(...spawned);
  state.open_orders.sort((a, b) => b.price - a.price);
  if (state.trade_history.length > 80) state.trade_history.length = 80;
  updateWalletTotals();
}

async function audit500RealCandles(interval = "5m") {
  state.interval = interval;
  try {
    const timeRes = await requestMexc("/api/v3/time");
    recordPing(timeRes.latencyMs, timeRes.data.serverTime);

    const klineRes = await requestMexc(`/api/v3/klines?symbol=${state.symbol}&interval=${interval}&limit=500`);
    recordPing(klineRes.latencyMs);

    const raw = klineRes.data;
    if (!Array.isArray(raw) || raw.length < 30) return;

    state.klines = raw.map((r) => ({
      time: Math.floor(Number(r[0]) / 1000),
      openTimeMs: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      quoteVolume: Number(r[7]),
    }));

    state.telemetry.candles_loaded = state.klines.length;
    state.telemetry.window_start_iso = new Date(state.klines[0].openTimeMs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
    state.telemetry.window_end_iso =
      new Date(state.klines[state.klines.length - 1].openTimeMs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
    state.telemetry.window_volume_usdt = Math.round(state.klines.reduce((a, k) => a + k.quoteVolume, 0));

    const closes = state.klines.map((k) => k.close);
    state.market.rsi_14 = calcRSI(closes, 14);
    state.market.atr_pct = calcATRPercent(state.klines, 14);

    state.config.effective_spacing_pct = Number(
      Math.max(0.18, Math.min(state.market.atr_pct * 115, 0.45)).toFixed(3)
    );
    state.config.take_profit_pct = Number((state.config.effective_spacing_pct * 1.2).toFixed(3));

    state.wallet.realized_profit_usdt = 0;
    state.wallet.fees_saved_usdt = 0;
    state.wallet.cycles_completed = 0;
    state.trade_history = [];

    let anchor = state.klines[0].close;
    deployRealGridAt(anchor);

    for (let i = 1; i < state.klines.length; i++) {
      const k = state.klines[i];
      const ts = new Date(k.openTimeMs).toISOString().slice(5, 16).replace("T", " ");
      processRealMarketCandleOrTick(k.low, k.high, k.close, ts, `VELA REAL ${interval}`);
      if (Math.abs(k.close - anchor) / anchor > 0.018) {
        anchor = k.close;
        deployRealGridAt(anchor);
      }
    }

    addLog(
      `✅ Auditoria 100% Real Concluída: ${state.klines.length} velas (${interval}) de ${state.symbol} | Ping MEXC: ${state.telemetry.last_ping_ms} ms | Ciclos Reais: ${state.wallet.cycles_completed}`
    );
  } catch (err) {
    addLog(`❌ Erro na leitura da MEXC API: ${err.message}`);
  }
}

async function pollRealOrderbookAndPing() {
  if (!state.is_running) return;
  try {
    const { data: book, latencyMs } = await requestMexc(`/api/v3/ticker/bookTicker?symbol=${state.symbol}`);
    recordPing(latencyMs);

    if (book && book.bidPrice) {
      const bid = Number(book.bidPrice);
      const ask = Number(book.askPrice);
      const mid = (bid + ask) / 2;
      state.market.best_bid = bid;
      state.market.bid_qty = Number(book.bidQty);
      state.market.best_ask = ask;
      state.market.ask_qty = Number(book.askQty);
      state.market.spread_bps = Number((((ask - bid) / mid) * 10000).toFixed(2));
      state.market.regime =
        state.market.rsi_14 > 70
          ? "SOBRECOMPRA (RSI > 70)"
          : state.market.rsi_14 < 30
          ? "SOBREVENDA (RSI < 30)"
          : `ORDERBOOK REAL ATIVO (Spread ${state.market.spread_bps} bps)`;

      const nowStr = new Date().toISOString().slice(11, 19) + " UTC";
      processRealMarketCandleOrTick(ask, bid, mid, nowStr, "ORDERBOOK REAL AO VIVO");

      if (state.klines.length > 0) {
        const last = state.klines[state.klines.length - 1];
        last.close = mid;
        last.high = Math.max(last.high, bid);
        last.low = Math.min(last.low, ask);
      }
    }
  } catch (err) {}
}

audit500RealCandles("5m");
setInterval(pollRealOrderbookAndPing, 2500);

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (e) {
        resolve({});
      }
    });
  });
}

const HTML_DASHBOARD = `<!DOCTYPE html>
<html lang="pt-BR" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MEXC Spot v3 — Auditoria & Paper Trading 100% Dados Reais (Zero Simulações)</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { background-color: #060a12; color: #e2e8f0; font-family: 'Inter', system-ui, -apple-system, sans-serif; }
    .glass { background: rgba(15, 23, 42, 0.82); backdrop-filter: blur(12px); border: 1px solid rgba(51, 65, 85, 0.6); }
  </style>
</head>
<body class="min-h-screen p-4 md:p-6">
  <div class="max-w-7xl mx-auto space-y-5">
    <header class="glass rounded-2xl p-4 md:p-5 flex flex-wrap items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <div class="w-11 h-11 rounded-xl bg-emerald-500/10 border border-emerald-500/40 flex items-center justify-center text-2xl">📡</div>
        <div>
          <div class="flex flex-wrap items-center gap-2">
            <h1 class="text-lg md:text-xl font-bold text-white tracking-tight">MEXC Zero-Fee Grid — 100% Real Candles & Real Pings</h1>
            <span class="px-2.5 py-0.5 text-xs font-bold rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">ZERO DADOS SINTÉTICOS</span>
            <span id="ping-badge" class="px-2.5 py-0.5 text-xs font-mono font-bold rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/40">🏓 PING MEXC: -- ms</span>
          </div>
          <p class="text-xs text-slate-400 mt-0.5" id="window-subtitle">
            Conectado direto em <code>https://api.mexc.com/api/v3</code> • Todas as ordens só executam quando tocadas pelo Orderbook/Klines reais da MEXC
          </p>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <select id="select-symbol" onchange="changePair()" class="bg-slate-900 border border-slate-700 text-sm rounded-xl px-3 py-2 text-white font-semibold">
          <option value="SOLUSDT">SOL/USDT (MEXC Spot)</option>
          <option value="SUIUSDT">SUI/USDT (MEXC Spot)</option>
          <option value="BTCUSDT">BTC/USDT (MEXC Spot)</option>
          <option value="ETHUSDT">ETH/USDT (MEXC Spot)</option>
          <option value="XRPUSDT">XRP/USDT (MEXC Spot)</option>
          <option value="PEPEUSDT">PEPE/USDT (MEXC Spot)</option>
        </select>
        <button onclick="runRealAudit('1m')" class="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition">📊 500 Velas Reais (1m)</button>
        <button onclick="runRealAudit('5m')" class="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition">📊 500 Velas Reais (5m)</button>
        <button onclick="runRealAudit('15m')" class="px-3 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold transition">📊 500 Velas Reais (15m)</button>
        <button onclick="pingNow()" class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs font-bold text-amber-300">🏓 Testar Ping Real</button>
      </div>
    </header>

    <div class="glass rounded-2xl p-3.5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
      <div class="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
        <div class="text-slate-400">Latência Atual (RTT)</div>
        <div class="text-base font-bold font-mono text-cyan-400 mt-0.5" id="tel-ping">-- ms</div>
        <div class="text-[11px] text-slate-500" id="tel-ping-stats">Mín: -- ms | Méd: -- ms</div>
      </div>
      <div class="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
        <div class="text-slate-400">Melhor Compra (Best Bid)</div>
        <div class="text-base font-bold font-mono text-emerald-400 mt-0.5" id="tel-bid">$0.00</div>
        <div class="text-[11px] text-slate-500" id="tel-bid-qty">Volume na fila: --</div>
      </div>
      <div class="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
        <div class="text-slate-400">Melhor Venda (Best Ask)</div>
        <div class="text-base font-bold font-mono text-amber-400 mt-0.5" id="tel-ask">$0.00</div>
        <div class="text-[11px] text-slate-500" id="tel-ask-qty">Volume na fila: --</div>
      </div>
      <div class="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
        <div class="text-slate-400">Spread Real Orderbook</div>
        <div class="text-base font-bold font-mono text-white mt-0.5" id="tel-spread">-- bps</div>
        <div class="text-[11px] text-emerald-400">Taxa Maker MEXC: 0.00%</div>
      </div>
      <div class="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
        <div class="text-slate-400">Patrimônio (500 Velas Reais)</div>
        <div class="text-base font-bold font-mono text-white mt-0.5" id="kpi-equity">$1,000.00</div>
        <div class="text-[11px] text-emerald-400 font-bold" id="kpi-roi">+0.00%</div>
      </div>
      <div class="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
        <div class="text-slate-400">Lucro Realizado + Economia</div>
        <div class="text-base font-bold font-mono text-emerald-400 mt-0.5" id="kpi-realized">+$0.00</div>
        <div class="text-[11px] text-amber-300" id="kpi-fees-saved">Taxa Poupada: +$0.00</div>
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-5">
      <div class="lg:col-span-2 glass rounded-2xl p-4">
        <div class="flex items-center justify-between mb-3">
          <div>
            <h2 class="text-sm font-bold text-white" id="chart-title">📈 Histórico de Fechamento Real MEXC (/api/v3/klines) & Degraus da Grade</h2>
            <p class="text-xs text-slate-400" id="chart-subtitle">Carregando 500 velas oficiais da MEXC...</p>
          </div>
          <span class="text-xs font-mono text-cyan-300" id="kpi-rsi">RSI(14): -- | ATR: --%</span>
        </div>
        <div class="relative h-80 w-full"><canvas id="priceChart"></canvas></div>
      </div>

      <div class="glass rounded-2xl p-4 flex flex-col justify-between">
        <div>
          <h2 class="text-sm font-bold text-white mb-3">📋 Ordens Limit Abertas Aguardando Preço Real</h2>
          <div class="overflow-y-auto max-h-80">
            <table class="w-full text-left text-xs">
              <thead class="text-slate-400 border-b border-slate-800 sticky top-0 bg-slate-900">
                <tr><th class="py-1.5 px-2">Lado</th><th class="py-1.5 px-2">Preço Ordem</th><th class="py-1.5 px-2">Distância</th><th class="py-1.5 px-2">Alvo</th></tr>
              </thead>
              <tbody id="table-open-orders" class="divide-y divide-slate-800/60"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <div class="glass rounded-2xl p-4">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-sm font-bold text-white">🔍 Prova de Execução Auditada (Ordens Tocadas Exclusivamente por Velas Reais ou Orderbook Ao Vivo da MEXC)</h2>
        <span class="text-xs text-emerald-400 font-semibold" id="kpi-cycles">0 Ciclos Reais</span>
      </div>
      <div class="overflow-y-auto max-h-72">
        <table class="w-full text-left text-xs">
          <thead class="text-slate-400 border-b border-slate-800 sticky top-0 bg-slate-900">
            <tr>
              <th class="py-2 px-2">Data/Hora Vela Real (UTC)</th>
              <th class="py-2 px-2">Fonte do Gatilho</th>
              <th class="py-2 px-2">Operação</th>
              <th class="py-2 px-2">Preço Executado</th>
              <th class="py-2 px-2">Extremo Real da Vela MEXC</th>
              <th class="py-2 px-2">Lucro Líquido (0% Taxa)</th>
            </tr>
          </thead>
          <tbody id="table-trades" class="divide-y divide-slate-800/60"></tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    let chartInstance = null;
    function formatPrice(p) {
      if (!p) return "$0.00";
      if (p < 0.01) return "$" + p.toFixed(7);
      if (p < 10) return "$" + p.toFixed(4);
      return "$" + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    }
    function initChart() {
      const ctx = document.getElementById('priceChart').getContext('2d');
      chartInstance = new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [] },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '#64748b', maxTicksLimit: 10 }, grid: { color: 'rgba(51,65,85,0.2)' } },
            y: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(51,65,85,0.25)' } }
          }
        }
      });
    }
    function renderUI(state) {
      const w = state.wallet, m = state.market, t = state.telemetry;
      document.getElementById('select-symbol').value = state.symbol;
      document.getElementById('ping-badge').textContent = '🏓 PING MEXC: ' + t.last_ping_ms + ' ms (Total: ' + t.total_pings + ' pings)';
      document.getElementById('window-subtitle').textContent = 'Janela Real Auditada (' + state.interval + '): ' + t.window_start_iso + ' até ' + t.window_end_iso + ' • Volume Real MEXC na Janela: $' + (t.window_volume_usdt || 0).toLocaleString('en-US') + ' USDT';
      document.getElementById('tel-ping').textContent = t.last_ping_ms + ' ms';
      document.getElementById('tel-ping-stats').textContent = 'Mín: ' + t.min_ping_ms + ' ms | Méd: ' + t.avg_ping_ms + ' ms';
      document.getElementById('tel-bid').textContent = formatPrice(m.best_bid);
      document.getElementById('tel-bid-qty').textContent = 'Fila Bid: ' + m.bid_qty;
      document.getElementById('tel-ask').textContent = formatPrice(m.best_ask);
      document.getElementById('tel-ask-qty').textContent = 'Fila Ask: ' + m.ask_qty;
      document.getElementById('tel-spread').textContent = m.spread_bps + ' bps';

      document.getElementById('kpi-equity').textContent = '$' + w.total_equity_usdt.toFixed(2);
      document.getElementById('kpi-roi').textContent = (w.total_roi_pct >= 0 ? '+' : '') + w.total_roi_pct.toFixed(2) + '% Equity';
      document.getElementById('kpi-realized').textContent = '+$' + w.realized_profit_usdt.toFixed(2) + ' (+' + w.realized_pct.toFixed(2) + '%)';
      document.getElementById('kpi-fees-saved').textContent = 'Taxa Poupada: +$' + w.fees_saved_usdt.toFixed(2);
      document.getElementById('kpi-rsi').textContent = 'RSI(14): ' + m.rsi_14 + ' | ATR Real: ' + m.atr_pct + '%';
      document.getElementById('kpi-cycles').textContent = w.cycles_completed + ' Ciclos Compra+Venda Concluídos nas Velas Reais';
      document.getElementById('chart-subtitle').textContent = state.symbol + ' • Espaçamento Real: ' + state.config.effective_spacing_pct + '% | Take-Profit: +' + state.config.take_profit_pct + '%';

      document.getElementById('table-open-orders').innerHTML = state.open_orders.map(o => {
        const dist = m.last_price > 0 ? (((o.price - m.last_price) / m.last_price) * 100).toFixed(2) : '0.00';
        const isBuy = o.side === 'BUY';
        return '<tr class="hover:bg-slate-800/40">' +
          '<td class="py-1.5 px-2 font-bold ' + (isBuy ? 'text-emerald-400' : 'text-amber-400') + '">' + (isBuy ? '🟢 BUY' : '🎯 SELL') + '</td>' +
          '<td class="py-1.5 px-2 font-mono text-white">' + formatPrice(o.price) + '</td>' +
          '<td class="py-1.5 px-2 font-mono">' + (dist > 0 ? '+' : '') + dist + '%</td>' +
          '<td class="py-1.5 px-2 ' + (isBuy ? 'text-slate-400' : 'text-emerald-400 font-semibold') + '">' + (isBuy ? '$100' : '+$' + (o.expected_profit_usdt || 0).toFixed(2)) + '</td></tr>';
      }).join('');

      document.getElementById('table-trades').innerHTML = state.trade_history.map(tr => {
        const isSell = tr.side === 'SELL';
        return '<tr class="hover:bg-slate-800/40">' +
          '<td class="py-2 px-2 text-slate-300 font-mono">' + tr.timestamp + '</td>' +
          '<td class="py-2 px-2 text-cyan-300 font-mono">' + tr.source + '</td>' +
          '<td class="py-2 px-2 font-bold ' + (isSell ? 'text-amber-400' : 'text-emerald-400') + '">' + (isSell ? '💰 VENDA TP' : '🟢 COMPRA LIMIT') + '</td>' +
          '<td class="py-2 px-2 font-mono text-white">' + formatPrice(tr.price) + '</td>' +
          '<td class="py-2 px-2 font-mono text-slate-300">' + tr.real_candle_extreme + '</td>' +
          '<td class="py-2 px-2 font-bold ' + (isSell ? 'text-emerald-400' : 'text-slate-400') + '">' + (isSell ? '+$' + tr.realized_pnl_usdt.toFixed(2) + ' (+' + tr.realized_pnl_pct.toFixed(2) + '%)' : 'Taxa $0.00') + '</td></tr>';
      }).join('');

      if (chartInstance && state.klines && state.klines.length > 0) {
        const slice = state.klines.slice(-100);
        const labels = slice.map(k => new Date(k.time * 1000).toISOString().slice(11, 16));
        const prices = slice.map(k => k.close);
        const datasets = [{ label: 'Preço Real MEXC', data: prices, borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.08)', borderWidth: 2, pointRadius: 0, fill: true, tension: 0.15 }];
        state.open_orders.forEach(o => {
          datasets.push({
            label: o.side, data: Array(labels.length).fill(o.price),
            borderColor: o.side === 'BUY' ? 'rgba(16,185,129,0.5)' : 'rgba(251,191,36,0.6)',
            borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false
          });
        });
        chartInstance.data.labels = labels;
        chartInstance.data.datasets = datasets;
        chartInstance.update();
      }
    }
    async function fetchState() { const r = await fetch('/api/state'); renderUI(await r.json()); }
    async function runRealAudit(interval) {
      const r = await fetch('/api/audit-real', { method: 'POST', body: JSON.stringify({ interval }) });
      const d = await r.json();
      renderUI(d.state);
    }
    async function pingNow() {
      const r = await fetch('/api/ping-mexc', { method: 'POST' });
      const d = await r.json();
      renderUI(d.state);
    }
    async function changePair() {
      const symbol = document.getElementById('select-symbol').value;
      const r = await fetch('/api/audit-real', { method: 'POST', body: JSON.stringify({ symbol, interval: '5m' }) });
      const d = await r.json();
      renderUI(d.state);
    }
    window.addEventListener('DOMContentLoaded', () => { initChart(); fetchState(); setInterval(fetchState, 2500); });
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        status: "healthy",
        mode: "100%_REAL_MEXC_DATA",
        symbol: state.symbol,
        last_ping_ms: state.telemetry.last_ping_ms,
        avg_ping_ms: state.telemetry.avg_ping_ms,
        best_bid: state.market.best_bid,
        best_ask: state.market.best_ask,
        equity_usdt: state.wallet.total_equity_usdt,
        real_cycles_completed: state.wallet.cycles_completed,
      })
    );
  }
  if (req.url === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(state));
  }
  if (req.url === "/api/ping-mexc" && req.method === "POST") {
    const { data, latencyMs } = await requestMexc("/api/v3/time");
    recordPing(latencyMs, data.serverTime);
    await pollRealOrderbookAndPing();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ping_ms: latencyMs, state }));
  }
  if (req.url === "/api/audit-real" && req.method === "POST") {
    const body = await readBody(req);
    if (body.symbol) state.symbol = String(body.symbol).toUpperCase();
    await audit500RealCandles(body.interval || state.interval || "5m");
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, state }));
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(HTML_DASHBOARD);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`📡 Servidor MEXC 100% Real Data ativo na porta ${PORT}`);
});
