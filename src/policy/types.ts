/**
 * Shared types for the routing policy engine.
 *
 * This engine is a faithful, independent re-implementation of the decision tree
 * validated in `local-first-llm` (web) and `local-first-llm-android` (Kotlin).
 * It imports nothing from those projects — only the *design* is shared. See
 * {@link decide} for the ordered decision steps.
 */

/**
 * How viable on-device execution is for this request, as reported by a
 * {@link CapabilityProvider}. `on-device-full` means the device can run the
 * configured model normally; `on-device-degraded` means it can run but with
 * meaningful compromises (slower, smaller context, thermal throttling, etc.);
 * `not-viable` means on-device execution should not be attempted.
 */
export type Capability = 'on-device-full' | 'on-device-degraded' | 'not-viable';

/**
 * Task-type taxonomy. Each hint maps to a default preferred routing mode — see
 * {@link DEFAULT_TAXONOMY}. When absent, a heuristic infers a preference from
 * the request shape.
 */
export type TaskHint =
  | 'classification'
  | 'extraction'
  | 'summarization'
  | 'chat'
  | 'reasoning'
  | 'creative';

/** Privacy classification of the request. Defaults to `'normal'`. */
export type Privacy = 'sensitive' | 'normal';

/** The two executable routing modes a task can *prefer*. */
export type PreferredMode = 'on-device' | 'cloud';

/** The final routing decision. `'blocked'` is only produced by the hard sensitive-privacy rule. */
export type RoutingMode = 'on-device' | 'cloud' | 'blocked';

/**
 * A normalized view of the request used for hint-absent heuristics and the
 * summarization long-document override. The router derives this from a
 * chat-completions request; every field is optional so `decide()` degrades
 * gracefully when a signal is unavailable.
 */
export interface RequestShape {
  /**
   * Total input size in characters. If omitted, it is computed from
   * {@link RequestShape.messages} (string content and `{ type, text }` parts).
   */
  inputChars?: number;
  /** Raw messages, used to compute `inputChars` when it is not provided directly. */
  messages?: ReadonlyArray<{ role?: string; content?: unknown }>;
  /** Whether the request declares tools/function-calling. Overrides `toolCount` when set. */
  hasTools?: boolean;
  /** Number of declared tools, used to derive `hasTools` when it is not provided directly. */
  toolCount?: number;
  /** Requested maximum output tokens (`max_tokens` / `maxOutputTokens`), if the caller set one. */
  maxOutputTokens?: number;
}

/** Input to {@link decide}. Pure data — no backends, no I/O. */
export interface DecideInput {
  /** On-device viability for this request, from a {@link CapabilityProvider}. */
  capability: Capability;
  /** Optional task-type hint; when absent a heuristic infers a preference. */
  hint?: TaskHint;
  /** Privacy classification. Defaults to `'normal'`. */
  privacy?: Privacy;
  /** Optional cost ceiling (relative units); compared against per-mode cost estimates. */
  costBudget?: number;
  /** Optional latency ceiling in milliseconds; compared against per-mode latency estimates. */
  latencyBudget?: number;
  /** Request shape used for hint-absent heuristics and the summarization override. */
  request?: RequestShape;
}

/** Heuristic thresholds for the hint-absent path and the summarization override. */
export interface HeuristicConfig {
  /** Max input characters for a request to count as "short input". Default 280. */
  shortInputMaxChars: number;
  /** Max output tokens for a request to count as "modest max output". Default 256. */
  modestMaxOutputTokens: number;
  /** Input characters at/above which a `summarization` request is treated as a long document and overridden toward cloud. Default 8000. */
  longDocumentChars: number;
}

/**
 * Per-mode cost/latency estimates used by the budget checks. These are coarse
 * defaults meant to be overridden by the app — they are a policy input, not a
 * measurement. Latency for on-device depends on {@link Capability}.
 */
export interface EstimateConfig {
  /** Relative cost of a cloud request. Default 1. */
  cloudCost: number;
  /** Relative cost of an on-device request. Default 0. */
  onDeviceCost: number;
  /** Estimated cloud round-trip latency in ms. Default 800. */
  cloudLatencyMs: number;
  /** Estimated on-device latency in ms when capability is `on-device-full`. Default 1500. */
  onDeviceFullLatencyMs: number;
  /** Estimated on-device latency in ms when capability is `on-device-degraded`. Default 5000. */
  onDeviceDegradedLatencyMs: number;
}

/** Optional policy overrides accepted by the router / {@link decide}. */
export interface PolicyConfig {
  /** Override individual taxonomy rows (e.g. force `chat` on-device). */
  taxonomy?: Partial<Record<TaskHint, PreferredMode>>;
  /** Override heuristic thresholds. */
  heuristics?: Partial<HeuristicConfig>;
  /** Override cost/latency estimates used by budget checks. */
  estimates?: Partial<EstimateConfig>;
}

/** Fully-resolved policy config (defaults merged in). Produced by `resolvePolicyConfig`. */
export interface ResolvedPolicyConfig {
  taxonomy: Record<TaskHint, PreferredMode>;
  heuristics: HeuristicConfig;
  estimates: EstimateConfig;
}

/**
 * Stable, machine-readable code for the deciding factor. Prefer asserting on
 * this in tests over the human-readable `reason` string.
 */
export type DecisionCode =
  /** Sensitive request forced on-device. */
  | 'privacy-sensitive'
  /** Sensitive request blocked because on-device was not viable (never silently sent to cloud). */
  | 'privacy-sensitive-blocked'
  /** Routed per the taxonomy/heuristic preference; capability allowed it. */
  | 'task-preference'
  /** Preferred on-device but capability was `not-viable`; fell back to cloud. */
  | 'capability-fallback'
  /** `summarization` overridden toward cloud because the input is a long document. */
  | 'summarization-long-document'
  /** Cost budget moved a cloud decision to on-device. */
  | 'budget-cost'
  /** Latency budget moved an on-device decision to cloud. */
  | 'budget-latency'
  /** A budget could not be met and no better within-budget mode existed; kept the best available. */
  | 'budget-unmet';

/** The result of {@link decide}. */
export interface DecideResult {
  /** Final routing mode. */
  mode: RoutingMode;
  /** Human-readable explanation, surfaced to callers as `routingReason`. */
  reason: string;
  /** Stable machine-readable deciding factor. */
  code: DecisionCode;
  /**
   * The mode preferred by the taxonomy/heuristic before capability and budget
   * checks — informational, useful for debugging why `mode` differs.
   */
  preferredMode: PreferredMode;
}
