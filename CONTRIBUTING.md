# Contributing

Thanks for your interest in `local-first-llm-react-native`.

## Development setup

```bash
pnpm install
pnpm build       # react-native-builder-bob → lib/{commonjs,module,typescript}
pnpm test        # Jest unit suite
pnpm typecheck   # tsc --noEmit
pnpm lint        # Biome
```

## What CI covers

The GitHub Actions workflow runs lint, typecheck, the Jest unit suite, and a
build. The unit suite is where the important guarantees live:

- **`decide()` — the policy decision tree.** This is the highest-priority code
  in the project and is held to 100% branch coverage. If you touch
  `src/policy/`, add or update the corresponding cases in
  `test/unit/decide.test.ts`.
- **Backend request/response mapping.** The `openaiCompatibleBackend` and
  `anthropicBackend` adapters are tested against fixture data with no live
  network calls (`fetch` is mocked). The Anthropic adapter in particular maps a
  distinct wire shape (`max_tokens`, top-level `system`, `tool_use` content
  blocks, `stop_reason`) and its mapping is covered explicitly.

## Verifying the ExecuTorch backend on a real device

`executorchBackend` wraps [`react-native-executorch`][rne], which runs Meta's
ExecuTorch runtime on-device. **This path cannot be verified in ordinary CI** —
it needs a real device or simulator with `react-native-executorch` installed and
an ExecuTorch model actually loaded. The unit tests exercise the backend's pure
logic (message mapping, capability signalling, error surfacing) by injecting a
fake module, but end-to-end generation must be checked manually:

1. In `example/`, install `react-native-executorch` and configure a model.
2. Run the example app on a physical device or simulator.
3. Confirm that a request the policy routes on-device actually loads the model
   and streams tokens, and that a load failure surfaces as a clear error (and,
   when configured, falls back to the cloud backend).

This limitation is shared by the sibling mobile project
`local-first-llm-android` and is inherent to on-device model execution.

## Design invariants (please preserve)

- `decide()` stays **pure and synchronous** with zero I/O.
- A `privacy: 'sensitive'` request must **never** silently reach the cloud
  backend. If on-device is not viable, it is `blocked`, not routed to cloud.
- The policy engine is reimplemented independently here — it must **not** import
  from `local-first-llm`.

[rne]: https://github.com/software-mansion/react-native-executorch
