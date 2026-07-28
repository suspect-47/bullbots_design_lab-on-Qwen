// Vercel serverless entry for the whole backend. One function serves every
// route the Fastify app exposes (/health, /bots, /meta, /design, /verdict,
// /chat, /critique) under the /api prefix, so the public demo is a single
// deployment: static Vite bundle + this handler.
//
// Alibaba Cloud Model Studio stays the LLM: DASHSCOPE_API_KEY is a Vercel
// environment variable read server-side here, never shipped to the browser.
import { buildApp } from '../server/api/app.js'
import roster from '../src/data/bots.json' with { type: 'json' }

// Postgres is optional on this deployment. Without DATABASE_URL the app serves
// /bots and /meta from the committed Bright Data snapshot instead.
async function makePool() {
  if (!process.env.DATABASE_URL) return null
  const { getPool } = await import('../server/db/pool.js')
  return getPool()
}

// Built once per warm container, not per request.
let ready = null
async function getApp() {
  if (!ready) {
    ready = (async () => {
      const app = buildApp({ pool: await makePool(), roster })
      await app.ready()
      return app
    })()
  }
  return ready
}

export default async function handler(req, res) {
  const app = await getApp()
  // Vercel routes /api/design here with the prefix still on the URL; Fastify
  // knows the routes as /design.
  req.url = req.url.replace(/^\/api(?=\/|$)/, '') || '/'
  app.server.emit('request', req, res)
}
