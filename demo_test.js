/**
 * MEXC Spot V3 Zero-Fee Adaptive Grid Bot — CLI Demo & Backtest Runner
 * Execute: node demo_test.js SOLUSDT
 */
const https = require("https");

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 7000 }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function run() {
  const symbol = (process.argv[2] || "SOLUSDT").toUpperCase();
  const book = await fetchJson(`https://api.mexc.com/api/v3/ticker/bookTicker?symbol=${symbol}`);
  console.log(`Conectado à MEXC (${symbol}) -> Bid: $${book.bidPrice} | Ask: $${book.askPrice}`);
}
run();
