# dsh-plugin-jev-effort-selector

[中文](README.md) | English

Let [Jev](https://typesafe.ai) — a System One model — decide how hard your model should think about each message.

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) only lets you switch reasoning effort by hand: greetings burn `high`, and a gnarly refactor arrives while you are still on `low`. This plugin asks Jev once per turn, before the first model call, how much thinking the message deserves, then rewrites the effort for that call.

Jev classifies rather than generates: roughly 300 tokens and a few hundred milliseconds per decision.

```
hello                                          → Jev Off 100%
rewrite this function to be async               → Jev Medium 99%
design a distributed queue for 1M concurrent... → Jev High 100%
```

The decision appears as a chip beside the composer's model selector.

## Features

- 🎚️ **Ladders derived per model**: reads the effort levels each model advertises and takes the
  weakest rung, `medium`, and `high` — a model that cannot disable thinking is never handed
  `off`, and `max` / `xhigh` are never spent automatically
- 🧭 **Context envelope**: three lines and a fixed ~100 tokens (previous effort, previous
  message, session title) so follow-ups like "continue" inherit their topic's depth; the
  conversation history never leaves the machine
- ⬆️ **Ties break upward**: below the confidence threshold, the stronger of the two most likely
  rungs wins — over-thinking costs a few tokens, under-thinking costs the answer
- 🛡️ **Silent fallback**: a missing key, an unreachable endpoint, a timeout, a malformed answer,
  a level the model rejects — each leaves the call with the effort its caller resolved, without
  throwing or blocking
- ⚙️ **Configuration in `settings.yaml`**: a settings card and the file itself are two doors onto
  the same values; edits apply hot and the plugin carries no storage of its own
- 🔀 **Session-scoped by construction**: decisions travel through a session projection, so the
  browser needs no polling and no RPC, and switching sessions never shows a stale value
- 🎛️ **Custom ladders**: set `levels` per `provider/model` with anywhere from 2 to 5 rungs; the
  criteria text adapts to the count

## Install

