/**
 * dsh-plugin-jev-effort-selector — host half.
 *
 * Asks the Jev System One model which reasoning effort each user message
 * deserves, then rewrites `LlmCallConfig.reasoningEffort` for that turn.
 *
 * Three registrations:
 *
 * 1. The `jev-effort-selector` settings namespace. Every field the settings
 *    UI shows is declared here, so the harness renders the form itself and
 *    persists edits into the user settings document — the plugin owns no
 *    storage of its own.
 * 2. The `jevEffort` session projection: a fold over the `jev/effort` events
 *    this plugin appends. The browser half reads it through the standard
 *    `useProjection` prop, so the chip needs no polling and no RPC, and each
 *    session sees only its own decision.
 * 3. `agent/pre-step` (capture the user text) and `agent/request` (decide,
 *    then replace the frozen call config).
 *
 * Failure is always silent and non-blocking: a missing key, a transport
 * error, a timeout, or an unparseable answer all leave the caller's original
 * effort untouched.
 * @module dsh-plugin-jev-effort-selector
 */

import { z as zod } from 'zod'
import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by this plugin. */
const NS = 'jev-effort-selector'

/** Projection key the browser half reads through `useProjection`. */
const PROJECTION_KEY = 'jevEffort'

/** Session event carrying one committed decision. */
const EVENT = 'jev/effort'

/** Effort ids ordered weakest to strongest, used to rank unknown ids. */
const RANK = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * The credential-reference grammar, restated rather than imported.
 *
 * `credentialRef()` from `@deepseek-ai/dsh-credentials` is exactly this test
 * plus `brandString`, which returns its argument unchanged — the brand is a
 * compile-time marker with no runtime representation. Restating one regex
 * keeps this package installable from a plain registry instead of adding a
 * harness-internal dependency for an identity function.
 */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Criteria text per level count. Jev is a classifier: these descriptions are
 * the whole prompt, so they carry the examples that separate the levels.
 */
const CRITERIA = {
  2: [
    'Simple: greetings, thanks, confirmations, yes/no, simple factual recall, basic formatting, short acknowledgments',
    'Complex: architecture design, deep analysis, performance optimization, multi-file refactoring, debugging, non-trivial code generation',
  ],
  3: [
    'Trivial: greetings, thanks, confirmations, yes/no, simple factual recall, basic formatting, short acknowledgments',
    'Moderate: standard code generation, summarization, translation, explaining a concept, simple debugging, routine file operations',
    'Complex: multi-file refactoring, architecture design, performance optimization, mathematical proofs, security analysis, debugging race conditions',
  ],
  4: [
    'Trivial: greetings, thanks, yes/no, simple facts, acknowledgments',
    'Simple: basic code edits, quick lookups, straightforward questions, formatting',
    'Moderate: standard code generation, explanations, simple debugging, routine refactoring',
    'Complex: architecture design, deep analysis, multi-file refactoring, performance optimization, proofs',
  ],
  5: [
    'Trivial: greetings, thanks, yes/no',
    'Simple: basic edits, quick lookups',
    'Moderate: standard code generation, explanations',
    'Hard: complex debugging, multi-file changes',
    'Extreme: architecture design, proofs, deep system analysis',
  ],
}

/** Longest ladder {@link CRITERIA} can describe with one distinct text per rung. */
const MAX_LADDER = 5

/**
 * Reduce a ladder to at most {@link MAX_LADDER} rungs, keeping the weakest,
 * the strongest, and an even spread between them.
 *
 * Every rung needs its own criteria text. Padding a longer ladder with a
 * repeated description would hand Jev two rungs it cannot tell apart, making
 * the choice between them arbitrary — worse than not offering them at all.
 * @param ladder - candidate ids, weakest first.
 * @returns at most `MAX_LADDER` ids, order preserved.
 */
function clampLadder(ladder) {
  if (ladder.length <= MAX_LADDER) return ladder
  const step = (ladder.length - 1) / (MAX_LADDER - 1)
  const picked = []
  for (let i = 0; i < MAX_LADDER; i += 1) {
    const id = ladder[Math.round(i * step)]
    if (!picked.includes(id)) picked.push(id)
  }
  return picked
}

