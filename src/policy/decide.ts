/**
 * The routing policy decision function.
 *
 * `decide()` is pure, synchronous, and does zero I/O — it is the single source
 * of truth for on-device vs. cloud routing and is exhaustively unit-tested. It
 * is a faithful, independent port of the decision tree in `local-first-llm` and
 * `local-first-llm-android`; it imports nothing from either.
 *
 * Decision steps, applied strictly in order:
 *   1. Sensitive privacy → force on-device if capability allows, else `blocked`.
 *      Never falls back to cloud silently.
 *   2. Resolve the preferred mode from the taxonomy table (or the hint-absent
 *      heuristic), including the summarization long-document override.
 *   3. Cross-reference the preference against capability: a preferred on-device
 *      request whose capability is `not-viable` falls back to cloud;
 *      `on-device-degraded` still honors the preference (unless a budget check
 *      overrides it in step 4).
 *   4. Apply budget checks last.
 *   5. Return `{ mode, reason, code, preferredMode }`.
 */

import { normalizeRequest, resolvePolicyConfig, resolvePreferredMode } from './taxonomy';
import type {
  Capability,
  DecideInput,
  DecideResult,
  DecisionCode,
  PolicyConfig,
  PreferredMode,
  ResolvedPolicyConfig,
} from './types';

function isOnDeviceViable(capability: Capability): boolean {
  return capability === 'on-device-full' || capability === 'on-device-degraded';
}

function result(
  mode: DecideResult['mode'],
  code: DecisionCode,
  reason: string,
  preferredMode: PreferredMode,
): DecideResult {
  return { mode, code, reason, preferredMode };
}

/** Estimated relative cost of a mode. */
function estimatedCost(mode: PreferredMode, config: ResolvedPolicyConfig): number {
  return mode === 'cloud' ? config.estimates.cloudCost : config.estimates.onDeviceCost;
}

/** Estimated latency (ms) of a mode; on-device latency depends on capability. */
function estimatedLatencyMs(
  mode: PreferredMode,
  capability: Capability,
  config: ResolvedPolicyConfig,
): number {
  if (mode === 'cloud') return config.estimates.cloudLatencyMs;
  return capability === 'on-device-degraded'
    ? config.estimates.onDeviceDegradedLatencyMs
    : config.estimates.onDeviceFullLatencyMs;
}

/**
 * Budget checks (step 4), applied to a non-sensitive candidate decision. A
 * sensitive request can never reach this function — it returns in step 1 — so
 * budgets can never move a sensitive request off on-device.
 *
 * Cost pushes a cloud decision toward on-device; latency pushes an on-device
 * decision toward cloud. Each fires at most once, and a switch only happens when
 * the alternative mode is viable and satisfies the violated budget, so the two
 * checks cannot ping-pong. If a budget cannot be met by any viable mode, the
 * best-available mode is kept and reported with `budget-unmet`.
 */
