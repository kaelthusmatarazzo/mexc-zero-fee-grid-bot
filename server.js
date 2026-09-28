/**
 * MEXC Zero-Fee Adaptive Grid Bot — TEMPO REAL PURO (VELAS 1M + BANCA $50 USD + TUTORIAL ON-SCREEN)
 * - ZERO backtest no início: começa exatamente agora com $50.00 USDT e 0 trades passados.
 * - Gráfico de Velas Reais de 1 Minuto (TradingView Lightweight Charts) conectado à MEXC Spot API v3.
 * - Executa ordens SOMENTE quando o preço ao vivo da MEXC (Bid/Ask) toca as linhas da grade daqui para frente.
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
        headers: { "User-Agent": "MEXC-Live1m-Grid-50USD/4.0" },
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

const state = {
  mode: "LIVE_FORWARD_ONLY_50USD",
  symbol: (process.env.SYMBOL || "SOLUSDT").toUpperCase(),
  interval: "1m",
  is_running: true,
  started_at_iso: new Date().toISOString(),
  telemetry: {
    last_ping_ms: 0,
    min_ping_ms: 9999,
    avg_ping_ms: 0,
    total_pings: 0,
    ping_history: [],
    seconds_to_next_1m_candle: 60,
  },
  market: {
    last_price: 0,
    best_bid: 0,
    bid_qty: 0,
    best_ask: 0,
    ask_qty: 0,
    spread_bps: 0,
    rsi_14: 50.0,
    nearest_sell_price: 0,
    nearest_sell_dist_usd: 0,
    nearest_buy_price: 0,
    nearest_buy_dist_usd: 0,
  },
  wallet: {
    initial_usdt: 50.0,
    order_slice_usdt: 6.0,
    usdt_free: 8.0,
    usdt_locked: 30.0,
    coin_locked: 0.0,
    coin_value_usdt: 12.0,
    total_equity_usdt: 50.0,
    realized_profit_usdt: 0.0,
    realized_pct: 0.0,
    unrealized_pnl_usdt: 0.0,
    total_roi_pct: 0.0,
    fees_saved_usdt: 0.0,
    cycles_completed: 0,
  },
  config: {
    grid_levels: 7,
    spacing_pct: 0.22,
    take_profit_pct: 0.28,
    order_usdt: 6.0,
  },
  open_orders: [],
  trade_history: [],
  klines_1m: [],
  logs: [],
  _orderSeq: 100,
};

function recordPing(ms) {
  state.telemetry.last_ping_ms = ms;
  state.telemetry.total_pings += 1;
  if (ms < state.telemetry.min_ping_ms) state.telemetry.min_ping_ms = ms;
  state.telemetry.ping_history.push(ms);
  if (state.telemetry.ping_history.length > 30) state.telemetry.ping_history.shift();
  const sum = state.telemetry.ping_history.reduce((a, b) => a + b, 0);
  state.telemetry.avg_ping_ms = Number((sum / state.telemetry.ping_history.length).toFixed(2));
  state.telemetry.seconds_to_next_1m_candle = 60 - new Date().getUTCSeconds();
}

function addLog(msg) {
  const ts = new Date().toISOString().slice(11, 19) + " UTC";
  state.logs.unshift(`[${ts}] ${msg}`);
  if (state.logs.length > 60) state.logs.pop();
}

function updateWalletAndDistances() {
  const p = state.market.last_price;
  if (p <= 0) return;

  state.wallet.coin_value_usdt = Number((state.wallet.coin_locked * p).toFixed(4));
  state.wallet.total_equity_usdt = Number(
    (state.wallet.usdt_free + state.wallet.usdt_locked + state.wallet.coin_value_usdt).toFixed(4)
  );
  state.wallet.total_roi_pct = Number(
    (((state.wallet.total_equity_usdt - state.wallet.initial_usdt) / state.wallet.initial_usdt) * 100).toFixed(3)
  );
  state.wallet.realized_pct = Number(
    ((state.wallet.realized_profit_usdt / state.wallet.initial_usdt) * 100).toFixed(3)
  );
  state.wallet.unrealized_pnl_usdt = Number(
    (state.wallet.total_equity_usdt - state.wallet.initial_usdt - state.wallet.realized_profit_usdt).toFixed(4)
  );

  const sells = state.open_orders.filter((o) => o.side === "SELL").sort((a, b) => a.price - b.price);
  const buys = state.open_orders.filter((o) => o.side === "BUY").sort((a, b) => b.price - a.price);

  if (sells.length > 0) {
    state.market.nearest_sell_price = sells[0].price;
    state.market.nearest_sell_dist_usd = Number((sells[0].price - p).toFixed(4));
  }
  if (buys.length > 0) {
    state.market.nearest_buy_price = buys[0].price;
    state.market.nearest_buy_dist_usd = Number((p - buys[0].price).toFixed(4));
  }
}

function deployLive50UsdGrid(anchorPrice) {
  state.open_orders = [];
  state.trade_history = [];
  state.wallet.realized_profit_usdt = 0.0;
  state.wallet.fees_saved_usdt = 0.0;
  state.wallet.cycles_completed = 0;

  const sliceUsdt = state.config.order_usdt;
  const spacing = state.config.spacing_pct / 100;
  state.wallet.usdt_free = state.wallet.initial_usdt;
  state.wallet.usdt_locked = 0.0;
  state.wallet.coin_locked = 0.0;

  for (let s = 1; s <= 2; s++) {
    if (state.wallet.usdt_free >= sliceUsdt) {
      state.wallet.usdt_free -= sliceUsdt;
      const qty = sliceUsdt / anchorPrice;
      state.wallet.coin_locked += qty;
      const sellPrice = anchorPrice * (1 + spacing * s);
      state.open_orders.push({
        id: `ORD-${++state._orderSeq}`,
        level_name: `Venda #${s} (Take-Profit)`,
        side: "SELL",
        price: Number(sellPrice.toFixed(6)),
        quantity: qty,
        notional_usdt: Number((sellPrice * qty).toFixed(2)),
        linked_buy_price: anchorPrice,
        expected_profit_usdt: Number(((sellPrice - anchorPrice) * qty).toFixed(4)),
      });
    }
  }

  for (let b = 1; b <= 5; b++) {
    if (state.wallet.usdt_free >= sliceUsdt) {
      state.wallet.usdt_free -= sliceUsdt;
      state.wallet.usdt_locked += sliceUsdt;
      const buyPrice = anchorPrice * (1 - spacing * b);
      state.open_orders.push({
        id: `ORD-${++state._orderSeq}`,
        level_name: `Compra #${b} (Baixa)`,
        side: "BUY",
        price: Number(buyPrice.toFixed(6)),
        quantity: sliceUsdt / buyPrice,
        notional_usdt: Number(sliceUsdt.toFixed(2)),
        linked_buy_price: buyPrice,
        expected_profit_usdt: 0,
      });
    }
  }

  state.open_orders.sort((a, b) => b.price - a.price);
  updateWalletAndDistances();
  addLog(
    `🎯 Grade de $50.00 USD posicionada AO VIVO em ${state.symbol} @ $${anchorPrice.toFixed(4)}: 2 Vendas de $6 acima + 5 Compras de $6 abaixo + $8 Reserva.`
  );
}

function checkLiveOrderbookFills(bestBid, bestAsk, midPrice) {
  state.market.last_price = midPrice;
  if (!state.is_running || state.open_orders.length === 0) return;

  const nowStr = new Date().toISOString().slice(11, 19) + " UTC";
  const tpRatio = 1 + state.config.take_profit_pct / 100;
  const sliceUsdt = state.config.order_usdt;
  const spawned = [];

  for (let i = state.open_orders.length - 1; i >= 0; i--) {
    const o = state.open_orders[i];

    if (o.side === "BUY" && bestAsk <= o.price) {
      state.open_orders.splice(i, 1);
      state.wallet.usdt_locked = Math.max(0, state.wallet.usdt_locked - o.notional_usdt);
      state.wallet.coin_locked += o.quantity;
      state.wallet.fees_saved_usdt = Number((state.wallet.fees_saved_usdt + o.notional_usdt * 0.001).toFixed(4));

      const sellTarget = o.price * tpRatio;
      spawned.push({
        id: `ORD-${++state._orderSeq}`,
        level_name: `Venda TP (da ${o.level_name})`,
        side: "SELL",
        price: Number(sellTarget.toFixed(6)),
        quantity: o.quantity,
        notional_usdt: Number((sellTarget * o.quantity).toFixed(2)),
        linked_buy_price: o.price,
        expected_profit_usdt: Number(((sellTarget - o.price) * o.quantity).toFixed(4)),
      });

      state.trade_history.unshift({
        timestamp: nowStr,
        side: "BUY",
        price: o.price,
        trigger_detail: `Ask Real MEXC bateu $${bestAsk.toFixed(4)}`,
        quote_qty: o.notional_usdt,
        realized_pnl_usdt: 0,
      });
      addLog(
        `🟢 COMPRA AO VIVO! O preço caiu até $${o.price.toFixed(4)} e compramos $${o.notional_usdt.toFixed(2)} (0% Taxa). Nova ordem de Venda criada em $${sellTarget.toFixed(4)}!`
      );
    } else if (o.side === "SELL" && bestBid >= o.price) {
      state.open_orders.splice(i, 1);
      state.wallet.coin_locked = Math.max(0, state.wallet.coin_locked - o.quantity);
      const proceeds = o.price * o.quantity;
      const entry = o.linked_buy_price || o.price / tpRatio;
      const netPnl = (o.price - entry) * o.quantity;

      state.wallet.usdt_free += proceeds;
      state.wallet.realized_profit_usdt = Number((state.wallet.realized_profit_usdt + netPnl).toFixed(4));
      state.wallet.fees_saved_usdt = Number((state.wallet.fees_saved_usdt + proceeds * 0.001).toFixed(4));
      state.wallet.cycles_completed += 1;

      if (state.wallet.usdt_free >= sliceUsdt) {
        state.wallet.usdt_free -= sliceUsdt;
        state.wallet.usdt_locked += sliceUsdt;
        spawned.push({
          id: `ORD-${++state._orderSeq}`,
          level_name: `Re-Compra Grid`,
          side: "BUY",
          price: Number(entry.toFixed(6)),
          quantity: sliceUsdt / entry,
          notional_usdt: Number(sliceUsdt.toFixed(2)),
          linked_buy_price: entry,
          expected_profit_usdt: 0,
        });
      }

      state.trade_history.unshift({
        timestamp: nowStr,
        side: "SELL",
        price: o.price,
        trigger_detail: `Bid Real MEXC subiu a $${bestBid.toFixed(4)}`,
        quote_qty: Number(proceeds.toFixed(2)),
        realized_pnl_usdt: Number(netPnl.toFixed(4)),
      });
      addLog(
        `💰 LUCRO REALIZADO AO VIVO! Vendemos em $${o.price.toFixed(4)} com lucro líquido de +$${netPnl.toFixed(4)} USD (Taxa MEXC: $0.00)!`
      );
    }
  }

  if (spawned.length > 0) {
    state.open_orders.push(...spawned);
    state.open_orders.sort((a, b) => b.price - a.price);
  }
  updateWalletAndDistances();
}

async function startFreshRealTime1mSession() {
  try {
    const klineRes = await requestMexc(`/api/v3/klines?symbol=${state.symbol}&interval=1m&limit=80`);
    recordPing(klineRes.latencyMs);

    state.klines_1m = klineRes.data.map((r) => ({
      time: Math.floor(Number(r[0]) / 1000),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
    }));

    const bookRes = await requestMexc(`/api/v3/ticker/bookTicker?symbol=${state.symbol}`);
    recordPing(bookRes.latencyMs);

    const bid = Number(bookRes.data.bidPrice);
    const ask = Number(bookRes.data.askPrice);
    const mid = (bid + ask) / 2;
    state.market.best_bid = bid;
    state.market.bid_qty = Number(bookRes.data.bidQty);
    state.market.best_ask = ask;
    state.market.ask_qty = Number(bookRes.data.askQty);
    state.market.last_price = mid;
    state.market.spread_bps = Number((((ask - bid) / mid) * 10000).toFixed(2));
    state.market.rsi_14 = calcRSI(state.klines_1m.map((k) => k.close), 14);

    deployLive50UsdGrid(mid);
  } catch (err) {
    addLog(`❌ Erro ao inicializar sessão 1m: ${err.message}`);
  }
}

async function live1mTickerLoop() {
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

      const currentMinuteEpoch = Math.floor(Date.now() / 60000) * 60;
      if (state.klines_1m.length > 0) {
        const lastCandle = state.klines_1m[state.klines_1m.length - 1];
        if (lastCandle.time === currentMinuteEpoch) {
          lastCandle.close = mid;
          lastCandle.high = Math.max(lastCandle.high, bid, mid);
          lastCandle.low = Math.min(lastCandle.low, ask, mid);
        } else if (currentMinuteEpoch > lastCandle.time) {
          state.klines_1m.push({
            time: currentMinuteEpoch,
            open: lastCandle.close,
            high: Math.max(lastCandle.close, mid),
            low: Math.min(lastCandle.close, mid),
            close: mid,
            volume: 0,
          });
          if (state.klines_1m.length > 120) state.klines_1m.shift();
          state.market.rsi_14 = calcRSI(state.klines_1m.map((k) => k.close), 14);
        }
      }

      checkLiveOrderbookFills(bid, ask, mid);
    }
  } catch (e) {}
}

startFreshRealTime1mSession();
setInterval(live1mTickerLoop, 2000);

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
  <title>MEXC Live 1m Grid ($50 USD) — Tempo Real + Tutorial Interativo</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
  <style>
    body { background-color: #060a12; color: #e2e8f0; font-family: 'Inter', system-ui, -apple-system, sans-serif; }
    .glass { background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(12px); border: 1px solid rgba(51, 65, 85, 0.65); }
    .pulse-dot { animation: pulse 1.6s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  </style>
</head>
<body class="min-h-screen p-3 md:p-5">
  <div class="max-w-7xl mx-auto space-y-4">
    <header class="glass rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center text-xl">⚡</div>
        <div>
          <div class="flex flex-wrap items-center gap-2">
            <h1 class="text-base md:text-lg font-bold text-white">MEXC Spot Grid — Tempo Real (Velas 1m • Banca $50.00 USD)</h1>
            <span class="px-2 py-0.5 text-xs font-bold rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 flex items-center gap-1">
              <span class="w-2 h-2 rounded-full bg-emerald-400 pulse-dot"></span> AO VIVO (SEM TRADES DO PASSADO)
            </span>
            <span id="ping-badge" class="px-2 py-0.5 text-xs font-mono font-bold rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/40">
              🏓 PING MEXC: -- ms
            </span>
          </div>
          <p class="text-xs text-slate-400 mt-0.5">
            As ordens abaixo foram posicionadas <strong>AGORA</strong> com $50.00 USD. Nenhuma vela passada foi simulada!
          </p>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button onclick="toggleTutorial()" class="px-3 py-2 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/50 text-amber-300 text-xs font-bold transition flex items-center gap-1.5">
          🎓 Mostrar/Ocultar Tutorial na Tela
        </button>
        <select id="select-symbol" onchange="changeSymbol()" class="bg-slate-900 border border-slate-700 text-xs rounded-xl px-3 py-2 text-white font-bold">
          <option value="SOLUSDT">SOL/USDT (Recomendado)</option>
          <option value="SUIUSDT">SUI/USDT (Rápido no 1m)</option>
          <option value="XRPUSDT">XRP/USDT</option>
          <option value="BTCUSDT">BTC/USDT</option>
          <option value="ETHUSDT">ETH/USDT</option>
        </select>
        <button onclick="resetGridNow()" class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs font-bold text-white">
          🎯 Centralizar Grade no Preço Atual
        </button>
      </div>
    </header>

    <section id="tutorial-box" class="glass rounded-2xl p-4 border-2 border-amber-500/40 bg-gradient-to-r from-amber-950/20 via-slate-900/90 to-emerald-950/20 space-y-3">
      <div class="flex items-center justify-between border-b border-slate-800 pb-2">
        <div class="flex items-center gap-2">
          <span class="px-2 py-0.5 rounded bg-amber-500 text-slate-950 font-extrabold text-xs">COMO FUNCIONA NA PRÁTICA?</span>
          <h2 class="text-sm font-bold text-white">Entenda em 30 segundos o que o Bot faz com os seus $50.00 USD na MEXC:</h2>
        </div>
        <button onclick="toggleTutorial()" class="text-xs text-slate-400 hover:text-white">✕ Fechar Tutorial</button>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
        <div class="p-3 rounded-xl bg-slate-900/90 border border-slate-700/80 space-y-1">
          <div class="font-bold text-cyan-300 flex items-center gap-1.5"><span>1️⃣</span> Divisão dos seus $50.00 USD</div>
          <p class="text-slate-300 leading-relaxed">
            O bot divide sua banca de <strong>$50.00</strong> em fatias pequenas de <strong>$6.00 USD</strong>:
            <br>• <strong>$12.00</strong> ficam em <span class="text-amber-300 font-semibold">2 Ordens de Venda</span> acima do preço.
            <br>• <strong>$30.00</strong> ficam em <span class="text-emerald-400 font-semibold">5 Ordens de Compra</span> abaixo do preço.
            <br>• <strong>$8.00</strong> ficam livres na reserva.
          </p>
        </div>

        <div class="p-3 rounded-xl bg-emerald-950/25 border border-emerald-500/40 space-y-1">
          <div class="font-bold text-emerald-400 flex items-center gap-1.5"><span>2️⃣</span> Linhas Verdes = Armadilhas de Compra</div>
          <p class="text-slate-300 leading-relaxed">
            Olhe as <strong>linhas verdes no gráfico de 1m</strong> abaixo. Elas estão esperando o preço cair um pouquinho (<strong>-0.22%</strong> cada). Se a vela de 1 minuto cair e encostar numa linha verde, o bot compra <strong>$6.00</strong> automaticamente na baixa!
          </p>
        </div>

        <div class="p-3 rounded-xl bg-amber-950/25 border border-amber-500/40 space-y-1">
          <div class="font-bold text-amber-300 flex items-center gap-1.5"><span>3️⃣</span> Linhas Douradas = Hora de Lucrar</div>
          <p class="text-slate-300 leading-relaxed">
            Olhe as <strong>linhas douradas acima do preço</strong>. Se a vela de 1m subir e encostar numa linha dourada, o bot vende os <strong>$6.00</strong> mais caro, coloca o lucro no seu bolso e recria uma linha verde mais abaixo para repetir tudo!
          </p>
        </div>

        <div class="p-3 rounded-xl bg-indigo-950/25 border border-indigo-500/40 space-y-1">
          <div class="font-bold text-indigo-300 flex items-center gap-1.5"><span>4️⃣</span> Por que na MEXC funciona com $50?</div>
          <p class="text-slate-300 leading-relaxed">
            Em outras corretoras você paga <strong>0.10% de taxa</strong> por ordem, o que come o lucro de ordens de $6. Na <strong>MEXC Spot</strong>, ordens na grade (<em>Limit Maker</em>) têm <strong>0.00% de taxa</strong> — 100% de cada centavo ganho vai para você!
          </p>
        </div>
      </div>

      <div class="p-3 rounded-xl bg-black/50 border border-cyan-500/40 flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2 text-xs">
          <span class="px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-bold">🎙️ ASSISTENTE AO VIVO:</span>
          <span id="live-narrator" class="text-slate-200 font-medium">Conectando ao Orderbook da MEXC para narrar o próximo movimento...</span>
        </div>
        <span id="candle-timer" class="text-xs font-mono text-amber-300 font-bold">⏱️ Próxima vela 1m em: --s</span>
      </div>
    </section>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div class="lg:col-span-2 glass rounded-2xl p-4 flex flex-col justify-between">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
          <div>
            <h2 class="text-sm font-bold text-white flex items-center gap-2">
              🕯️ Gráfico em Tempo Real — Velas de 1 Minuto (MEXC Spot 1m)
            </h2>
            <p class="text-xs text-slate-400">
              As linhas tracejadas no gráfico são as suas ordens reais de <strong>$6.00 USD</strong> (<span class="text-amber-400 font-bold">Douradas = Venda</span> | <span class="text-emerald-400 font-bold">Verdes = Compra</span>)
            </p>
          </div>
          <div class="text-right font-mono">
            <div class="text-lg font-extrabold text-white" id="kpi-price">$0.0000</div>
            <div class="text-[11px] text-slate-400" id="kpi-bid-ask">Bid: -- | Ask: --</div>
          </div>
        </div>
        <div id="tv-chart" class="w-full h-96 rounded-xl overflow-hidden border border-slate-800/80"></div>
      </div>

      <div class="glass rounded-2xl p-4 flex flex-col justify-between space-y-3">
        <div>
          <div class="flex items-center justify-between border-b border-slate-800 pb-2 mb-3">
            <div>
              <h2 class="text-sm font-bold text-white">💵 Sua Banca de $50.00 USD</h2>
              <p class="text-[11px] text-slate-400">Contabilidade da Conta Demo em Tempo Real</p>
            </div>
            <div class="text-right">
              <div class="text-lg font-extrabold text-emerald-400" id="kpi-equity">$50.0000</div>
              <div class="text-[11px] text-emerald-300 font-semibold" id="kpi-profit">Lucro Bolso: +$0.0000</div>
            </div>
          </div>

          <div class="grid grid-cols-3 gap-2 text-center text-xs mb-3">
            <div class="p-2 rounded-xl bg-amber-950/30 border border-amber-500/30">
              <div class="text-[10px] text-amber-300/80 font-semibold">EM VENDAS (ACIMA)</div>
              <div class="text-sm font-bold text-amber-400 mt-0.5" id="w-sell-val">$12.00</div>
              <div class="text-[10px] text-slate-400" id="w-sell-count">2 ordens de $6</div>
            </div>
            <div class="p-2 rounded-xl bg-emerald-950/30 border border-emerald-500/30">
              <div class="text-[10px] text-emerald-300/80 font-semibold">EM COMPRAS (ABAIXO)</div>
              <div class="text-sm font-bold text-emerald-400 mt-0.5" id="w-buy-val">$30.00</div>
              <div class="text-[10px] text-slate-400" id="w-buy-count">5 ordens de $6</div>
            </div>
            <div class="p-2 rounded-xl bg-slate-900 border border-slate-700">
              <div class="text-[10px] text-slate-400 font-semibold">CAIXA LIVRE</div>
              <div class="text-sm font-bold text-white mt-0.5" id="w-free-val">$8.00</div>
              <div class="text-[10px] text-slate-400">Reserva USDT</div>
            </div>
          </div>

          <h3 class="text-xs font-bold text-slate-300 mb-1.5 flex justify-between">
            <span>🪜 Escada de Ordens Ativas ($6.00 cada)</span>
            <span class="text-cyan-400 font-mono">Distância: 0.22%</span>
          </h3>
          <div id="visual-ladder" class="space-y-1.5 max-h-60 overflow-y-auto pr-1"></div>
        </div>

        <div class="pt-2 border-t border-slate-800 text-[11px] text-slate-400 flex justify-between">
          <span>Ciclos Fechados Agora: <strong class="text-white" id="kpi-cycles">0</strong></span>
          <span>Taxa Poupada (0% MEXC): <strong class="text-amber-300" id="kpi-saved">+$0.0000</strong></span>
        </div>
      </div>
    </div>

    <div class="glass rounded-2xl p-4">
      <div class="flex items-center justify-between mb-2">
        <h2 class="text-sm font-bold text-white">⚡ Execuções Ao Vivo (Apenas ordens tocadas a partir do momento em que você abriu a sessão)</h2>
        <span class="text-xs text-slate-400 font-mono" id="started-time">Iniciado agora</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs">
          <thead class="text-slate-400 border-b border-slate-800">
            <tr>
              <th class="py-2 px-2">Hora Real (UTC)</th>
              <th class="py-2 px-2">Ação do Bot</th>
              <th class="py-2 px-2">Preço da Ordem</th>
              <th class="py-2 px-2">Gatilho Real no Orderbook MEXC</th>
              <th class="py-2 px-2">Valor da Fatia</th>
              <th class="py-2 px-2">Lucro Líquido</th>
            </tr>
          </thead>
          <tbody id="table-trades" class="divide-y divide-slate-800/60"></tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    let tvChart = null;
    let candleSeries = null;
    let priceLines = [];

    function formatPrice(p) {
      if (!p) return "$0.00";
      if (p < 0.01) return "$" + p.toFixed(7);
      if (p < 10) return "$" + p.toFixed(4);
      return "$" + p.toFixed(2);
    }

    function toggleTutorial() {
      const box = document.getElementById('tutorial-box');
      box.classList.toggle('hidden');
    }

    function initTradingView1mChart() {
      const container = document.getElementById('tv-chart');
      tvChart = LightweightCharts.createChart(container, {
        layout: { background: { type: 'solid', color: '#090e1a' }, textColor: '#94a3b8' },
        grid: { vertLines: { color: 'rgba(51, 65, 85, 0.22)' }, horzLines: { color: 'rgba(51, 65, 85, 0.22)' } },
        timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#1e293b' },
        rightPriceScale: { borderColor: '#1e293b' },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
      });

      candleSeries = tvChart.addCandlestickSeries({
        upColor: '#10b981',
        downColor: '#f43f5e',
        borderVisible: false,
        wickUpColor: '#10b981',
        wickDownColor: '#f43f5e'
      });

      window.addEventListener('resize', () => {
        tvChart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
      });
    }

    function updateGridLinesOnChart(openOrders) {
      if (!candleSeries) return;
      priceLines.forEach(line => candleSeries.removePriceLine(line));
      priceLines = [];

      openOrders.forEach(o => {
        const isBuy = o.side === 'BUY';
        const line = candleSeries.createPriceLine({
          price: o.price,
          color: isBuy ? '#10b981' : '#f59e0b',
          lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true,
          title: isBuy ? '🟢 COMPRA $6' : '🎯 VENDA $6 (TP)'
        });
        priceLines.push(line);
      });
    }

    function renderUI(state) {
      const w = state.wallet, m = state.market, t = state.telemetry;
      document.getElementById('select-symbol').value = state.symbol;
      document.getElementById('ping-badge').textContent = '🏓 PING MEXC: ' + t.last_ping_ms + ' ms';
      document.getElementById('candle-timer').textContent = '⏱️ Vela 1m fecha em: ' + t.seconds_to_next_1m_candle + 's';
      document.getElementById('kpi-price').textContent = formatPrice(m.last_price);
      document.getElementById('kpi-bid-ask').textContent = 'Bid: ' + formatPrice(m.best_bid) + ' | Ask: ' + formatPrice(m.best_ask);

      document.getElementById('kpi-equity').textContent = '$' + w.total_equity_usdt.toFixed(4) + ' USD';
      document.getElementById('kpi-profit').textContent = 'Lucro no Bolso: +$' + w.realized_profit_usdt.toFixed(4) + ' USD';
      document.getElementById('w-sell-val').textContent = '$' + w.coin_value_usdt.toFixed(2);
      document.getElementById('w-buy-val').textContent = '$' + w.usdt_locked.toFixed(2);
      document.getElementById('w-free-val').textContent = '$' + w.usdt_free.toFixed(2);
      document.getElementById('kpi-cycles').textContent = w.cycles_completed;
      document.getElementById('kpi-saved').textContent = '+$' + w.fees_saved_usdt.toFixed(4);

      const sells = state.open_orders.filter(o => o.side === 'SELL');
      const buys = state.open_orders.filter(o => o.side === 'BUY');
      document.getElementById('w-sell-count').textContent = sells.length + ' ordens de $6';
      document.getElementById('w-buy-count').textContent = buys.length + ' ordens de $6';

      if (m.nearest_sell_price > 0 && m.nearest_buy_price > 0) {
        document.getElementById('live-narrator').innerHTML =
          'Preço atual do <strong>' + state.symbol + '</strong> é <strong>' + formatPrice(m.last_price) + '</strong>. ' +
          'Se subir <strong>+$' + m.nearest_sell_dist_usd.toFixed(3) + '</strong> até <span class="text-amber-300 font-bold">' + formatPrice(m.nearest_sell_price) + '</span>, o bot <strong>VENDE $6.00 com lucro</strong>! ' +
          'Se cair <strong>-$' + m.nearest_buy_dist_usd.toFixed(3) + '</strong> até <span class="text-emerald-400 font-bold">' + formatPrice(m.nearest_buy_price) + '</span>, o bot <strong>COMPRA $6.00 na baixa</strong>!';
      }

      const topSells = sells.slice().sort((a, b) => b.price - a.price);
      const bottomBuys = buys.slice().sort((a, b) => b.price - a.price);

      let ladderHtml = '';
      topSells.forEach(o => {
        const diff = m.last_price > 0 ? (((o.price - m.last_price) / m.last_price) * 100).toFixed(2) : '0.00';
        ladderHtml += '<div class="flex justify-between items-center px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs font-mono">' +
          '<span class="text-amber-300 font-bold">🎯 ' + o.level_name + '</span>' +
          '<span class="text-white font-bold">' + formatPrice(o.price) + '</span>' +
          '<span class="text-emerald-400">+' + diff + '% (Lucro +$' + o.expected_profit_usdt.toFixed(3) + ')</span></div>';
      });

      ladderHtml += '<div class="flex justify-between items-center px-3 py-2 rounded-xl bg-cyan-500/20 border-2 border-cyan-400 text-xs font-mono my-1">' +
        '<span class="text-cyan-300 font-extrabold">⚡ PREÇO AO VIVO MEXC</span>' +
        '<span class="text-white text-sm font-extrabold">' + formatPrice(m.last_price) + '</span>' +
        '<span class="text-cyan-200">Ping: ' + t.last_ping_ms + ' ms</span></div>';

      bottomBuys.forEach(o => {
        const diff = m.last_price > 0 ? (((o.price - m.last_price) / m.last_price) * 100).toFixed(2) : '0.00';
        ladderHtml += '<div class="flex justify-between items-center px-2.5 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs font-mono">' +
          '<span class="text-emerald-400 font-bold">🟢 ' + o.level_name + '</span>' +
          '<span class="text-white font-bold">' + formatPrice(o.price) + '</span>' +
          '<span class="text-slate-300">' + diff + '% ($6.00 reservados)</span></div>';
      });
      document.getElementById('visual-ladder').innerHTML = ladderHtml;

      const tbody = document.getElementById('table-trades');
      if (state.trade_history.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="py-6 text-center text-slate-400">' +
          '⏳ <strong>Aguardando o preço real da MEXC encostar na primeira linha verde ou dourada...</strong> ' +
          '(Como você pediu zero simulação do passado, esta lista começa em 0 e registra cada ordem tocada ao vivo!)' +
          '</td></tr>';
      } else {
        tbody.innerHTML = state.trade_history.map(tr => {
          const isSell = tr.side === 'SELL';
          return '<tr class="hover:bg-slate-800/40">' +
            '<td class="py-2 px-2 font-mono text-slate-300">' + tr.timestamp + '</td>' +
            '<td class="py-2 px-2 font-bold ' + (isSell ? 'text-amber-400' : 'text-emerald-400') + '">' + (isSell ? '💰 VENDEU NA ALTA (TP)' : '🟢 COMPROU NA BAIXA') + '</td>' +
            '<td class="py-2 px-2 font-mono text-white">' + formatPrice(tr.price) + '</td>' +
            '<td class="py-2 px-2 font-mono text-cyan-300">' + tr.trigger_detail + '</td>' +
            '<td class="py-2 px-2 text-slate-300">$' + tr.quote_qty.toFixed(2) + ' USD</td>' +
            '<td class="py-2 px-2 font-bold ' + (isSell ? 'text-emerald-400' : 'text-slate-400') + '">' + (isSell ? '+$' + tr.realized_pnl_usdt.toFixed(4) + ' USD (0% Fee)' : 'Posicionado p/ Venda') + '</td></tr>';
        }).join('');
      }

      if (candleSeries && state.klines_1m && state.klines_1m.length > 0) {
        candleSeries.setData(state.klines_1m);
        updateGridLinesOnChart(state.open_orders);
      }
    }

    async function fetchState() {
      try {
        const r = await fetch('/api/state');
        renderUI(await r.json());
      } catch (e) {}
    }

    async function changeSymbol() {
      const symbol = document.getElementById('select-symbol').value;
      const r = await fetch('/api/reset-live', { method: 'POST', body: JSON.stringify({ symbol }) });
      const d = await r.json();
      renderUI(d.state);
      if (tvChart) tvChart.timeScale().fitContent();
    }

    async function resetGridNow() {
      const r = await fetch('/api/reset-live', { method: 'POST', body: JSON.stringify({}) });
      const d = await r.json();
      renderUI(d.state);
    }

    window.addEventListener('DOMContentLoaded', () => {
      initTradingView1mChart();
      fetchState();
      setInterval(fetchState, 2000);
    });
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        status: "healthy",
        mode: "LIVE_FORWARD_ONLY_1M_50USD",
        symbol: state.symbol,
        last_ping_ms: state.telemetry.last_ping_ms,
        best_bid: state.market.best_bid,
        best_ask: state.market.best_ask,
        initial_bankroll_usd: state.wallet.initial_usdt,
        equity_usd: state.wallet.total_equity_usdt,
        live_cycles_since_start: state.wallet.cycles_completed,
      })
    );
  }
  if (req.url === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(state));
  }
  if (req.url === "/api/reset-live" && req.method === "POST") {
    const body = await readBody(req);
    if (body.symbol) state.symbol = String(body.symbol).toUpperCase();
    await startFreshRealTime1mSession();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, state }));
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(HTML_DASHBOARD);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`⚡ Servidor MEXC Tempo Real 1m ($50 USD) rodando na porta ${PORT}`);
});
