# MEXC Zero-Fee Adaptive Grid & Smart DCA Bot (Render 24/7)

Bot de renda passiva construído para a **MEXC Spot API v3**, aproveitando a **Taxa Maker 0.00% (`LIMIT_MAKER`)** com **Modo Demo (Paper Trading em Tempo Real)** e **Painel Quant Web 24/7**.

## Recursos Principais
- **0% Maker Fee Sniper**: Posiciona ordens `LIMIT_MAKER` na grade de compra e venda, economizando 100% das taxas que outras corretoras cobram.
- **Espaçamento Elástico via ATR(14) & Escudo Anti-Topo RSI(14)**: Ajusta automaticamente a distância entre ordens conforme a volatilidade real da MEXC.
- **Modo DEMO (Paper Trading) Integrado**: Opera com carteira virtual de `$1,000.00 USDT` consumindo o Orderbook (`bookTicker`) e velas (`klines`) reais da MEXC ao vivo.
- **Pronto para Render 24/7**: Inclui rota `/health` para monitoramento contínuo e painel interativo na rota `/`.
