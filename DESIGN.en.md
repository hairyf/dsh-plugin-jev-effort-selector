# Design notes

[中文](DESIGN.md) | English · [Back to README](README.en.md)

This document records **why** the plugin is built the way it is. The README says what it is and how to use it; this is the reasoning behind each trade-off, including the approaches that were tried and rejected. It assumes a reader who wants to change this plugin, or build something similar on DSH.

---

## Contents

1. [Two concepts: chip and envelope](#1-two-concepts-chip-and-envelope)
2. [What persists and what does not](#2-what-persists-and-what-does-not)
3. [The envelope: what Jev sees](#3-the-envelope-what-jev-sees)
4. [Two questions, one rule](#4-two-questions-one-rule)
5. [One decision per turn](#5-one-decision-per-turn)
6. [Detecting a manual pick](#6-detecting-a-manual-pick)
7. [The chip's lifetime](#7-the-chips-lifetime)
8. [The per-session switch](#8-the-per-session-switch)
9. [The Host ↔ browser channel](#9-the-host--browser-channel)
10. [Why nothing is written to the session log](#10-why-nothing-is-written-to-the-session-log)
11. [Failure behaviour](#11-failure-behaviour)
12. [Rejected approaches](#12-rejected-approaches)
13. [Known gaps](#13-known-gaps)

---

## 1. Two concepts: chip and envelope

The **chip** is the small label beside the composer's model selector: `Jev · High · 87%`. It shows not a model but **the reasoning depth this turn actually used**, and how sure Jev was.

The **envelope** is the request the plugin sends Jev at the start of each turn. Jev reads it and answers "how deep should this message be thought about".

They connect as **envelope → Jev → decision → chip**. How accurate the chip is depends on how much the envelope tells Jev, which is why most of this document is about the envelope.

---

## 2. What persists and what does not

This is the skeleton of the design. The plugin **owns no disk storage**. It uses exactly two things: the harness's own session log (durable) and process memory (volatile).

| State | Where | After a restart | Why |
|---|---|---|---|
| What the previous turn looked like (the envelope's memory) | session log → projection | ✅ present | decision quality must not drop after a restart |
| The chip's decision (effort, confidence, reason) | Host memory | ❌ empty | see [§7](#7-the-chips-lifetime) |
| Per-session switch | Host memory | ❌ back to the global setting | see [§8](#8-the-per-session-switch) |
| Manual-pick baseline | Host memory | ❌ first turn does not detect | see [§6](#6-detecting-a-manual-pick) |
| This turn's decision (reused by steps 2+) | Host memory | — | within one turn only |

One principle runs through all of it: **whatever can be rebuilt from the log is not stored separately; whatever cannot is acknowledged as volatile, and volatility is treated as the correct semantics** rather than papered over with another persistence layer.

### What a projection is

The DSH session log is an append-only event stream. A **projection** is a fold over that stream yielding a small result — the session title, the todo list. The harness caches fold results in `~/.dsh/storages/session_projcache/sessions/<sessionId>.json`, one file per session, shaped as a KV:

```
record.rows
├── title:       { ver:1, seq:2126, val:"…" }
├── todos:       { ver:2, seq:2141, val:[…] }
├── jevEffort:   { … }      ← this plugin, wired to the browser
└── jevContext:  { … }      ← this plugin, host-only
```

`seq` records how far into the log the fold reached. After a restart the harness resumes from `seq` rather than re-reading the whole log. `ver` is the plugin's declared `stateVersion`: bump it when the shape changes and the harness recomputes that one key only.

So the "envelope's memory" **does** land on disk — in the harness's cache, including the first 300 characters of user messages and the last 500 of the assistant's reply, in plain text. It is derived from the log (itself plain text), but it is one more copy, and deleting a session's log directory by hand does not remove it.

---

## 3. The envelope: what Jev sees

### The problem

Read in isolation, "go on" is trivial — Jev calls it `off`, even when the previous turn was designing a distributed transaction engine. "Scan" is worse: one word whose meaning depends entirely on what the assistant just asked.

### Shape

With `useContext` on, the plugin sends a system-role block, then the current message:

```
Context: an ongoing conversation with an AI coding assistant.
Session topic: Diagnose the startup error
Previous turn:
- reasoning effort used: high
- user said: "why does dsh fail to start?"
- earlier the user said: "go ahead"
- assistant ended with: "…fixed both sessions. Want me to scan the remaining 22 for the same framing fault?"
- activity: 14 steps, 9 tool calls
- previous turn outcome: completed
- open tasks: 0 in progress
```

What each line buys:

| Line | Solves |
|---|---|
| `reasoning effort used` | the depth baseline of the previous turn |
| `user said` / `earlier the user said` | two turns show direction better than one |
| `assistant ended with` | **the most valuable line.** One-word replies — "scan", "ok", "delete it" — mean whatever the assistant just asked. Without it, "scan" can only read as trivial |
| `activity` | heavy work or small talk |
| `previous turn outcome` | whether the turn ended normally; aborted, error, and max-tokens all count as "not completed" |
| `open tasks` | in-progress todos mean the work is not done |

### Size

User messages are cut at 300 characters, the assistant's tail keeps its last 500; the whole envelope lands around 500–800 tokens. This is deliberately generous: Jev is a classifier, a few hundred extra tokens cost little in latency or money, and for a one-word message a bit more context makes the call far more accurate. Beyond this the returns diminish — Jev does not win by reading everything. The cut lengths are constants at the top of `lib/index.js`.

### Sources

Every fact comes from events the harness writes itself:

| Event | Provides |
|---|---|
| `turn/start` | turn boundaries |
| `user/message` (only `source.kind === 'user'`) | what the person typed. Plugin-injected reminders share the type but carry `source.kind === 'plugin'` and must be filtered out |
| `assistant/message` | the assistant's tail |
| `step/start` / `tool/call` | activity counts |
| `turn/end` | `reason.kind`: `completed` / `aborted` / `error` / `max-tokens` / `blocked` |
| `request/header` | the effort and route actually used |
| the built-in `todos` projection | in-progress count |

One folding subtlety: `request/header` is appended **only when the config changes**. A turn may therefore have no header event at all — it ran at the previous header's values. The fold must **inherit** `effort` and `route` from the turn before, or the envelope reports `effort: null`. This surfaced when replaying real logs.

### The current message comes from elsewhere

The previous turn comes from the projection; **the current message cannot**. `agent/request` (where the decision happens) runs "before the accepted user batch is committed" — the harness contract's own words. At decision time the current message is not in the log yet, so the fold has not seen it.

The plugin therefore has an `agent/pre-step` listener whose only job is to hand the current step's user text to `agent/request`. Version 0.3.0 tried to read this from the projection too; every turn then passed through with "no current message" and Jev was never called. Offline log replay cannot catch this class of bug, because replay always runs after every event is written. Fixed in 0.3.1.

### First turn

With no previous turn the envelope is just `Context` and `Session topic`, and the relation question (next section) is not asked.

---

## 4. Two questions, one rule

### Two questions

Jev's API accepts several questions in one call (`questions` is an object keyed by name). Same call, no extra latency:

1. **`reasoning_effort`**: one rung of this model's ladder. Criteria are generated per ladder length.
2. **`relation`**: `continues` (follows up, confirms, answers a question the assistant asked) or `new` (an unrelated request).

The second question is what separates "what time is it" from "go on" — equally short, differing only in whether they continue the previous task. Across four measured scenarios the relation answer's confidence was ≥ 0.98 every time, steadier than the effort answer itself.

### One rule

With both answers in hand the plugin does exactly one thing:

> **If `relation === continues` and the previous turn's work is not finished, never go below the previous effort. In every other case, Jev's rung stands.**

"Not finished" is either of: `previous turn outcome ≠ completed`, or `open tasks > 0`.

Three variables, four cells, exhaustive:

| Continues? | Finished? | Action |
|---|---|---|
| no | yes | Jev's call |
| no | no | Jev's call (new topic, unrelated to the old work) |
| yes | yes | Jev's call |
| yes | **no** | **not below the previous effort** |

### Why the rule never reads the words

"What time is it", "what's the time", "go on", "continue", "scan", "ok", "thanks" — infinitely many phrasings. Enumerating them is impossible and unnecessary: language is Jev's job. **No line of plugin code inspects the message text.** It reads three variables — Jev's two answers and the log's completion state. The example phrases in the criteria ("including go on, ok, a one-word answer to the assistant's question") describe the category boundary for Jev; they are not a match list.

### Measured

| Previous turn | Message | Relation | Finished? | Result |
|---|---|---|---|---|
| High, heavy refactor | what time is it | new 1.00 | — | **Off** |
| High, interrupted | go on | continues 1.00 | no | **High** |
| High, finished | thanks | continues 0.99 | yes | **Off** |
| High, assistant asked "scan the rest?" | scan | continues 1.00 (effort only 0.16) | yes | tie breaks upward → **High** |

The last row is the interesting one: for a one-word "scan" Jev is unsure of the effort but certain it continues. The low-confidence rule takes over — the stronger of the top two rungs. That is the two layers working together.

### Low confidence

Below `confidenceThreshold`, the effort answer takes the **stronger** of the two most likely rungs. An uncertain relation is read as `continues` — the anchoring it can trigger only keeps depth, never removes it, so this errs toward safety.

### Upgrades

Take effect immediately, always. The rule locks exactly one case — no downgrade while continuing unfinished work.

---

## 5. One decision per turn

Jev is asked only at step 1 of a turn. Earlier versions rewrote only step 1's config; from step 2 on, the harness default came back — a turn that called ten tools ran at Jev's effort once and at the default nine times. The chip said High; most of the turn was not.

Now the step-1 decision is cached for the turn (`turnDecisions: sessionId → {turn, effort}`) and every later step reuses it. Measured on a 10-step turn: one `request/header` in the log — the harness appends one only when the config changes, so ten steps with no drift is exactly the evidence of consistency.

---

## 6. Detecting a manual pick

**Definition**: the selector's effort when the previous turn went out differs from the selector's effort when this turn goes out → the user picked by hand. Only the effort is compared; a model change goes to Jev as normal.

**Why not compare against the log**: `request/header` records the value Jev **rewrote**. Selector says High, Jev sent Medium, the log says Medium; comparing that against the selector's High next turn is always "different", and Jev would be skipped forever.

**Implementation**: every selector change writes a `model/selection` event. The fold counts them (`selections`). At each decision the plugin remembers the count (`seenSelections`, in memory); a higher count next turn, with the route unchanged, means a manual pick.

**Model switches do not count**: they also bump `model/selection`, but `previous.route ≠ current route`, so no manual pick is inferred and Jev decides afresh for the new model.

**After a restart**: `seenSelections` is empty; the first turn has no baseline and goes to Jev.

On a manual pick the plugin passes the config through untouched and records `reason: 'manual'`; the chip shows the picked effort with "manual pick, Jev sat out" on hover.

---

## 7. The chip's lifetime

**The chip is not persisted.** It shows Jev's most recent decision in this process; a restart empties it, and the next decision brings it back.

Reasoning: the chip means "Jev just chose this". After a restart the plugin itself no longer remembers what it chose or why (that lived in memory), yet a persisted chip would still display an effort — a decision nobody remembers. The 0.2.x chip had exactly this flaw: it folded the harness's `request/header`, inherited its persistence, but that event carries no confidence and no attribution, so the chip could only say a neutral "Thinking · High".

Now the chip lives **exactly as long as the decision it describes**. The cost: after a restart an old session shows no chip until its next turn. Acceptable.

**Four visibility states**:

| Global switch | Session switch | Decision | Shows |
|---|---|---|---|
| off | — | — | hidden |
| on | off | — | muted `Jev off`, clickable |
| on | on | none | hidden |
| on | on | some | `Jev · High · 87%` |

Hiding entirely when the global switch is off dates from 0.2.4: the problem then was a chip that kept saying "Thinking · High" with Jev off — restating the model selector beside it and implying Jev was still choosing.

**Refresh trigger**: the chip subscribes to the `jevEffort` projection (a fold of `request/header`) but does not display its value. It uses it as a signal: a change means a request went out, so the chip fetches the latest decision from the host. No polling.

**Per-session isolation**: the chip sits in `conversation.input.right`, a session-scoped slot; host-side decisions are keyed by `sessionId`. Session A's chip shows session A's decision.

---

## 8. The per-session switch

Clicking the chip opens a popover with one switch: "enable Jev for this session".

- Lives in Host memory, keyed by `sessionId`, not persisted
- A decision consults the session override first, then the global setting
- **Available only while the global switch is on.** The global switch is the master; a session override only makes sense beneath it, and "master off but one session secretly running" would confuse
- With the session switched off the chip stays visible as a muted `Jev off` — otherwise there is nothing left to click
- A restart clears memory and returns to the global setting

**Switching sessions does not affect it.** `agent/disposed` fires only on process shutdown or harness unload; the source has no idle eviction; leave and come back and everything in memory is still there.

---

## 9. The Host ↔ browser channel

Showing confidence and toggling the switch both need messages between browser and Host.

**The official route**: `TypertRemoteService` + `@Remote` decorators + a TypeScript-generated manifest (~500 lines of zod schema). This plugin is hand-written JavaScript with no such pipeline.

**The route taken**: the gateway has an **SRC fallback** — with no generated artifact, it discovers live services carrying `@Remote` markers. That marker is just an ordinary object on the prototype, which plain JS can set with `Object.defineProperty`:

```js
Object.defineProperty(JevRemote.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods', {
  value: { version: 1, methods: [{ method: 'getSessionState', invocation: { kind: 'direct' } }, …] },
})
remote.typertRemote = { service: remote, serviceKey: 'jevEffortSelector', namespace: 'jevEffortSelector' }
ctx.provide('jevEffortSelector', remote)
```

On the browser side, `ctx.remote.*` mounts generated namespaces only, but the raw RPC carrier beneath it is open:

```js
connection.rpc.call('/api', 'jevEffortSelector/getSessionState', { args: { sessionId } })
```

**Cost**: parameter validation degrades to "JSON by name", with no zod layer. The host checks types itself — enough for two methods (`getSessionState(sessionId)`, `setSessionEnabled(sessionId, enabled)`).

This path was proven with a minimal spike plugin before the fallback plan (a `/jev on|off` slash command) was dropped.

---

## 10. Why nothing is written to the session log

The plugin **appends nothing to the session log**. This was learned the hard way.

An early version wrote a custom `jev/effort` event with `session.append` and folded it. In the process that wrote it, everything worked. But the persistence read path requires every event type to be in the harness vocabulary (`KNOWN_SESSION_EVENT_TYPES`) or carry `ignorable: true` in its envelope — otherwise it **refuses to reconstruct the whole session** ("history failed to load"). And `Session.append()` has no way to set that marker.

Four sessions became unopenable. The repair then caused a second incident: the script that patched the logs recompressed multi-frame zstd into a single frame, and dsh could not start at all (recorded outside this repository).

Conclusion: the data the chip needs is already in the built-in `request/header`; confidence and attribution are not, but an in-memory channel covers them. **Not worth touching the log for.**

---

## 11. Failure behaviour

In every case below the plugin **passes the harness's config through untouched** — as if it did not exist for that turn, using whatever the selector currently says. No error, no stall, no retry:

- missing key
- network failure or timeout (`timeoutMs`)
- malformed reply
- Jev's rung is not in this model's ladder
- `agent/pre-step` captured no current message (empty batch, plugin-only injections)

On failure the turn cache and the chip are not updated; `seenSelections` still is, because it tracks the selector, not Jev's success.

---

## 12. Rejected approaches

Recorded so they are not walked again.

**Drop at most one rung per turn (hysteresis).** Meant to stop "go on" falling from High to Off. Killed by "what time is it": after a heavy refactor it would have to pass through Medium before reaching Off — one wasted turn of thinking. "Thanks" later proved it equally blunt, sticking at Medium after finished work. Replaced by "no downgrade only while continuing unfinished work", which covers the case without punishing new questions.

**A dedicated rule for interruptions.** Turns end unfinished for many reasons — abort, error, max tokens. One rule per cause is a dead end. Reading `turn/end.reason.kind` and treating everything but `completed` as unfinished covers them all with one field.

**Detect manual picks from the log's effort.** See [§6](#6-detecting-a-manual-pick): the log holds Jev's rewritten value; the comparison cannot work.

**Read the current message from the projection too.** See [§3](#the-current-message-comes-from-elsewhere): it is not in the log at decision time. 0.3.0 failed silently because of this.

**Persist the chip.** See [§7](#7-the-chips-lifetime): it would display a decision nobody remembers.

**Plugin-owned storage for decisions.** Would let the chip survive restarts, but breaks the principle "rebuild from the log or accept volatility", and adds a persistence layer to maintain.

**Chip shows "Jev" without confidence (the cheap option).** Possible, but when Jev times out and the caller's effort is used, labelling it "Jev" is wrong. Once the channel proved buildable, the complete version was the right one.

**A `/jev on|off` slash command for the per-session switch.** The fallback if the SRC channel could not be built. Dropped once the spike succeeded.

---

## 13. Known gaps

- **A `levels` editor**: choosing rungs per model inside the settings card. Judged feasible (the client can read `model.reasoning.efforts`) but not built; `settings.yaml` is the only way today.
- **Jev call latency**: 1.5–2.4 s serially ahead of every turn's first step. Could overlap with request assembly; not done.
- **An entry point when the global switch is off**: today the chip disappears entirely, leaving nowhere to see or re-enable it. Could show a muted `Jev off` that points to Settings.
