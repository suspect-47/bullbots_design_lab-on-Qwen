import Fastify from 'fastify'
import { runDesign } from '../agents/designService.js'
import { pickAgent, deterministicAgent } from '../agents/agent.js'
import { pickVerdictAgent } from '../agents/verdictAgent.js'
import { pickChatAgent } from '../agents/chatAgent.js'
import { pickVisionAgent } from '../agents/visionAgent.js'
import { fightContext } from '../../src/lib/verdict/fightVerdict.js'
import { aggregateByClass } from '../../src/lib/analysis/aggregate.js'

export function buildApp({ pool, agent, roster, verdictAgent, chatAgent, visionAgent } = {}) {
  // 8 MB: /critique carries a base64 PNG of the CAD viewport, which blows past
  // Fastify's 1 MB default and would otherwise 413 before reaching the handler.
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 })

  // Permissive CORS so the Vite frontend (different port) can call /design for
  // the live-Qwen path. Preflight + actual requests both get the headers.
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*')
    reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    reply.header('Access-Control-Allow-Headers', 'Content-Type')
    if (request.method === 'OPTIONS') reply.code(204).send()
  })

  app.get('/health', async () => ({ ok: true }))

  // Roster rows, preferring the live bots table. A deployment without Postgres
  // (the public demo) still has to answer: fall back to the injected snapshot
  // rather than 500ing and making the dashboard guess.
  async function rosterRows(sql) {
    if (pool) {
      try {
        const { rows } = await pool.query(sql)
        if (rows.length) return rows
      } catch { /* fall through to the snapshot */ }
    }
    return roster || []
  }

  app.get('/bots', async () => rosterRows('SELECT * FROM bots ORDER BY name'))

  // Live meta: compute per-class aggregates from the current bots table, so a
  // fresh `npm run ingest` (Bright Data → Postgres) is reflected immediately.
  app.get('/meta', async () => {
    const rows = await rosterRows('SELECT weapon_class AS weapon, wins, losses, ko_wins AS "koWins" FROM bots')
    return aggregateByClass(rows)
  })

  app.post('/design', async (request, reply) => {
    const { opponentName, opponentRecord, memory, seedBot } = request.body || {}
    // resolve opponent: caller-supplied record (frontend has the roster) OR the
    // injected roster (tests) OR the bots table.
    let record = opponentRecord || null
    if (!record && roster) record = roster.find((b) => b.name === opponentName)
    if (!record && pool) {
      try {
        const { rows } = await pool.query('SELECT name, weapon_class AS weapon, wins, losses, ko_wins AS "koWins" FROM bots WHERE name = $1', [opponentName])
        record = rows[0] || null
      } catch { record = null }
    }
    if (!record) return reply.code(400).send({ error: `unknown opponent: ${opponentName}` })
    const useAgent = agent || pickAgent(process.env)
    // Production stance: NO deterministic fallback. Tests inject an agent; in
    // production `pickAgent` returns the deterministic society only when the
    // server has no DASHSCOPE_API_KEY. Serving that as if it were Qwen is a
    // lookalike, which is worse than an honest failure — so refuse with 503.
    if (!agent && useAgent === deterministicAgent) {
      return reply.code(503).send({ error: 'Agent Society unavailable — set DASHSCOPE_API_KEY on the backend (npm run api).' })
    }
    // seedBot is optional: the studio sends the caller's current Lab build so
    // the search answers "what should I change about MY bot". runDesign vets it.
    // A Qwen upstream failure surfaces as 502 rather than a silent deterministic run.
    try {
      return await runDesign({ opponentRecord: record, agent: useAgent, memory, seedBot })
    } catch (err) {
      return reply.code(502).send({ error: `Qwen upstream error: ${err.message}` })
    }
  })

  app.post('/verdict', async (request, reply) => {
    const { playerBot, opponentRecord, winner } = request.body || {}
    if (!playerBot || !opponentRecord || !winner) {
      return reply.code(400).send({ error: 'playerBot, opponentRecord, and winner are required' })
    }
    const ctx = fightContext(playerBot, opponentRecord, winner)
    return (verdictAgent || pickVerdictAgent(process.env)).verdict(ctx)
  })

  // Toro AI chat. Pure-AI (no deterministic fallback): without a server-side
  // DASHSCOPE_API_KEY there is no agent, so return 503 for the UI to surface.
  app.post('/chat', async (request, reply) => {
    const { messages } = request.body || {}
    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.code(400).send({ error: 'messages[] required' })
    }
    const useChat = chatAgent || pickChatAgent(process.env)
    if (!useChat) {
      return reply.code(503).send({ error: 'AI chat unavailable — set DASHSCOPE_API_KEY on the backend (npm run api).' })
    }
    try {
      return await useChat.reply(messages.slice(-16))
    } catch (err) {
      return reply.code(502).send({ error: `AI upstream error: ${err.message}` })
    }
  })

  // The one agent that looks at the build instead of computing over it. Takes a
  // PNG data URL captured from the CAD viewport. Pure-AI, like Toro: a visual
  // read has no offline equivalent, so no key means 503 rather than a fabricated
  // critique. Advisory only — it never returns an edit.
  app.post('/critique', async (request, reply) => {
    const { image, spec, opponent } = request.body || {}
    if (typeof image !== 'string' || !image.startsWith('data:image/')) {
      return reply.code(400).send({ error: 'image must be a data:image/... URL captured from the viewport' })
    }
    if (!spec) return reply.code(400).send({ error: 'spec required' })
    const useVision = visionAgent || pickVisionAgent(process.env)
    if (!useVision) {
      return reply.code(503).send({ error: 'Design review unavailable — set DASHSCOPE_API_KEY on the backend (npm run api).' })
    }
    try {
      return await useVision.review({ image, spec, opponent })
    } catch (err) {
      return reply.code(502).send({ error: `Qwen-VL upstream error: ${err.message}` })
    }
  })

  return app
}