Prerequisites: [DSH](https://github.com/deepseek-ai/deepseek-harness) installed and `pnpm` on PATH.

```sh
# Install from GitHub (no build step, so no allowBuilds entry is needed)
dsh plugin --profile web add github:justhalfbit/dsh-plugin-jev-effort-selector

# Restart dsh web to load it
```

`web` is the profile behind `dsh web` (the browser UI); substitute your own profile name (`tui`, …) if you use another.
`dsh plugin add` writes the package into the profile's dependencies and appends it to `dsh.profile.bundles` for you — no manual editing.

After the restart, open **Settings → Plugins → Jev Effort Selector** and fill in the endpoint and key.

Uninstall with `dsh plugin --profile web remove dsh-plugin-jev-effort-selector`, then restart. Your configuration stays in the `jev-effort-selector` section of `~/.dsh/settings.yaml` and can be deleted by hand.

For local development: clone the repository, run `pnpm install`, then `dsh plugin --profile web add link:/absolute/path/dsh-plugin-jev-effort-selector`.

### Interface support

| Runtime | Decision core (intercept / classify / rewrite effort) | Composer chip |
|---|---|---|
| `dsh web` (browser GUI) | ✅ | ✅ |
| `tui` / `headless` | ✅ fully available | ❌ decisions still apply, they are just not shown |

The host half is interface-agnostic; the client half (the chip) declares `platform: "web"` and loads only in the browser UI.

## Configuration

Every field lives in the `jev-effort-selector` section of `~/.dsh/settings.yaml`, editable from the settings UI:

| Field | Default | Meaning |
|-------|---------|---------|
| `enabled` | `true` | Turn off to keep whatever effort you selected by hand |
| `apiUrl` | `https://zenmux.ai/api/v1/systemone` | Jev System One endpoint |
| `apiKey` | `''` | Literal-token escape hatch, declared `role('secret')` so it never leaves the Host. Normally left empty |
| `apiKeyEnv` | `JEV_API_KEY` | Credential reference the key is stored under. Not shown in the card; rename it in `settings.yaml` if you need to |
| `model` | `jev-latest` | Jev model route |
| `confidenceThreshold` | `0.6` | Below this, take the stronger of the top two levels |
| `timeoutMs` | `5000` | Give up on Jev; the call keeps the effort its caller resolved |
| `useContext` | `true` | Send a context envelope so follow-ups inherit topic depth |
| `levels` | `{}` | Per-model effort ladder, keyed by `provider/model` |

### Where the API key lives

The key never enters `settings.yaml`. It goes through the harness credentials service — the same path the stock **Settings → Models** page uses for a custom provider's key. The card's "API 密钥" box only writes (`set`) and reads status (`describe`); that status carries whether the reference resolves, which layer supplies it, and whether it is writable, and **has no slot a secret could ride in**, so the value never returns to the browser.

Resolution layers, most trusted first:

```
inherited process environment   read-only, wins
> ~/.dsh/.credentials.yaml      what the settings page writes, mode 0600
> <invocation cwd>/.env         read-only fallback
> ~/.dsh/.env                   read-only fallback
```

Any of these works:

```bash
# 1. type it into the settings card (lands in ~/.dsh/.credentials.yaml)
# 2. export it (highest precedence; the card then shows it as read-only)
export JEV_API_KEY=sk-...
# 3. put it in ~/.dsh/.env
```

When a read-only layer already supplies the reference, the card says so instead of accepting a write that resolution would ignore.

## How the ladder is chosen

Models advertise different effort levels — some cannot disable thinking, some have no `xhigh`. By default the plugin **reads what each model advertises** and takes the weakest rung, `medium`, and `high`:

```
claude-opus-4-6   off · low · medium · high · max          →  off / medium / high
claude-opus-5     off · low · medium · high · xhigh · max  →  off / medium / high
claude-fable-5    low · medium · high · xhigh · max        →  low / medium / high
```

The top rung is deliberately **not** the strongest level advertised: on a route that offers `max` or `xhigh`, making it automatic would spend the most expensive setting on every message Jev finds complex. Those rungs stay available through `levels`.

Override it in `levels` with 2–5 rungs (the criteria text adapts). Each rung needs its own description, so a longer ladder is narrowed to its ends plus an even spread of five — rungs forced to share one description are ones Jev cannot tell apart:

```yaml
jev-effort-selector:
  levels:
    host-llm-gateway/claude-opus-4-6:
      - "off"
      - medium
      - high
    host-llm-gateway/claude-fable-5:
      - low
      - high
```

Models absent from `levels` keep the derived ladder. A configured ladder is intersected with what the route actually advertises: a typo or an unsupported rung is dropped, and fewer than two survivors fall back to derivation. That guard is required — the LLM seam rejects an unsupported effort before provider I/O, with no clamping and no aliasing, so one unchecked typo would fail every first step instead of being ignored.

## The context envelope

Read in isolation, "continue" is a trivial message — Jev calls it `off`, even when the previous turn was designing a distributed transaction engine.

So when `useContext` is on, three extra lines travel with the message:

```
Previous reasoning effort: high
Previous user message: design a transaction engine with MVCC and two-phase commit...
Session topic: distributed transaction engine
```

This is not the conversation history: only the last decision, the first 200 characters of the previous message, and the session title DSH already maintains — a fixed ~100 tokens that does not grow with the conversation. System prompts, tool results, and code never leave the machine.

In practice the envelope is what keeps "continue" and "ok, go with that plan" at the depth their topic earned.

## Ties break upward

Jev returns a probability distribution. When the top probability falls below `confidenceThreshold`, the plugin takes the **stronger** of the two most likely rungs.

Over-thinking a simple message costs a few tokens. Under-thinking a hard one costs the answer.

## When it fails

A missing key, an unreachable endpoint, a timeout, a malformed answer, a level the model rejects — each one leaves the call with the effort its caller resolved. Nothing is thrown and nothing blocks the turn. If Jev goes down you lose the automatic switching and notice nothing else.

## How it works

```
agent/pre-step   capture the user's message text
       ↓
agent/request    ① resolve the model's advertised levels → ladder
  (step 1 only)  ② assemble the context envelope
                 ③ ask Jev
                 ④ rewrite LlmCallConfig.reasoningEffort
                 ⑤ append a jev/effort session event
       ↓
jevEffort        session projection, read in the browser through
  projection     useProjection → the composer chip, session-scoped for free
```

The host half declares the settings schema and the settings document persists it; the browser half draws the card on `settings.plugin.item` under that same namespace.

## Known behaviour

If your provider sets `compat.forceAdaptiveThinking: true`, the `off` rung will not truly disable thinking — it only drops to the minimum. That is the gateway's behaviour, not something the plugin can override.

## License

MIT
