/**
 * Built-in default capability provider.
 *
 * ## What this measures — and what it does not
 *
 * `react-native-executorch` exposes no dedicated "is this device capable" API.
 * The only honest signal available is whether the configured model actually
 * loads: a successful `LLMModule` load means the device could allocate and
 * initialise the model, a failure means it could not. This provider therefore
 * reports:
 *
 *   - `'on-device-full'`   — the on-device backend reports it can load/run.
 *   - `'not-viable'`       — the on-device backend is absent or failed to load.
 *
 * This is a **floor, not a benchmark**. It cannot by itself distinguish
 * `'on-device-full'` from `'on-device-degraded'` — a device that loads a model
 * but runs it slowly still reports `'on-device-full'` here. Surfacing
 * `'on-device-degraded'` requires a richer signal (thermal state, memory
 * pressure, a hardware-eligibility bridge). The {@link CapabilityProvider}
 * interface is intentionally left open for such a provider (e.g. an RN-facing
 * bridge to a Foundation-Models-aware capability source on iOS) without one
 * being built here. This matches the framing of the built-in defaults in the
 * sibling `local-first-llm` and `local-first-llm-android` projects.
 */

import type { Capability } from '../policy/types';
import type { Backend, CapabilityProvider, ChatCompletionRequest } from '../types';

/** Options for {@link builtinCapabilityProvider}. */
export interface BuiltinCapabilityProviderOptions {
  /**
   * The on-device backend to probe. If it exposes `probeCapability()`, that is
   * used; otherwise its mere presence is treated as `'on-device-full'` and its
   * absence as `'not-viable'`.
   */
  backend?: Backend;
  /**
   * A custom probe, taking precedence over `backend`. Return the capability
   * directly (sync or async). Throwing is treated as `'not-viable'`.
   */
  probe?: () => Promise<Capability> | Capability;
  /**
   * Cache the first resolved capability for the lifetime of the provider.
   * Device capability does not change within a session, and probing can be
   * expensive (it may load a model). Default `true`.
   */
  cache?: boolean;
}

/**
 * Create the built-in capability provider. Resolves to `'not-viable'` whenever
 * there is nothing to probe or probing fails, so the cloud-only path works with
 * no on-device backend configured.
 */
export function builtinCapabilityProvider(
  options: BuiltinCapabilityProviderOptions = {},
): CapabilityProvider {
  const { backend, probe, cache = true } = options;
  let cached: Capability | undefined;

  async function resolve(): Promise<Capability> {
    try {
      if (probe) {
        return await probe();
      }
      if (backend?.probeCapability) {
        return await backend.probeCapability();
      }
      // No probe available: presence of an on-device backend is the only signal.
      return backend ? 'on-device-full' : 'not-viable';
    } catch {
      return 'not-viable';
    }
  }

  return {
    async getCapability(_request?: ChatCompletionRequest): Promise<Capability> {
      if (cache && cached !== undefined) {
        return cached;
      }
      const capability = await resolve();
      if (cache) {
        cached = capability;
      }
      return capability;
    },
  };
}
