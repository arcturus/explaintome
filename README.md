# ExplainToMe

Browse any website, highlight text, and get instant AI-powered explanations — from ELI5 to expert level.

## What it does

Paste a URL, and ExplainToMe loads the page in a proxied viewer where you can select any text. A floating "EXPLAIN" button appears — click it and an LLM explains the highlighted content in the context of the surrounding page. Choose your level of explanation and ask follow-up questions in a chat panel.

**Explanation levels:**
- **ELI5** — Simple words, fun analogies, like explaining to a 5-year-old
- **Simple** — Plain language, no jargon, clear and accessible
- **Detailed** — Thorough explanation with proper terminology
- **Expert** — Technical deep-dive with edge cases and caveats

## Setup

```bash
npm install
```

Create a `.env` file:

```
OPENROUTER_API_KEY=your-key-here
OPENROUTER_MODEL=anthropic/claude-sonnet-4
```

Any model available on [OpenRouter](https://openrouter.ai) works — just change `OPENROUTER_MODEL`.

## Run

```bash
npm start
```

Open http://localhost:6565

## Test

```bash
npm test
```

## Tech stack

- **Backend:** Node.js + Express — URL proxy, SSE-streamed LLM responses via OpenRouter
- **Frontend:** Vanilla HTML/CSS/JS, no build step
- **LLM:** Any OpenRouter-compatible model
- **Design:** BMW-inspired dark/light theme — sharp corners, blue accent, weight extremes

## License

MIT
