# Example app

A minimal Expo app that wires an on-device backend (`react-native-executorch`)
and a cloud backend (any OpenAI-compatible endpoint) into one router, and shows
how the **same call site** is routed by task type and privacy.

## Run it

```bash
cd example
npm install            # links the parent library via `file:..`
cp .env.example .env   # add your cloud API key for the cloud path
npm run ios            # or: npm run android  (a dev build / real device is required)
```

> **The on-device path needs a real device or simulator with an ExecuTorch
> model.** `react-native-executorch` runs Meta's ExecuTorch runtime natively, so
> Expo Go is not enough — use a development build (`expo run:ios` /
> `expo run:android`). See the repo's `CONTRIBUTING.md`.

## What to look at

`App.tsx` is the whole demo:

- **Classify** → the policy prefers on-device; the request runs through
  `react-native-executorch`.
- **Chat** → the policy prefers cloud; the request goes to the OpenAI-compatible
  endpoint.
- **Sensitive** → forced on-device, or **blocked** (never silently sent to the
  cloud) if the device can't run the model.

Every result surfaces `routedTo` and `routingReason`.

## Version note

`react-native-executorch` is built on the fast-moving ExecuTorch runtime and has
specific React Native / New Architecture requirements. If install or build
complains about versions, align `expo`, `react-native`, and
`react-native-executorch` per the current
[react-native-executorch docs](https://docs.swmansion.com/react-native-executorch/).
This example pins known-good baseline versions; bump them to match your target.
