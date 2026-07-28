# BullBots Design Lab

**Live demo → [bullbots-design-lab.vercel.app](https://bullbots-design-lab.vercel.app)** (full stack: live Qwen agents, vision review, Toro chat, and the Bright Data meta dashboard — no setup, no key).

A production-grade computer-aided design tool for BattleBots teams: design a bot in 3D, let an **agent society** negotiate a build grounded in real historical fight data, simulate the fight with real physics, and read the meta — with the society **learning across sessions**.

Four modes (top nav) plus **Toro**, an in-app AI assistant (bottom-right):

- **BUILD** — 3D parametric CAD editor (React-Three-Fiber). Edit weapon/armor/drivetrain/chassis; live weight/balance/HP against the 250 lb budget. **Reshape** any module into another shape from the kit (a drum becomes a bar, a flipper, forks — shared dimensions carry across, the rest are re-seeded in range), with **undo/redo** (⌘Z / ⇧⌘Z) and reset. Dimensions read in millimetres, not raw metres.
- **AGENTS** — the **Counter-Design Studio**. It answers "what should I change about *my* bot to beat this one": the search starts from whatever you have open in BUILD (falling back to a neutral seed only if that build cannot be read). Five specialists (scout, weapon, armor, drivetrain, chief) each enumerate every option on the axis they own, score all of them against the specific opponent, and argue for their pick; the chief accepts only what improves the predicted margin and still fits the weight budget. You get a proposal ledger (including what was refused and why), a spec diff against your build, the tradeoff space that was searched, and a per-specialist contribution breakdown — plus a measured comparison against a generalist given the same starting bot that never scouted. Load the result back into the lab.
- **ARENA** — stage your build vs a roster opponent (built from its real weapon class) in a Rapier physics arena. Press **Start**, watch (Auto-sim) or **drive it yourself** (Manual, WASD). Live HP bars, a **Sim Model** panel explaining the prediction, and an AI/offline fight-analyst verdict.
- **META** — "The Meta Intelligence" dashboard from **real Bright Data-scraped records**: weapon-class win/KO charts, a threat-ranking dumbbell, field-composition donut, counter-build recs, a top-10 leaderboard with generated bot avatars, and embedded fight videos.

## Setup

Requires **Node 20+**.

### 1. Quick start — no key needed

```bash
npm install
npm run dev          # app at http://localhost:5173
```

The agent society and the physics arena run **entirely in the browser** using a deterministic fallback, and the META dashboard renders from a committed real-data snapshot. So the app is fully usable with no backend and no key. Live Qwen reasoning, the fight analyst, Toro chat, and the "Have Qwen look at it" reviewer need the backend + a key (below).

### 2. Full setup — live Qwen on Alibaba Cloud Model Studio

Get a key at [qwencloud.com](https://www.qwencloud.com) → **Model Studio → API keys**, then:

```bash
cp .env.example .env          # set DASHSCOPE_API_KEY=sk-... in the new .env
npm run api                   # 1st terminal — backend at http://localhost:3001
npm run dev                   # 2nd terminal — app at http://localhost:5173
npm run qwen:smoke            # optional — verify the live Model Studio path end-to-end
```

Keep **both** `npm run api` and `npm run dev` running. Defaults to `qwen-plus` on the international endpoint; override with `QWEN_MODEL` / `DASHSCOPE_BASE_URL` in `.env`. The key stays server-side — it never reaches the browser.

### How the model is used

Every agent reasons through Qwen via one client, [`server/llm/qwen.js`](server/llm/qwen.js) (Model Studio's OpenAI-compatible chat-completions surface). Four roles:

- **Design specialists** — the five-agent society (strict-JSON edits).
- **Fight analyst** — the ARENA verdict + beat sheet (strict JSON).
- **Toro** — the in-app chat assistant.
- **Design reviewer** — **"Have Qwen look at it"** in BUILD sends a render of the 3D viewport to `qwen-vl-max` and returns a geometric critique (ground clearance, frontal profile, weapon overhang, balance) reconciled with the computed numbers. The one agent that *sees* the build, and the one that never emits an edit — a visual read advises, it does not ship.

The chief always **scores every proposal against the actual opponent** before accepting it, so the model can influence a build but never ship an unverified one. The society and fight analyst fall back to deterministic logic if the backend is unreachable; Toro chat (`POST /chat`) and the reviewer (`POST /critique`) are pure-AI (no offline fallback) and show an offline notice without a key.

## Deploy to Alibaba Cloud

The backend ships as a container for **Function Compute 3.0**, with an ECS path as an alternative and the frontend on **OSS static website hosting**. Everything is in [`deploy/`](deploy/) — see [`deploy/README.md`](deploy/README.md).

```bash
docker build -f deploy/Dockerfile -t bullbots-api .
s deploy -y                   # Serverless Devs → Function Compute (deploy/s.yaml)
```

## Deploy to Vercel (the public demo)

One deployment serves both halves: the Vite bundle as static assets, and the same Fastify app as a serverless function at `/api/*` ([`api/[...path].js`](api/%5B...path%5D.js), config in [`vercel.json`](vercel.json)). The LLM is still Alibaba Cloud Model Studio — `DASHSCOPE_API_KEY` is a server-side Vercel environment variable and never reaches the browser.

```bash
vercel link
vercel env add DASHSCOPE_API_KEY production   # plus DASHSCOPE_BASE_URL, QWEN_MODEL
vercel env add VITE_API_BASE production       # value: /api
vercel deploy --prod
```

`DATABASE_URL` is optional here: without Postgres, `/api/bots` and `/api/meta` serve the committed Bright Data snapshot instead of the live table, so the dashboard renders either way.

Two constraints this deployment target imposes, both already handled: a design run takes ~25s against Qwen, so `vercel.json` raises `maxDuration` well past the default; and the viewport capture the reviewer sends is downscaled to a 1024 px JPEG ([`src/lib/critique/capture.js`](src/lib/critique/capture.js)), because a full-size retina PNG data URL exceeds the serverless request-body limit.

## Real data (Bright Data)

`src/data/bots.json` + `aggregates.json` ship committed — the META dashboard renders offline from this **real** snapshot (61 bots scraped from the BattleBots wiki, incl. images and verified fight-video ids). To refresh the assets from source (needs `BRIGHTDATA_API_KEY` + `BRIGHTDATA_ZONE` in `.env`):

```bash
npm run scrape       # Bright Data Web Unlocker → the whole roster (wiki category + per-bot pages) → bots.json + aggregates.json
npm run enrich       # Bright Data Web Unlocker → per-bot images + top-bot fight videos → bots.json
npm run cartoonize   # image model → transparent chibi avatars for the top 10 → public/bots/ (needs OPENAI_API_KEY; assets are committed, so this is optional)
npm run ingest       # (optional) Bright Data → Postgres bots table for the live /meta path
```

Scraping is one-shot and offline: the app reads the committed JSON and never calls Bright Data at render time.

## Fight-model calibration

The headless model the agent society scores with is **fitted against the real data**, not hand-tuned: `scripts/fitFightModel.mjs` searches its free constants to match the observed per-weapon-class win rates in `bots.json`. Class archetypes are given identical records during the fit, so the result is driven by class structure rather than by the record-derived scaling — otherwise the exercise would be circular.

Current agreement is **Spearman rho = 0.83** on class ordering (rmse 0.12), unchanged under leave-one-class-out. `calibration.test.js` pins this, so a regression in the fight model fails the suite instead of quietly degrading the studio's numbers. Scores are still an *ordering* of builds, never a win probability — the UI says so.

`GET /meta` computes per-class aggregates **live from the bots table** when the backend runs; the frontend prefers it and falls back to the committed snapshot — the dashboard never breaks.

## Test / build

```bash
npm test             # 558 unit tests (DB-dependent suite skips without DATABASE_URL)
npm run build
```

## Architecture

| Area | Path |
|------|------|
| Parametric bot physics (mass/CG/inertia/HP/weapon energy, all SI) | `src/lib/domain/` |
| 3D CAD scene + editor | `src/lib/scene/`, `src/components/lab/` |
| Rapier fight arena (opponent gen, prediction, HUD, hologram-style bots) | `src/lib/sim/`, `src/components/arena/` |
| Agent society (scout, per-axis scored search, negotiation, headless eval) | `server/agents/` |
| Fight-model calibration against real per-class results | `server/agents/calibration.js`, `scripts/fitFightModel.mjs` |
| Counter-Design Studio UI | `src/lib/design/`, `src/components/design/studio/` |
| Cross-session memory | `src/lib/memory/` |
| Meta analysis + charts | `src/lib/analysis/`, `src/components/analysis/` |
| Bright Data enrichment (images/videos) + cartoon avatars | `server/ingest/`, `scripts/` |
| Toro AI chat | `src/components/chat/`, `src/lib/chat/`, `server/agents/chatAgent.js` |
| Qwen design reviewer (`qwen-vl-max`, vision) | `server/agents/visionAgent.js` |
| Alibaba Cloud Model Studio client | `server/llm/qwen.js` |
| REST API (health/bots/meta/design/verdict/chat/critique) | `server/api/` |
| Alibaba Cloud deployment (Function Compute / ECS / OSS) | `deploy/` |
| Vercel deployment (same API as one serverless function) | `api/[...path].js`, `vercel.json` |

Everything decision-relevant is a pure, unit-tested function; the LLM, 3D, and physics are thin layers over that core.

Live demo for both: [bullbots-design-lab.vercel.app](https://bullbots-design-lab.vercel.app).

- Architecture diagrams: [`docs/architecture.md`](docs/architecture.md)
- Alibaba Cloud API proof file: [`server/llm/qwen.js`](server/llm/qwen.js)
- Alibaba Cloud deployment: [`deploy/`](deploy/)

**Bright Data** — the scraped record is the spine: it fills the META dashboard, supplies the opponent the agent society argues against, and calibrates the fight model (Spearman rho = 0.83 on class ordering).

- Web Unlocker client: [`server/ingest/brightdata.js`](server/ingest/brightdata.js)
- Roster scrape: [`scripts/scrape.mjs`](scripts/scrape.mjs) — 61 heavyweights, 8-class weapon taxonomy
- Image + fight-video enrichment: [`scripts/enrich.mjs`](scripts/enrich.mjs), [`server/ingest/enrich.js`](server/ingest/enrich.js)
- The data itself: [`src/data/bots.json`](src/data/bots.json), [`src/data/aggregates.json`](src/data/aggregates.json)

## License

MIT — see [LICENSE](LICENSE).
