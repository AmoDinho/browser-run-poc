# FX Daily Chart Worker

A Cloudflare Worker utilising Browser Rendering (Puppeteer) to programmatically capture daily financial chart screenshots.

## Endpoints

- **GET `/`** — Index page listing endpoints and system status.
- **GET `/status`** — Retrieves current browser sessions status, concurrency limits, and active connections.
- **GET `/cleanup`** — Safely connects to and closes any hung/abandoned browser rendering sessions.
- **GET `/screenshot`** — Captures and returns the chart image based on the spec configuration.

## Setup & Deployment

1. **Install dependencies**:
   ```bash
   yarn install
   ```
2. **Log in to Cloudflare**:
   ```bash
   npx wrangler login
   ```
3. **Run development server locally**:
   ```bash
   yarn dev
   ```
   Then query endpoints at: `http://localhost:8787/` (e.g. `http://localhost:8787/status`).
4. **Deploy to production**:
   ```bash
   yarn deploy
   ```
