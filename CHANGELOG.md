# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-12

### Added

- Initial release.
- Pure, synchronous `decide(input, config)` routing policy engine, ported
  faithfully from `local-first-llm` / `local-first-llm-android` (task-type
  taxonomy, hard sensitive-privacy rule, capability cross-reference, budget
  checks) with full-branch unit coverage.
- `createRouter(...)` with an OpenAI-chat-completions-shaped surface
  (`router.chat.completions.create(...)`), one bounded cross-mode retry on
  failure, and `routedTo` / `routingReason` on every result.
- Backends: `executorchBackend` (wraps `react-native-executorch`, optional peer
  dependency), `openaiCompatibleBackend`, and a native Anthropic Messages API
  `anthropicBackend`.
- Built-in default `CapabilityProvider` plus an open interface for richer
  future providers.

[0.1.0]: https://github.com/NagaYu/local-first-llm-react-native/releases/tag/v0.1.0