/** Durable settings schema; the harness renders and persists this. */
const SettingsSchema = z.object({
  enabled: z.boolean().default(true)
    .description('Let Jev choose the reasoning effort. When off, your manual selection is kept.'),
  apiUrl: z.string().default('https://zenmux.ai/api/v1/systemone')
    .description('Full URL of the Jev System One endpoint.'),
  apiKey: z.string().default('').role('secret')
    .description('Literal token, kept only as an escape hatch. `role(\u2018secret\u2019)` strips it from every settings read, so it never reaches the browser; the credential reference below is the supported path.'),
  apiKeyEnv: z.string().default('JEV_API_KEY').role('credential-ref')
    .description('Credential reference resolved through the credentials service: the launching environment, then $DSH_HOME/.credentials.yaml, then the .env fallbacks.'),
  model: z.string().default('jev-latest')
    .description('Jev model route, e.g. jev-latest.'),
  confidenceThreshold: z.number().min(0).max(1).default(0.6)
    .description('Below this confidence, take the stronger of Jev\u2019s two most likely levels.'),
  timeoutMs: z.number().min(500).max(30000).default(5000)
    .description('Give up on Jev after this long and leave this call\u2019s effort as the caller resolved it.'),
  useContext: z.boolean().default(true)
    .description('Send a short context envelope (previous effort, previous message, session title) so follow-ups like \u201Ccontinue\u201D inherit the topic\u2019s depth.'),
  levels: z.dict(z.array(z.string())).default({})
    .description('Per-model effort ladder, keyed by "provider/model". Omit a model to derive its ladder from the levels it advertises.'),
})

/**
 * Projection state: the newest decision for one session, or null before the
 * first one. Zod, not schemastery — the projection seam validates state and
 * wire payloads with `ZodType`, while the settings seam takes a schemastery
 * schema. The two are not interchangeable.
 */
const ProjectionSchema = zod.object({
  choice: zod.string(),
  confidence: zod.number(),
  model: zod.string(),
  at: zod.number(),
}).nullable()

const name = 'jev-effort-selector'
const inject = ['sessionProjections']

/**
 * Derive a ladder from the levels one model advertises: weakest, a middle
 * rung, and a deep one.
 *
 * Both upper rungs prefer a named level and fall back to a position, so the
 * result stays predictable across providers: `medium` for the middle, `high`
 * for the top. The top deliberately is NOT the strongest level advertised —
 * a route that offers `max` or `xhigh` would otherwise spend it on every
 * message Jev finds complex. Those remain available through `levels`.
 * @param ids - effort ids in the adapter's preferred order.
 * @returns two or three ids, weakest first.
 */
function deriveLadder(ids) {
  if (ids.length <= 2) return ids.slice()
  const low = ids[0]
  let high = ids.includes('high') ? 'high' : ids[ids.length - 1]
  if (high === low) high = ids[ids.length - 1]
  let mid = ids.includes('medium') ? 'medium' : ids[Math.floor(ids.length / 2)]
  if (mid === low || mid === high) {
    // Fall back to the midpoint, then to any rung that is not already taken,
    // so the ladder never carries a duplicate.
    mid = ids[Math.floor(ids.length / 2)]
    if (mid === low || mid === high) mid = ids.find((id) => id !== low && id !== high) ?? mid
  }
  // Restore the advertised order. `high` prefers a named rung over a position,
  // so the rung picked for the middle can sit *after* it in the adapter's list
  // (`['low','high','max']` yields low/max/high). Criteria are assigned by
  // index, so an unsorted ladder would describe the stronger rung as the
  // lighter option and invert every decision it produces.
  return [low, mid, high].sort((a, b) => ids.indexOf(a) - ids.indexOf(b))
}

/**
 * Rank one effort id so a weaker/stronger comparison works for ids the
 * RANK table does not know.
 * @param ladder - the ladder in force for this call.
 * @param id - the effort id to rank.
 */
function rankOf(ladder, id) {
  const inLadder = ladder.indexOf(id)
  if (inLadder !== -1) return inLadder
  const known = RANK.indexOf(id)
  return known === -1 ? 0 : known
}

