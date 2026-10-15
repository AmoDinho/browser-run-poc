# FX Daily Chart Spec

Worker utilising Cloudflare Browser Rendering (Puppeteer) to programmatically capture daily financial chart screenshots for visual analysis.

## Core Requirements

1. **Target Assets**:
   - **NASDAQ 100**: `https://www.livecharts.co.uk/MarketCharts/nasdaq100.php`
   - **Gold**: `https://www.livecharts.co.uk/MarketCharts/gold.php`

2. **Cron Schedule**:
   - **Frequency**: Every Monday to Friday at **07:00 UTC** (`0 7 * * 1-5`).
   - On scheduled triggers, captures 1D screenshots of both NASDAQ 100 and Gold, persisting them to the KV store.

3. **Query/Timeframe Parameter Mappings**:
   - Identifies interval mappings within the TradingView embedding iframe:
     - `1D` -> `"1 day"` (Header text "D")
     - `1W` -> `"1 week"` (Header text "W")
     - `1M` -> `"1 month"` (Header text "M")
     - `3M` -> `"3 months"` (Header text "3M")
     - `1Y` -> `"12 months"` (Header text "12M")

4. **DOM Selectors & Navigation**:
   - **Chart Iframe Element**: `iframe[src*="tradingview.com/widgetembed"]` or `iframe[src*="s.tradingview.com"]`
   - **Interval Dropdown Control**: `[aria-label="Chart interval"]` inside the TradingView iframe.
   - **Interval Options**: `div[role="row"]` containing the mapped label text.

5. **Storage Layout**:
   - Screens captured on cron trigger are stored in the `CHARTS_KV` KV namespace with the keys:
     - `[asset]/[timeframe]/[date_string].png` (e.g. `nasdaq100/1D/2026-08-26.png`)
     - `[asset]/[timeframe]/latest.png` (pointer to the most recent screenshot)