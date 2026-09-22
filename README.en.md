# dsh-plugin-jev-effort-selector

Let [Jev](https://typesafe.ai) — a System One model — decide how hard your model should think about each message.

DeepSeek Harness only lets you switch reasoning effort by hand: greetings burn `high`, and a gnarly refactor arrives while you are still on `low`. This plugin asks Jev once per turn, before the first model call, how much thinking the message deserves, then rewrites the effort for that call.

Jev classifies rather than generates: roughly 300 tokens and a few hundred milliseconds per decision.

```
hello                                          → Jev Off 100%
rewrite this function to be async               → Jev Medium 99%
design a distributed queue for 1M concurrent... → Jev High 100%
```

The decision appears as a chip beside the composer's model selector.

## Install

```bash
npm i dsh-plugin-jev-effort-selector
```

DSH discovers `dsh.bundle.patch` and inserts the row into the host composition. After a restart, open **Settings → Plugins → Jev Effort Selector** and fill in the endpoint and key.

## Configuration

Every field lives in the `jev-effort-selector` section of `~/.dsh/settings.yaml`, editable from the settings UI:

| Field | Default | Meaning |
|-------|---------|---------|
| `enabled` | `true` | Turn off to keep whatever effort you selected by hand |
| `apiUrl` | `https://zenmux.ai/api/v1/systemone` | Jev System One endpoint |
| `apiKey` | `''` | Bearer token; empty means read the env var below |
| `apiKeyEnv` | `JEV_API_KEY` | Env var consulted when `apiKey` is empty |
| `model` | `jev-latest` | Jev model route |
| `confidenceThreshold` | `0.6` | Below this, take the stronger of the top two levels |
| `timeoutMs` | `5000` | Give up on Jev; the call keeps the effort its caller resolved |
| `useContext` | `true` | Send a context envelope so follow-ups inherit topic depth |
| `levels` | `{}` | Per-model effort ladder, keyed by `provider/model` |

Prefer the environment variable over writing the key into `settings.yaml`:

```bash
export JEV_API_KEY=sk-...
```

## How the ladder is chosen

Models advertise different effort levels — some cannot disable thinking, some have no `xhigh`. By default the plugin **reads what each model advertises** and takes the weakest, a middle rung, and the strongest:

```
claude-opus-4-6   off · low · medium · high · max   →  off / medium / max
claude-fable-5    low · medium · high · xhigh · max →  low / medium / max
```

Override it in `levels` with any number of rungs (2–5; the criteria text adapts):

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

Models absent from `levels` keep the derived ladder. If a declared level is one the model does not support, that decision is discarded and the call keeps the effort its caller resolved.

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

The settings form is not drawn by this plugin: the host half declares the schema, and the harness renders that section and persists it.

## Known behaviour

If your provider sets `compat.forceAdaptiveThinking: true`, the `off` rung will not truly disable thinking — it only drops to the minimum. That is the gateway's behaviour, not something the plugin can override.

## License

MIT