/**
 * Read the exact text of one user message, ignoring non-text blocks.
 * @param message - the UserMessage entering the step.
 */
function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

/**
 * Ask Jev which rung of `ladder` the request deserves.
 * @param config - resolved plugin settings.
 * @param key - the bearer token.
 * @param state - the Jev `state` payload: a string or a chat-shaped array.
 * @param ladder - candidate effort ids, weakest first.
 * @param signal - the step's abort signal.
 * @returns the chosen id with its confidence, or null when anything fails.
 */
async function askJev(config, key, state, ladder, signal) {
  // Callers clamp the ladder into the table's range; a length the table cannot
  // describe honestly keeps the caller's effort rather than inventing criteria.
  const descriptions = CRITERIA[ladder.length]
  if (descriptions === undefined) return null
  const criteria = {}
  ladder.forEach((id, i) => {
    criteria[id] = descriptions[i]
  })

  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, config.timeoutMs)

  try {
    const response = await fetch(config.apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: config.model,
        state,
        questions: {
          reasoning_effort: {
            type: 'choice',
            instructions: 'What level of reasoning effort does this request require? Weigh the full context, including the previous topic and the effort it needed.',
            criteria,
          },
        },
      }),
      signal: controller.signal,
    })
    if (!response.ok) return null

    const answer = (await response.json())?.answers?.reasoning_effort
    if (!answer || typeof answer.choice !== 'string') return null

    let choice = answer.choice
    const confidence = typeof answer.confidence === 'number' ? answer.confidence : 0

    // Low confidence: prefer the stronger of the two most likely rungs —
    // over-thinking a simple message costs tokens, under-thinking a hard one
    // costs the answer.
    if (confidence < config.confidenceThreshold) {
      const ranked = Object.entries(answer.probabilities ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([id]) => id)
      if (ranked.length === 2) {
        choice = rankOf(ladder, ranked[0]) >= rankOf(ladder, ranked[1]) ? ranked[0] : ranked[1]
      }
    }

    return ladder.includes(choice) ? { choice, confidence } : null
  } catch {
    // Abort, timeout, transport failure, malformed JSON: keep the caller's effort.
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/**
 * Resolve the bearer token the way the stock providers do (see
 * `dsh-web-search-deepseek`): an explicit literal first, then the credential
 * reference through the optional `credentials` service, and finally the bare
 * process environment for a deployment that mounts no credential provider.
 *
 * The seam layers the launching environment over the harness-managed
 * `$DSH_HOME/.credentials.yaml` over the `.env` fallbacks, so a key exported
 * into the environment keeps working untouched while the settings page gains
 * a place to write one. Resolution is per call by contract — the seam forbids
 * caching a resolved value across operations, which is what lets a key edited
 * in the browser reach the very next turn without a restart.
 * @param ctx - host context.
 * @param settings - resolved plugin settings.
 * @returns the token, or an empty string when nothing supplies one.
 */
async function resolveKey(ctx, settings) {
  if (settings.apiKey) return settings.apiKey

  const name = settings.apiKeyEnv
  // A name outside the reference grammar has no credential to miss, so it
  // reads as "not configured" rather than throwing out of a turn.
  if (typeof name !== 'string' || !REF_PATTERN.test(name)) return ''

  const credentials = ctx.get('credentials')
  if (credentials === undefined) return process.env[name] ?? ''
  try {
    return (await credentials.resolve(name))?.value ?? ''
  } catch {
    return ''
  }
}

/**
 * Register the settings section, the session projection, and the two agent
 * listeners that carry one decision from user text to call config.
 * @param ctx - host context.
 */
function apply(ctx) {
  /** Per-session scratch: the texts the envelope is built from. */
  const scratch = new Map()

  /** provider/model -> advertised effort ids, resolved once per route. */
  const ladders = new Map()

  let settings = SettingsSchema({})

  ctx.inject(['settings'], (scope) => {
    const section = scope.settings.register(NS, SettingsSchema)
    settings = section.get()
    scope.effect(() => section.watch((next) => { settings = next }))
  })

  // `wire` is what makes the value reach the browser: without it the unit is
  // host-only and `useProjection` never sees a thing. `apply` returns the same
  // reference for foreign events so unrelated traffic costs nothing downstream.
  ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: ProjectionSchema,
    init: () => null,
    apply(state, event) {
      if (event.type !== EVENT) return state
      return event.data
    },
    wire: {
      viewSchema: ProjectionSchema,
      view: (state) => state,
    },
  })

  ctx.on('agent/pre-step', (payload, next) => {
    if (payload.step === 1) {
      const text = messageText(payload.messages[payload.messages.length - 1])
      // A step carrying no user text (an empty batch, or blocks this plugin
      // cannot read) must not shift the window and drop the real previous
      // message: leave the scratch as it stands.
      if (text !== '') {
        const id = payload.agent.id
        const previous = scratch.get(id)
        scratch.set(id, { current: text, previous: previous?.current ?? '', effort: previous?.effort })
      }
    }
    return next()
  })

  ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    if (payload.step !== 1 || !settings.enabled) return config

    const entry = scratch.get(payload.agent.id)
    if (!entry?.current) return config

    const key = await resolveKey(ctx, settings)
    if (!key) return config

    const route = `${config.provider}/${config.model}`

    // What the route advertises is resolved first in every case: it is both
    // the fallback ladder and the guard for a configured one.
    let advertised = ladders.get(route)
    if (advertised === undefined) {
      const llm = ctx.get('llm')
      if (llm === undefined) return config
      try {
        const info = await llm.resolveModelInfo(config.provider, config.model, payload.signal)
        advertised = (info?.reasoning?.efforts ?? []).map((effort) => String(effort.id))
      } catch {
        // A route the adapter cannot describe right now. Leave the cache
        // empty so a later turn retries instead of writing this route off.
        return config
      }
      // Only a usable answer is worth caching; an empty one would otherwise
      // pin the route to "no ladder" for the life of the process.
      if (advertised.length >= 2) ladders.set(route, advertised)
    }
    if (advertised.length < 2) return config

    // A configured ladder is filtered against the advertised ids rather than
    // trusted. dsh-llm rejects an unsupported effort before provider I/O, so
    // one typo in `levels` would fail every first step instead of being
    // ignored — the opposite of this plugin's non-blocking contract.
    const configured = settings.levels?.[route]
    let ladder
    if (Array.isArray(configured)) {
      const usable = [...new Set(configured)].filter((id) => advertised.includes(id))
      ladder = usable.length >= 2 ? usable : deriveLadder(advertised)
    } else {
      ladder = deriveLadder(advertised)
    }
    ladder = clampLadder(ladder)

    // The envelope keeps short follow-ups ("continue", "go on") attached to
    // the depth their topic already earned, at a fixed ~100 token cost.
    let state = entry.current
    if (settings.useContext) {
      const lines = []
      if (entry.effort) lines.push(`Previous reasoning effort: ${entry.effort}`)
      if (entry.previous) lines.push(`Previous user message: ${entry.previous.slice(0, 200)}`)
      const titles = ctx.get('sessionTitle')
      if (titles !== undefined) {
        try {
          const title = titles.get(payload.agent.session)?.title
          if (title) lines.push(`Session topic: ${title}`)
        } catch {
          // Title is advisory; its absence never blocks a decision.
        }
      }
      if (lines.length > 0) {
        state = [
          { role: 'system', content: `Context: an ongoing conversation with an AI coding assistant.\n${lines.join('\n')}` },
          { role: 'user', content: entry.current },
        ]
      }
    }

    const decision = await askJev(settings, key, state, ladder, payload.signal)
    if (decision === null) return config

    scratch.set(payload.agent.id, { ...entry, effort: decision.choice })
    payload.agent.session.append(EVENT, {
      choice: decision.choice,
      confidence: decision.confidence,
      model: config.model,
      at: Date.now(),
    })

    return { ...config, reasoningEffort: decision.choice }
  })

  ctx.on('agent/disposed', (payload) => {
    scratch.delete(payload.agent.id)
  })
}

export { name, inject, apply }