function applyBudgets(
  base: DecideResult,
  input: DecideInput,
  config: ResolvedPolicyConfig,
): DecideResult {
  const { capability, costBudget, latencyBudget } = input;
  const preferredMode = base.preferredMode;

  const violatesCost = (mode: PreferredMode): boolean =>
    costBudget !== undefined && estimatedCost(mode, config) > costBudget;
  const violatesLatency = (mode: PreferredMode): boolean =>
    latencyBudget !== undefined && estimatedLatencyMs(mode, capability, config) > latencyBudget;

  if (base.mode === 'cloud') {
    if (violatesCost('cloud')) {
      if (
        isOnDeviceViable(capability) &&
        !violatesLatency('on-device') &&
        !violatesCost('on-device')
      ) {
        return result(
          'on-device',
          'budget-cost',
          `Cloud cost estimate (${estimatedCost('cloud', config)}) exceeds costBudget (${costBudget}); routed on-device instead.`,
          preferredMode,
        );
      }
      return result(
        'cloud',
        'budget-unmet',
        `Cloud cost estimate (${estimatedCost('cloud', config)}) exceeds costBudget (${costBudget}), but no viable within-budget alternative exists; kept cloud.`,
        preferredMode,
      );
    }
    if (violatesLatency('cloud')) {
      return result(
        'cloud',
        'budget-unmet',
        `latencyBudget (${latencyBudget}ms) is below the cloud latency estimate (${estimatedLatencyMs('cloud', capability, config)}ms), and on-device is not faster; kept cloud as the fastest available mode.`,
        preferredMode,
      );
    }
    return base;
  }

  // base.mode === 'on-device'
  if (violatesLatency('on-device')) {
    if (!violatesCost('cloud')) {
      return result(
        'cloud',
        'budget-latency',
        `On-device latency estimate (${estimatedLatencyMs('on-device', capability, config)}ms, capability=${capability}) exceeds latencyBudget (${latencyBudget}ms); routed cloud instead.`,
        preferredMode,
      );
    }
    return result(
      'on-device',
      'budget-unmet',
      `On-device latency estimate (${estimatedLatencyMs('on-device', capability, config)}ms) exceeds latencyBudget (${latencyBudget}ms), but cloud cost exceeds costBudget (${costBudget}); kept on-device.`,
      preferredMode,
    );
  }
  if (violatesCost('on-device')) {
    return result(
      'on-device',
      'budget-unmet',
      `On-device cost estimate (${estimatedCost('on-device', config)}) exceeds costBudget (${costBudget}), but cloud is not cheaper; kept on-device.`,
      preferredMode,
    );
  }
  return base;
}

/**
 * Decide whether a request should run on-device or in the cloud (or be blocked).
 *
 * @param input  Request classification and constraints — pure data.
 * @param config Optional policy overrides (taxonomy rows, heuristic thresholds, estimates).
 */
export function decide(input: DecideInput, config?: PolicyConfig): DecideResult {
  const resolved = resolvePolicyConfig(config);
  const privacy = input.privacy ?? 'normal';
  const { capability } = input;
  const onDeviceViable = isOnDeviceViable(capability);

  // Step 1 — hard sensitive-privacy rule. Never silently falls back to cloud.
  if (privacy === 'sensitive') {
    if (onDeviceViable) {
      return result(
        'on-device',
        'privacy-sensitive',
        `Request is marked sensitive; forced on-device (capability=${capability}).`,
        'on-device',
      );
    }
    return result(
      'blocked',
      'privacy-sensitive-blocked',
      'Request is marked sensitive but on-device execution is not viable (capability=not-viable); blocked rather than routed to the cloud.',
      'on-device',
    );
  }

  // Step 2 — resolve the preferred mode (taxonomy or heuristic, + summarization override).
  const request = normalizeRequest(input.request);
  const { preferredMode, usedHeuristic, summarizationOverride } = resolvePreferredMode(
    input.hint,
    request,
    resolved,
  );

  const preferenceDescription = usedHeuristic
    ? `heuristic (inputChars=${request.inputChars}, hasTools=${request.hasTools}, maxOutputTokens=${request.maxOutputTokens ?? 'unset'})`
    : `hint '${input.hint}'`;

  // Step 3 — cross-reference the preference against capability.
  let base: DecideResult;
  if (preferredMode === 'on-device') {
    if (capability === 'not-viable') {
      base = result(
        'cloud',
        'capability-fallback',
        `Preferred on-device via ${preferenceDescription}, but capability is not-viable; fell back to cloud.`,
        preferredMode,
      );
    } else {
      base = result(
        'on-device',
        'task-preference',
        `Preferred on-device via ${preferenceDescription}; capability=${capability} allows it.`,
        preferredMode,
      );
    }
  } else if (summarizationOverride) {
    base = result(
      'cloud',
      'summarization-long-document',
      `summarization input is a long document (inputChars=${request.inputChars} ≥ ${resolved.heuristics.longDocumentChars}); overridden toward cloud.`,
      preferredMode,
    );
  } else {
    base = result(
      'cloud',
      'task-preference',
      `Preferred cloud via ${preferenceDescription}.`,
      preferredMode,
    );
  }

  // Step 4 — budget checks last. Step 5 — return.
  return applyBudgets(base, input, resolved);
}
