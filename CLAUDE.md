# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Start server:** `npm start` (runs on port 6565 by default)
- **Run all tests:** `npm test` (vitest)
- **Run single test:** `npx vitest run -t "test name pattern"`
- **Run tests in watch mode:** `npx vitest`

## Architecture

ExplainToMe is a web app that lets users browse any URL and get LLM-powered explanations of highlighted text. No build step — vanilla HTML/CSS/JS frontend served by Express.

### Backend (`app.js` / `server.js`)

`app.js` exports a `createApp()` factory that accepts injectable dependencies (`fetchFn`, `openrouterApiKey`, `openrouterModel`, `openrouterBaseUrl`). `server.js` is the thin entry point that loads `.env` and starts listening.

Three API endpoints:
- `POST /api/proxy` — renders a URL in headless Chromium (Playwright), absolutizes asset URLs, strips scripts, returns HTML snapshot. PDF URLs are still fetched via `fetch`. Validates URLs against SSRF (private IPs blocked). This bypasses cross-origin iframe restrictions so text selection works.
- `POST /api/explain` — takes selected text + surrounding context + explanation level, streams an LLM response via SSE.
- `POST /api/chat` — follow-up questions in the same conversation, also SSE-streamed.

Both LLM endpoints use a shared `streamChat()` helper that talks to OpenRouter's OpenAI-compatible API with raw `fetch` (no SDK). Responses are streamed as SSE (`data: {"text": "..."}` frames, terminated by `data: [DONE]`).

### Frontend (`public/`)

Single-page app: `index.html`, `styles.css`, `app.js`, `marked.min.js` (vendored).

The proxied HTML is loaded into an iframe via `srcdoc` (same-origin, so JS can access the selection API). On text selection, a floating "EXPLAIN" button appears. The right panel shows the streamed explanation and accepts follow-up chat messages.

### Design System

`DESIGN.md` contains a BMW-inspired design system. Key constraints: zero border-radius everywhere, BMW Blue (`#1c69d4`) for interactive elements only, weight extremes (300/400/700/900). Dark/light theme toggle uses CSS variables on `:root` / `:root.light`.

### Configuration

All config via environment variables (loaded from `.env` by dotenv):
- `OPENROUTER_API_KEY` — required
- `OPENROUTER_MODEL` — defaults to `anthropic/claude-sonnet-4`
- `OPENROUTER_BASE_URL` — defaults to `https://openrouter.ai/api/v1`
- `PORT` — defaults to 6565
- `RENDER_TIMEOUT_MS` — headless page load timeout (default 30000)
- `RENDER_WAIT_UNTIL` — Playwright `waitUntil` (default `domcontentloaded`)
- `PROXY_USER_AGENT` — optional override for proxy/render User-Agent (default in `lib/constants.js`)

After `npm install`, run `npx playwright install chromium` once (required for HTML proxying).

### Testing

Tests use vitest + supertest with `globals: true` (no vitest imports needed). The `createApp()` factory accepts `fetchFn` (PDF + OpenRouter) and `renderPageFn` (HTML proxy) for mocking — tests never launch Chromium unless you opt into integration tests.

### Explanation Levels

Four levels with distinct system prompts: `eli5`, `simple`, `detailed`, `expert`. The `/api/explain` endpoint falls back to `detailed` for unknown levels. The `/api/chat` endpoint uses corresponding follow-up prompts from `levelFollowUps`.
