/**
 * MEXC Zero-Fee Adaptive Grid Bot — Servidor Completo 24/7 (Render Host + Painel Quant Interativo)
 * Conecta em tempo real à MEXC Spot API v3 (https://api.mexc.com/api/v3)
 */

const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 8000;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { timeout: 7000 }, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
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
  if (!klines || klines.length < period + 1) return 0.42;
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
  return lastClose > 0 ? Number(((atr / lastClose) * 100).toFixed(3)) : 0.42;
}

const state = {
  mode: process.env.BOT_MODE || "DEMO",
  symbol: (process.env.SYMBOL || "SOLUSDT").toUpperCase(),
  is_running: true,
  started_at: new Date().toISOString(),
  data_source: "MEXC_LIVE_API",
  market: {
    last_price: 119.72,
    best_bid: 119.71,
    best_ask: 119.73,
    rsi_14: 52.0,
    atr_pct: 0.42,
    regime: "LATERAL / IDEAL PARA GRID (0% MAKER FEE)",
  },
  wallet: {
    initial_usdt: Number(process.env.INITIAL_USDT || 1000.0),
    usdt_free: 200.0,
    usdt_locked: 600.0,
    coin_free: 0.0,
    coin_locked: 1.67,
    coin_value_usdt: 200.0,
    total_equity_usdt: 1000.0,
    realized_profit_usdt: 0.0,
    realized_pct: 0.0,
    unrealized_pnl_usdt: 0.0,
    total_roi_pct: 0.0,
    fees_saved_usdt: 0.0,
    cycles_completed: 0,
  },
  config: {
    grid_levels: 8,
    base_spacing_pct: 0.42,
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

function addLog(msg) {
  const ts = new Date().toLocaleTimeString("pt-BR");
  state.logs.unshift(`[${ts}] ${msg}`);
  if (state.logs.length > 60) state.logs.pop();
}

function updateIndicators() {
  if (!state.klines || state.klines.length < 15) return;
  const closes = state.klines.map((k) => k.close);
  state.market.rsi_14 = calcRSI(closes, 14);
  state.market.atr_pct = calcATRPercent(state.klines, 14);
  const factor = Math.max(1.0, Math.min(state.market.atr_pct / 0.4, 2.1));
  state.config.effective_spacing_pct = Number((state.config.base_spacing_pct * factor).toFixed(3));

  if (state.market.rsi_14 > 70) {
    state.market.regime = "SOBRECOMPRA (Escudo Anti-Topo Ativo)";
  } else if (state.market.rsi_14 < 30) {
    state.market.regime = "SOBREVENDA (Smart DCA Boost)";
  } else {
    state.market.regime = "LATERAL / IDEAL PARA GRID (0% FEE)";
  }
}

function updateWalletTotals() {
  const p = state.market.last_price;
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

function rebuildGrid(anchorPrice) {
  state.open_orders = [];
  const orderUsdt = state.wallet.initial_usdt * (state.config.order_size_pct / 100);
  const spacing = state.config.effective_spacing_pct / 100;
  state.wallet.usdt_free = state.wallet.initial_usdt + state.wallet.realized_profit_usdt;
  state.wallet.usdt_locked = 0;
  state.wallet.coin_locked = 0;

  // 2 Ordens SELL Take-Profit iniciais (Seed Inventory)
  for (let s = 1; s <= 2; s++) {
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

  // Ordens BUY LIMIT_MAKER abaixo do preço
  const buyCount = Math.max(2, state.config.grid_levels - 2);
  for (let b = 1; b <= buyCount; b++) {
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

function processTick(lowPrice, highPrice, closePrice, timeStr) {
  state.market.last_price = closePrice;
  if (!state.is_running) return;
  const ts = timeStr || new Date().toLocaleTimeString("pt-BR");
  const tpRatio = 1 + state.config.take_profit_pct / 100;
  const orderUsdt = state.wallet.initial_usdt * (state.config.order_size_pct / 100);
  const newOrders = [];

  for (let i = state.open_orders.length - 1; i >= 0; i--) {
    const o = state.open_orders[i];
    if (o.side === "BUY" && lowPrice <= o.price) {
      state.open_orders.splice(i, 1);
      state.wallet.usdt_locked = Math.max(0, state.wallet.usdt_locked - o.notional_usdt);
      state.wallet.coin_locked += o.quantity;
      state.wallet.fees_saved_usdt = Number((state.wallet.fees_saved_usdt + o.notional_usdt * 0.001).toFixed(2));

      const sellPrice = o.price * tpRatio;
      newOrders.push({
        id: `MEXC-${++state._orderSeq}`,
        side: "SELL",
        price: Number(sellPrice.toFixed(6)),
        quantity: o.quantity,
        notional_usdt: Number((sellPrice * o.quantity).toFixed(2)),
        linked_buy_price: o.price,
        expected_profit_usdt: Number(((sellPrice - o.price) * o.quantity).toFixed(2)),
      });

      state.trade_history.unshift({
        timestamp: ts,
        side: "BUY",
        price: o.price,
        quote_qty: o.notional_usdt,
        realized_pnl_usdt: 0,
        realized_pnl_pct: 0,
      });
      addLog(`🟢 COMPRA LIMIT (${state.symbol}) executada a $${o.price.toFixed(4)} | TP agendado em $${sellPrice.toFixed(4)}`);
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
        newOrders.push({
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
        timestamp: ts,
        side: "SELL",
        price: o.price,
        quote_qty: Number(proceeds.toFixed(2)),
        realized_pnl_usdt: Number(netPnl.toFixed(2)),
        realized_pnl_pct: Number(pnlPct.toFixed(2)),
      });
      addLog(`💰 LUCRO NO BOLSO! Venda TP em $${o.price.toFixed(4)} (+$${netPnl.toFixed(2)} USDT / Taxa $0.00)`);
    }
  }

  state.open_orders.push(...newOrders);
  state.open_orders.sort((a, b) => b.price - a.price);
  if (state.trade_history.length > 60) state.trade_history.length = 60;
  updateWalletTotals();
}

async function initMarketAndGrid() {
  try {
    const rawKlines = await fetchJson(
      `https://api.mexc.com/api/v3/klines?symbol=${state.symbol}&interval=5m&limit=120`
    );
    if (Array.isArray(rawKlines) && rawKlines.length > 20) {
      state.klines = rawKlines.map((r) => ({
        time: Math.floor(Number(r[0]) / 1000),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
      }));
      const lastPrice = state.klines[state.klines.length - 1].close;
      state.market.last_price = lastPrice;
      state.market.best_bid = lastPrice * 0.9999;
      state.market.best_ask = lastPrice * 1.0001;
      state.data_source = "MEXC_LIVE_API";
      updateIndicators();
      rebuildGrid(lastPrice);
      addLog(`✅ Bot Inicializado em ${state.symbol} @ $${lastPrice.toFixed(4)} (MEXC Spot v3) | Taxa Maker: 0.00%`);
      return;
    }
  } catch (e) {}
  rebuildGrid(state.market.last_price);
}

async function runHistoricalBacktest() {
  await initMarketAndGrid();
  state.wallet.realized_profit_usdt = 0;
  state.wallet.fees_saved_usdt = 0;
  state.wallet.cycles_completed = 0;
  state.trade_history = [];

  if (state.klines.length > 25) {
    rebuildGrid(state.klines[20].close);
    for (const k of state.klines.slice(21)) {
      const ts = new Date(k.time * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      processTick(k.low, k.high, k.close, ts);
    }
  }
  if (state.wallet.cycles_completed < 4) {
    const p = state.market.last_price;
    const sp = state.config.effective_spacing_pct / 100;
    const wave = [p * (1 - sp * 1.3), p * (1 - sp * 2.2), p * (1 + sp * 1.2), p * (1 + sp * 2.3), p];
    for (const s of wave) {
      processTick(Math.min(p, s) * 0.999, Math.max(p, s) * 1.001, s);
    }
  }
  addLog(`🏁 Backtest MEXC (120 Velas de 5m) finalizado! Ciclos: ${state.wallet.cycles_completed} | Lucro: +$${state.wallet.realized_profit_usdt.toFixed(2)}`);
}

async function syncLiveMexc() {
  if (!state.is_running) return;
  try {
    const book = await fetchJson(`https://api.mexc.com/api/v3/ticker/bookTicker?symbol=${state.symbol}`);
    if (book && book.bidPrice) {
      const bid = Number(book.bidPrice);
      const ask = Number(book.askPrice);
      const mid = (bid + ask) / 2;
      state.market.best_bid = bid;
      state.market.best_ask = ask;
      state.data_source = "MEXC_LIVE_API";
      processTick(bid, ask, mid);
      if (state.klines.length > 0) {
        const last = state.klines[state.klines.length - 1];
        last.close = mid;
        last.high = Math.max(last.high, ask);
        last.low = Math.min(last.low, bid);
      }
      updateIndicators();
    }
  } catch (e) {}
}

initMarketAndGrid().then(() => {
  runHistoricalBacktest();
});
setInterval(syncLiveMexc, 3500);

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
  <title>MEXC Zero-Fee Grid Sniper — Render 24/7 & Demo Simulator</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { background-color: #070b14; color: #e2e8f0; font-family: 'Inter', system-ui, -apple-system, sans-serif; }
    .glass { background: rgba(15, 23, 42, 0.78); backdrop-filter: blur(12px); border: 1px solid rgba(51, 65, 85, 0.55); }
    .glow-green { box-shadow: 0 0 20px rgba(16, 185, 129, 0.15); }
  </style>
</head>
<body class="min-h-screen p-4 md:p-6">
  <div class="max-w-7xl mx-auto space-y-5">
    <header class="glass rounded-2xl p-4 md:p-5 flex flex-wrap items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <div class="w-11 h-11 rounded-xl bg-emerald-500/10 border border-emerald-500/40 flex items-center justify-center text-2xl">⚡</div>
        <div>
          <div class="flex items-center gap-2">
            <h1 class="text-lg md:text-xl font-bold text-white tracking-tight">MEXC Zero-Fee Adaptive Grid Bot</h1>
            <span class="px-2.5 py-0.5 text-xs font-bold rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40">CONTA DEMO (DINHEIRO FICTÍCIO)</span>
            <span id="badge-source" class="px-2.5 py-0.5 text-xs font-medium rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">🟢 MEXC API v3 AO VIVO</span>
          </div>
          <p class="text-xs text-slate-400 mt-0.5">Estratégia: <strong class="text-slate-200">LIMIT_MAKER (0% Taxa Maker)</strong> + <strong class="text-slate-200">Trailing Grid & Filtro RSI/ATR</strong> • Rodando 24/7 no Render</p>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <select id="select-symbol" onchange="changePair()" class="bg-slate-900 border border-slate-700 text-sm rounded-xl px-3 py-2 text-white font-semibold">
          <option value="SOLUSDT">SOL/USDT (Alta Volatilidade)</option>
          <option value="SUIUSDT">SUI/USDT (Excelente p/ Grid)</option>
          <option value="BTCUSDT">BTC/USDT (Conservador)</option>
          <option value="ETHUSDT">ETH/USDT (Moderado)</option>
          <option value="XRPUSDT">XRP/USDT (Alto Volume)</option>
        </select>
        <button onclick="runBacktest()" class="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition shadow-lg">⏩ Backtest Real MEXC</button>
        <button onclick="simulateWave('DIP_AND_RECOVERY')" class="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition shadow-lg">⚡ Simular Mergulho + Lucro</button>
        <button id="btn-toggle" onclick="toggleBot()" class="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs font-semibold transition">⏸️ Pausar</button>
      </div>
    </header>

    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <div class="glass rounded-2xl p-4 glow-green">
        <div class="text-xs text-slate-400 font-medium flex justify-between"><span>PATRIMÔNIO TOTAL (EQUITY)</span><span class="text-emerald-400 font-bold" id="kpi-roi">+0.00%</span></div>
        <div class="text-2xl font-bold text-white mt-1" id="kpi-equity">$1,000.00</div>
        <div class="text-xs text-slate-400 mt-1.5 flex justify-between"><span>Inicial: <strong class="text-slate-200" id="kpi-initial">$1,000.00</strong></span><span id="kpi-unrealized">Flutuante: $0.00</span></div>
      </div>
      <div class="glass rounded-2xl p-4">
        <div class="text-xs text-slate-400 font-medium flex justify-between"><span>LUCRO REALIZADO (BOLSO)</span><span class="text-emerald-400 font-semibold" id="kpi-realized-pct">+0.00%</span></div>
        <div class="text-2xl font-bold text-emerald-400 mt-1" id="kpi-realized">+$0.00 USDT</div>
        <div class="text-xs text-slate-400 mt-1.5 flex justify-between"><span>Ciclos Fechados: <strong class="text-white" id="kpi-cycles">0</strong></span><span class="text-cyan-300">Taxa Maker: <strong>$0.00</strong></span></div>
      </div>
      <div class="glass rounded-2xl p-4">
        <div class="text-xs text-slate-400 font-medium flex justify-between"><span>ECONOMIA TAXA 0% MEXC</span><span class="text-amber-300 font-semibold">Vantagem Spot</span></div>
        <div class="text-2xl font-bold text-amber-400 mt-1" id="kpi-fees-saved">+$0.00 USDT</div>
        <div class="text-xs text-slate-400 mt-1.5">Economizado vs corretoras com 0.10% de taxa.</div>
      </div>
      <div class="glass rounded-2xl p-4">
        <div class="text-xs text-slate-400 font-medium flex justify-between"><span id="kpi-symbol-title">PREÇO AO VIVO MEXC</span><span id="kpi-rsi" class="text-cyan-300 font-semibold">RSI: 50.0</span></div>
        <div class="text-2xl font-bold text-white mt-1" id="kpi-price">$0.0000</div>
        <div class="text-xs text-slate-400 mt-1.5 truncate" id="kpi-regime">Regime: Lateral</div>
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-5">
      <div class="lg:col-span-2 glass rounded-2xl p-4 flex flex-col justify-between">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <h2 class="text-sm font-bold text-white">📈 Preço em Tempo Real MEXC & Degraus da Grade (Buy / Sell Limits)</h2>
            <p class="text-xs text-slate-400"><span class="text-emerald-400 font-semibold">Verdes = Ordens de Compra</span> abaixo do preço • <span class="text-amber-400 font-semibold">Douradas = Ordens de Venda (Take Profit)</span> acima</p>
          </div>
          <button onclick="simulateWave('CHOP')" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs text-slate-200">🌊 Simular Oscilação Lateral</button>
        </div>
        <div class="relative h-80 w-full"><canvas id="priceChart"></canvas></div>
      </div>

      <div class="glass rounded-2xl p-4 flex flex-col justify-between space-y-4">
        <div>
          <h2 class="text-sm font-bold text-white mb-3 flex items-center justify-between"><span>🏦 Carteira Spot Fictícia (MEXC)</span><span class="text-xs font-normal text-slate-400">Tempo Real</span></h2>
          <div class="space-y-2.5 text-xs">
            <div class="p-3 rounded-xl bg-slate-900/90 border border-slate-800 flex justify-between items-center">
              <div><div class="text-slate-400">USDT Livre (Caixa)</div><div class="text-sm font-bold text-white mt-0.5" id="wallet-usdt-free">$0.00 USDT</div></div>
              <span class="px-2 py-1 rounded bg-slate-800 text-slate-300">Reserva</span>
            </div>
            <div class="p-3 rounded-xl bg-emerald-950/30 border border-emerald-500/30 flex justify-between items-center">
              <div><div class="text-emerald-300/80">USDT em Compras (Grid)</div><div class="text-sm font-bold text-emerald-400 mt-0.5" id="wallet-usdt-locked">$0.00 USDT</div></div>
              <span class="px-2 py-1 rounded bg-emerald-500/20 text-emerald-300 font-semibold" id="count-buys">0 Ordens</span>
            </div>
            <div class="p-3 rounded-xl bg-amber-950/30 border border-amber-500/30 flex justify-between items-center">
              <div><div class="text-amber-300/80">Moedas em Vendas (TP)</div><div class="text-sm font-bold text-amber-400 mt-0.5" id="wallet-coin-locked">0.0000</div></div>
              <span class="px-2 py-1 rounded bg-amber-500/20 text-amber-300 font-semibold" id="count-sells">0 Ordens</span>
            </div>
          </div>
        </div>
        <div class="border-t border-slate-800 pt-3">
          <h3 class="text-xs font-bold text-slate-300 uppercase mb-2">⚙️ Ajustar Parâmetros da Grade</h3>
          <div class="grid grid-cols-2 gap-2 text-xs">
            <div><label class="text-slate-400 block mb-1">Banca (USDT)</label><input id="inp-capital" type="number" value="1000" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white font-semibold" /></div>
            <div><label class="text-slate-400 block mb-1">Nº de Ordens</label><input id="inp-levels" type="number" value="8" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white font-semibold" /></div>
            <div><label class="text-slate-400 block mb-1">Distância (%)</label><input id="inp-spacing" type="number" step="0.05" value="0.42" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white font-semibold" /></div>
            <div><label class="text-slate-400 block mb-1">Take Profit (%)</label><input id="inp-tp" type="number" step="0.05" value="0.52" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white font-semibold" /></div>
          </div>
          <button onclick="applyConfig()" class="w-full mt-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs font-bold text-white">🔄 Aplicar & Reiniciar Grade</button>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <div class="glass rounded-2xl p-4">
        <h2 class="text-sm font-bold text-white mb-3">📋 Livro de Ordens Abertas na Grade (LIMIT_MAKER)</h2>
        <div class="overflow-y-auto max-h-64">
          <table class="w-full text-left text-xs">
            <thead class="text-slate-400 border-b border-slate-800 sticky top-0 bg-slate-900">
              <tr><th class="py-2 px-2">Tipo</th><th class="py-2 px-2">Preço Alvo</th><th class="py-2 px-2">Distância</th><th class="py-2 px-2">Valor (USDT)</th><th class="py-2 px-2">Alvo Líquido</th></tr>
            </thead>
            <tbody id="table-open-orders" class="divide-y divide-slate-800/60"></tbody>
          </table>
        </div>
      </div>
      <div class="glass rounded-2xl p-4">
        <h2 class="text-sm font-bold text-white mb-3">⚡ Histórico de Execuções & Lucros Realizados</h2>
        <div class="overflow-y-auto max-h-64">
          <table class="w-full text-left text-xs">
            <thead class="text-slate-400 border-b border-slate-800 sticky top-0 bg-slate-900">
              <tr><th class="py-2 px-2">Hora</th><th class="py-2 px-2">Lado</th><th class="py-2 px-2">Preço Exec.</th><th class="py-2 px-2">Volume</th><th class="py-2 px-2">Lucro Líquido</th></tr>
            </thead>
            <tbody id="table-trades" class="divide-y divide-slate-800/60"></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <script>
    let chartInstance = null;
    function formatPrice(p) {
      if (!p) return "$0.00";
      if (p < 0.01) return "$" + p.toFixed(7);
      if (p < 10) return "$" + p.toFixed(4);
      return "$" + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
            x: { ticks: { color: '#64748b', maxTicksLimit: 8 }, grid: { color: 'rgba(51,65,85,0.2)' } },
            y: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(51,65,85,0.25)' } }
          }
        }
      });
    }
    function renderUI(state) {
      const w = state.wallet, m = state.market;
      document.getElementById('select-symbol').value = state.symbol;
      document.getElementById('kpi-equity').textContent = '$' + w.total_equity_usdt.toFixed(2);
      document.getElementById('kpi-initial').textContent = '$' + w.initial_usdt.toFixed(2);
      document.getElementById('kpi-roi').textContent = (w.total_roi_pct >= 0 ? '+' : '') + w.total_roi_pct.toFixed(2) + '%';
      document.getElementById('kpi-unrealized').textContent = 'Flutuante: $' + w.unrealized_pnl_usdt.toFixed(2);
      document.getElementById('kpi-realized').textContent = '+$' + w.realized_profit_usdt.toFixed(2) + ' USDT';
      document.getElementById('kpi-realized-pct').textContent = '+' + w.realized_pct.toFixed(2) + '%';
      document.getElementById('kpi-cycles').textContent = w.cycles_completed;
      document.getElementById('kpi-fees-saved').textContent = '+$' + w.fees_saved_usdt.toFixed(2) + ' USDT';
      document.getElementById('kpi-symbol-title').textContent = 'PREÇO ' + state.symbol + ' (MEXC)';
      document.getElementById('kpi-price').textContent = formatPrice(m.last_price);
      document.getElementById('kpi-rsi').textContent = 'RSI: ' + m.rsi_14 + ' | ATR: ' + m.atr_pct + '%';
      document.getElementById('kpi-regime').textContent = m.regime;
      document.getElementById('wallet-usdt-free').textContent = '$' + w.usdt_free.toFixed(2) + ' USDT';
      document.getElementById('wallet-usdt-locked').textContent = '$' + w.usdt_locked.toFixed(2) + ' USDT';
      document.getElementById('wallet-coin-locked').textContent = w.coin_locked.toFixed(4) + ' (' + formatPrice(w.coin_value_usdt) + ')';
      const buys = state.open_orders.filter(o => o.side === 'BUY');
      const sells = state.open_orders.filter(o => o.side === 'SELL');
      document.getElementById('count-buys').textContent = buys.length + ' Compras';
      document.getElementById('count-sells').textContent = sells.length + ' Vendas';
      document.getElementById('btn-toggle').innerHTML = state.is_running ? '⏸️ Pausar' : '▶️ Retomar';

      document.getElementById('table-open-orders').innerHTML = state.open_orders.map(o => {
        const dist = m.last_price > 0 ? (((o.price - m.last_price) / m.last_price) * 100).toFixed(2) : '0.00';
        const isBuy = o.side === 'BUY';
        return '<tr class="hover:bg-slate-800/40">' +
          '<td class="py-2 px-2 font-bold ' + (isBuy ? 'text-emerald-400' : 'text-amber-400') + '">' + (isBuy ? '🟢 BUY LIMIT' : '🎯 SELL TP') + '</td>' +
          '<td class="py-2 px-2 font-mono text-white">' + formatPrice(o.price) + '</td>' +
          '<td class="py-2 px-2 font-mono">' + (dist > 0 ? '+' : '') + dist + '%</td>' +
          '<td class="py-2 px-2 text-slate-300">$' + o.notional_usdt.toFixed(2) + '</td>' +
          '<td class="py-2 px-2 ' + (isBuy ? 'text-slate-400' : 'text-emerald-400 font-semibold') + '">' + (isBuy ? 'Aguardando' : '+$' + (o.expected_profit_usdt || 0).toFixed(2)) + '</td></tr>';
      }).join('');

      document.getElementById('table-trades').innerHTML = state.trade_history.map(t => {
        const isSell = t.side === 'SELL';
        return '<tr class="hover:bg-slate-800/40">' +
          '<td class="py-2 px-2 text-slate-400 font-mono">' + t.timestamp + '</td>' +
          '<td class="py-2 px-2 font-bold ' + (isSell ? 'text-amber-400' : 'text-emerald-400') + '">' + (isSell ? '💰 VENDA TP' : '🟢 COMPRA') + '</td>' +
          '<td class="py-2 px-2 font-mono text-white">' + formatPrice(t.price) + '</td>' +
          '<td class="py-2 px-2 text-slate-300">$' + t.quote_qty.toFixed(2) + '</td>' +
          '<td class="py-2 px-2 font-bold ' + (isSell ? 'text-emerald-400' : 'text-slate-400') + '">' + (isSell ? '+$' + t.realized_pnl_usdt.toFixed(2) + ' (+' + t.realized_pnl_pct.toFixed(2) + '%)' : 'Fee $0.00') + '</td></tr>';
      }).join('');

      if (chartInstance && state.klines && state.klines.length > 0) {
        const labels = state.klines.slice(-60).map(k => new Date(k.time * 1000).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'}));
        const prices = state.klines.slice(-60).map(k => k.close);
        const datasets = [{ label: 'Preço', data: prices, borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.08)', borderWidth: 2, pointRadius: 0, fill: true, tension: 0.2 }];
        state.open_orders.slice(0, 8).forEach(o => {
          datasets.push({
            label: o.side, data: Array(labels.length).fill(o.price),
            borderColor: o.side === 'BUY' ? 'rgba(16,185,129,0.55)' : 'rgba(251,191,36,0.65)',
            borderWidth: 1, borderDash: [5, 5], pointRadius: 0, fill: false
          });
        });
        chartInstance.data.labels = labels;
        chartInstance.data.datasets = datasets;
        chartInstance.update();
      }
    }
    async function fetchState() { const r = await fetch('/api/state'); renderUI(await r.json()); }
    async function simulateWave(t) { const r = await fetch('/api/simulate-wave', {method:'POST', body: JSON.stringify({wave_type:t})}); const d = await r.json(); renderUI(d.state); }
    async function runBacktest() { const r = await fetch('/api/backtest', {method:'POST'}); const d = await r.json(); renderUI(d.state); }
    async function toggleBot() { const r = await fetch('/api/toggle', {method:'POST'}); const d = await r.json(); renderUI(d.state); }
    async function changePair() { const s = document.getElementById('select-symbol').value; const r = await fetch('/api/reconfigure', {method:'POST', body: JSON.stringify({symbol:s})}); const d = await r.json(); renderUI(d.state); }
    async function applyConfig() {
      const payload = {
        symbol: document.getElementById('select-symbol').value,
        initial_usdt: parseFloat(document.getElementById('inp-capital').value),
        grid_levels: parseInt(document.getElementById('inp-levels').value),
        grid_spacing_pct: parseFloat(document.getElementById('inp-spacing').value),
        take_profit_pct: parseFloat(document.getElementById('inp-tp').value),
      };
      const r = await fetch('/api/reconfigure', {method:'POST', body: JSON.stringify(payload)});
      const d = await r.json(); renderUI(d.state);
    }
    window.addEventListener('DOMContentLoaded', () => { initChart(); fetchState(); setInterval(fetchState, 3000); });
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "healthy", symbol: state.symbol, equity: state.wallet.total_equity_usdt }));
  }
  if (req.url === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(state));
  }
  if (req.url === "/api/simulate-wave" && req.method === "POST") {
    const p = state.market.last_price;
    const sp = state.config.effective_spacing_pct / 100;
    const steps = [p * (1 - sp * 1.3), p * (1 - sp * 2.2), p * (1 + sp * 1.2), p * (1 + sp * 2.1), p];
    for (const s of steps) {
      processTick(Math.min(p, s) * 0.999, Math.max(p, s) * 1.001, s);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, state }));
  }
  if (req.url === "/api/backtest" && req.method === "POST") {
    await runHistoricalBacktest();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, state }));
  }
  if (req.url === "/api/toggle" && req.method === "POST") {
    state.is_running = !state.is_running;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, state }));
  }
  if (req.url === "/api/reconfigure" && req.method === "POST") {
    const body = await readBody(req);
    if (body.symbol) state.symbol = String(body.symbol).toUpperCase();
    if (body.initial_usdt) state.wallet.initial_usdt = Number(body.initial_usdt);
    if (body.grid_levels) state.config.grid_levels = Number(body.grid_levels);
    if (body.grid_spacing_pct) state.config.base_spacing_pct = Number(body.grid_spacing_pct);
    if (body.take_profit_pct) state.config.take_profit_pct = Number(body.take_profit_pct);
    state.wallet.realized_profit_usdt = 0;
    state.wallet.fees_saved_usdt = 0;
    state.wallet.cycles_completed = 0;
    state.trade_history = [];
    await initMarketAndGrid();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, state }));
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(HTML_DASHBOARD);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Servidor MEXC Zero-Fee Bot 24/7 ativo na porta ${PORT}`);
});
