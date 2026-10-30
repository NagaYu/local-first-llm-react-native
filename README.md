# local-first-llm-react-native

> Implementation example of local-first-llm for React Native
> (react-native-executorch). The routing policy lives in the suite
> core ([local-first-llm][web]); this repository shows one platform
> implementation of it.

[![npm version](https://img.shields.io/npm/v/local-first-llm-react-native.svg)](https://www.npmjs.com/package/local-first-llm-react-native)
[![CI](https://github.com/NagaYu/local-first-llm-react-native/actions/workflows/ci.yml/badge.svg)](https://github.com/NagaYu/local-first-llm-react-native/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![types](https://img.shields.io/npm/types/local-first-llm-react-native.svg)](./src)

> **On-device vs. cloud routing for React Native LLM apps.** You bring an
> on-device backend and a cloud backend; this library decides — per request —
> which one should run it, using a task-type taxonomy, hard privacy rules,
> device-capability awareness, and optional cost/latency budgets.

It is the React Native implementation example of the suite core
[`local-first-llm`][web] (web), alongside the Android implementation example
[`local-first-llm-android`][android] (native Kotlin): the **same validated
routing-policy design**, re-implemented independently for the React Native
runtime.

## The problem

Software Mansion's [`react-native-executorch`][rne] already solved **on-device
model execution** for React Native — it wraps Meta's ExecuTorch and runs LLMs
locally. What it doesn't solve is the **routing decision**: should a given
request run on-device at all, or go to the cloud? Today every app answers that
by hand — duplicating privacy rules, capability checks, and fallback logic.

This library is only that decision, plus thin backend adapters to act on it. It
adds **nothing** to on-device execution itself — `react-native-executorch` does
that.

## Install

```bash
npm install local-first-llm-react-native
# On-device path (optional peer — skip it for a cloud-only app):
npm install react-native-executorch
```

`react-native-executorch` and `react-native` are **peer dependencies**.
`react-native-executorch` is **optional**: a cloud-only app never installs it,
and importing this package never loads it unless you actually construct
`executorchBackend`.

## Quickstart

```ts
import { createRouter } from 'local-first-llm-react-native';
import { executorchBackend } from 'local-first-llm-react-native/backends/executorch';
import { openaiCompatibleBackend } from 'local-first-llm-react-native/backends/openai-compatible';
import { LLAMA3_2_1B } from 'react-native-executorch';

const router = createRouter({
  onDevice: executorchBackend({ model: LLAMA3_2_1B }), // wraps react-native-executorch
  cloud: openaiCompatibleBackend({ baseURL: 'https://api.openai.com/v1', apiKey: '…' }),
  policy: { /* optional overrides */ },
});

const result = await router.chat.completions.create({
  messages: [{ role: 'user', content: 'Is this review positive or negative? …' }],
  hint: 'classification',      // → prefers on-device
  privacy: 'sensitive',        // → never silently sent to the cloud
});

console.log(result.routedTo);       // 'on-device' | 'cloud'
console.log(result.routingReason);  // human-readable explanation
console.log(result.choices[0].message.content);
```

The surface is deliberately shaped like `local-first-llm`'s
(`router.chat.completions.create(...)`, OpenAI-chat-completions request/response)
so the mental model carries over — even though nothing is shared under the hood.

## How routing works

`decide(input, config)` is a **pure, synchronous, zero-I/O** function — the
single source of truth, exhaustively unit-tested. Given a task hint, the request
shape, a privacy flag, the device capability, and optional budgets, it returns
`{ mode, reason }`. The steps run **strictly in order**:

1. **Privacy first.** `privacy: 'sensitive'` forces on-device if the device can
   run it; otherwise the request is **`blocked`** — it is *never* silently sent
   to the cloud.
2. **Preferred mode** from the task-type taxonomy (below), or a heuristic when no
   hint is given.
3. **Capability cross-reference.** A preferred-on-device request whose device
   capability is `not-viable` falls back to cloud; `on-device-degraded` still
   honors the preference (unless a budget overrides it).
4. **Budgets last.** Optional `costBudget` / `latencyBudget` can move a decision.
5. Return the decision, surfaced on the result as `routedTo` / `routingReason`.

### Task-type taxonomy

| `hint`           | Default preferred mode                                        |
| ---------------- | ------------------------------------------------------------- |
| `classification` | **on-device**                                                 |
| `extraction`     | **on-device**                                                 |
| `summarization`  | **on-device** (long documents override toward cloud)          |
| `chat`           | cloud                                                         |
| `reasoning`      | cloud                                                         |
| `creative`       | cloud                                                         |
| *(no hint)*      | heuristic: short input + no tools + modest max output → on-device; else cloud |

Every row, every heuristic threshold, and the budget estimates are overridable
via the `policy` config. This is the **same table** as `local-first-llm` and
`local-first-llm-android`.

### The privacy guarantee

A `'sensitive'` request returns in step 1 — it can only ever be `on-device` or
`blocked`, and budget checks and failure-fallback never run for it. So a
sensitive request **cannot reach the cloud backend**, even as a retry. This is
verified by tests.

## Backends

All three implement the same `Backend` contract and produce OpenAI-shaped
responses. Import from subpaths so a cloud-only app never pulls the executorch
adapter.

- **`executorchBackend`** — wraps `react-native-executorch`'s `LLMModule`
  (optional peer). Pass a built-in model descriptor (`model: LLAMA3_2_1B`) or a
  custom exported `.pte` (`modelSource` + `tokenizerSource` +
  `tokenizerConfigSource`). Supports token streaming (`onToken`) and best-effort
  `max_tokens` enforcement.
- **`openaiCompatibleBackend`** — any OpenAI-wire endpoint (OpenAI, Groq,
  Together, OpenRouter, a local llama.cpp/vLLM server, …).
- **`anthropicBackend`** — the **native Anthropic Messages API**, not the
  OpenAI-compat shim: `max_tokens` required, system prompt as a top-level
  parameter, `tool_use` content blocks (not `tool_calls`), and `stop_reason`
  mapped explicitly.

```ts
import { anthropicBackend } from 'local-first-llm-react-native/backends/anthropic';
const cloud = anthropicBackend({ apiKey: '…', model: 'claude-sonnet-5' });
```

## Capability provider

The built-in default derives capability from whether the on-device model
**loads** — the only honest signal `react-native-executorch` exposes: load
success → `on-device-full`, absence/failure → `not-viable`. It is a **floor, not
a benchmark** — it can't distinguish "full" from "degraded" on its own. The
`CapabilityProvider` interface is left open for a richer future provider (e.g. an
RN bridge to a hardware-eligibility / Foundation-Models-aware signal). This is
the same honest framing used by the built-in defaults in the suite core and the
Android implementation example.

## Fallback & resilience

If the primary route fails, the router does **one bounded retry against the
other mode** — if it's viable, and never toward the cloud for a sensitive
request. It's configurable (`fallback: { enabled: false }`). Every result carries
`routedTo`, `routingReason`, and `fellBack`.

## Choosing an ExecuTorch backend / quantization

Which ExecuTorch delegate and quantization you configure `react-native-executorch`
with (XNNPACK, Core ML, Vulkan, …; 4-bit vs. 8-bit, SpinQuant/QLoRA, …) is a
separate decision this library doesn't make.

## Example

A minimal Expo app is in [`example/`](./example) — the same call site routed
on-device, to the cloud, and blocked-when-sensitive, showing `routedTo` /
`routingReason`. (The on-device path needs a real device — see
[`CONTRIBUTING.md`](./CONTRIBUTING.md).)

## Prior art & credits

- **[`react-native-executorch`][rne]** (Software Mansion) is the foundation this
  project's on-device backend wraps. It solves on-device execution; this project
  adds only the routing layer on top and credits it clearly.
- **[`local-first-llm`][web]** and **[`local-first-llm-android`][android]** (also
  by this author) established and validated the routing design ported here a
  third time. All three share a **decision model but not a codebase**, by
  deliberate choice — the pure `decide()` function is re-implemented
  independently in each runtime.

## Testing & the on-device caveat

The policy engine and every backend's request/response mapping are unit-tested
with no network calls; `decide()` is held to 100% branch coverage. The
`executorchBackend` end-to-end path runs real ExecuTorch on-device and **cannot
be verified in ordinary CI** — it needs a device. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Local-first suite

This repository is an implementation example in the local-first suite (React Native).

- Suite core (routing policy): [local-first-llm][web]
- Full list of suite repositories and their roles: [Suite map](https://github.com/NagaYu/local-first-llm#suite-map)

## License

[MIT](./LICENSE) © NagaYu

[web]: https://github.com/NagaYu/local-first-llm
[android]: https://github.com/NagaYu/local-first-llm-android
[rne]: https://github.com/software-mansion/react-native-executorch
