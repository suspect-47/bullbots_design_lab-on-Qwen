# Architecture — BullBots Design Lab

Track 3: **Agent Society**. Five specialist agents, each owning one axis of a
combat-robot design, negotiate a build against a specific opponent. Every agent
reasons through **Qwen on Alibaba Cloud Model Studio**; every proposal is scored
against a fight model fitted to real historical results before it can be accepted.

## System

```mermaid
flowchart TB
    subgraph client["① Browser — served from Alibaba Cloud OSS static hosting"]
        direction LR
        CAD["BUILD<br/>parametric 3D CAD"]
        STU["AGENTS<br/>Counter-Design Studio"]
        ARE["ARENA<br/>Rapier physics fight"]
        MET["META<br/>intelligence dashboard"]
        FRY["Toro<br/>in-app assistant"]
        MEM[("cross-session<br/>memory")]
        WRK["Web Worker —<br/>offline society"]
        CAD --> STU --> ARE
        STU -.->|backend down| WRK
        STU <--> MEM
    end

    client ==>|"HTTPS · VITE_API_BASE"| API

    subgraph fc["② Alibaba Cloud Function Compute 3.0 — custom container"]
        direction TB
        API["Fastify API<br/>/design · /verdict · /chat · /meta · /bots"]
        SCOUT["scout — profiles the<br/>opponent's real record"]
        subgraph spec["specialists — one axis each"]
            direction LR
            W["weapon"]
            A["armor"]
            D["drivetrain"]
        end
        EVAL["fight model · fitted<br/>rho 0.83 vs real class win-rates"]
        CH["chief — accepts only what improves<br/>the margin and fits 250 lb"]
        LLM["server/llm/qwen.js<br/>Model Studio client"]
        API --> SCOUT --> spec
        spec <-->|"score every option"| EVAL
        spec -->|"proposals + arguments"| CH
        CH <--> EVAL
        spec --> LLM
        CH --> LLM
    end

    LLM ==>|"POST /compatible-mode/v1/chat/completions"| QWEN

    subgraph ali["③ Alibaba Cloud"]
        direction LR
        QWEN["Model Studio (DashScope)<br/>qwen-plus"]
        ACR["Container Registry<br/>bullbots-api image"]
        OSS["OSS<br/>static site + assets"]
        RDS[("ApsaraDB RDS<br/>PostgreSQL · bots")]
    end

    BD["Bright Data<br/>BattleBots wiki scrape"] -->|npm run ingest| RDS
    API --> RDS
    ACR -.->|image pull| fc
    OSS -.->|serves| client
```

## Design round — sequence

```mermaid
sequenceDiagram
    participant U as User (BUILD)
    participant S as Studio (browser)
    participant F as Fastify on Function Compute
    participant Sc as Scout
    participant Sp as Specialists (weapon/armor/drivetrain)
    participant Q as Qwen — Model Studio
    participant E as Fight model (fitted)
    participant C as Chief

    U->>S: pick opponent, send my current build
    S->>F: POST /design {seedBot, opponentRecord, memory}
    F->>Sc: scout the opponent
    Sc-->>Sp: threat profile from the real record
    loop each specialist, its own axis
        Sp->>E: enumerate + score EVERY option vs this opponent
        E-->>Sp: measured shortlist (margin, weight)
        Sp->>Q: shortlist + build + intel → propose ONE edit
        Q-->>Sp: {edit, reasoning}
        Sp->>E: score whatever Qwen asked for
        E-->>Sp: margin / weight / validity
    end
    Sp->>C: proposals + measurements + arguments
    C->>E: does it improve margin AND fit 250 lb?
    C-->>F: accept / refuse, with the reason recorded
    F-->>S: final build, proposal ledger, spec diff,<br/>tradeoff space, per-agent contribution,<br/>vs single-agent baseline
    S->>U: load the counter-build into the lab
```

## Why it is a society, not a prompt chain

- **Task division.** Each specialist owns exactly one axis (weapon / armor /
  drivetrain) and can only emit edits for that axis. The scout owns intel; the
  chief owns acceptance.
- **Disagreement resolution.** Specialists optimise their own axis and routinely
  ask for weight the budget cannot pay. The chief arbitrates against a shared,
  measurable objective — predicted margin under the 250 lb cap — and every
  refusal is recorded in the ledger with its reason.
- **Grounding.** Qwen may propose anything, including options outside the
  shortlist, but a proposal is re-scored server-side before it can be accepted.
  Qwen can influence a build; it cannot ship an unverified one.
- **Measured efficiency gain.** A single generalist agent, given the same
  starting bot and the same budget but no scouting and no axis division, is run
  on every request. The studio reports the margin delta between the society and
  that baseline — the Track 3 requirement, computed live, not claimed.
- **Graceful degradation.** If Model Studio or the backend is unreachable, the
  in-browser deterministic society takes over and the UI never breaks.

## Files

| Concern | Path |
|---|---|
| **Alibaba Cloud Model Studio client (Qwen)** | [`server/llm/qwen.js`](../server/llm/qwen.js) |
| Specialist agents, scout, chief, negotiation | [`server/agents/`](../server/agents/) |
| Multimodal design reviewer (`qwen-vl-max`, sees the viewport) | [`server/agents/visionAgent.js`](../server/agents/visionAgent.js) |
| Fight model + calibration against real results | `server/agents/headlessMatch.js`, `server/agents/calibration.js` |
| Single-agent baseline (efficiency comparison) | `server/agents/baseline.js` |
| REST API | [`server/api/app.js`](../server/api/app.js) |
| **Alibaba Cloud deployment** | [`deploy/`](../deploy/) |
| Parametric bot physics (SI) | `src/lib/domain/` |
| 3D CAD scene / editor | `src/lib/scene/`, `src/components/lab/` |
| Rapier fight arena | `src/lib/sim/`, `src/components/arena/` |
| Counter-Design Studio UI | `src/lib/design/`, `src/components/design/` |
| Cross-session memory | `src/lib/memory/` |
| Bright Data ingest | `server/ingest/` |
