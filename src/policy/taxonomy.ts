/**
 * Task-type taxonomy and preferred-mode resolution.
 *
 * The taxonomy table below is identical to the one in `local-first-llm` and
 * `local-first-llm-android`:
 *
 * | hint            | default preferred mode |
 * |-----------------|------------------------|
 * | classification  | on-device              |
 * | extraction      | on-device              |
 * | summarization   | on-device (long documents override toward cloud) |
 * | chat            | cloud                  |
 * | reasoning       | cloud                  |
 * | creative        | cloud                  |
 * | (no hint)       | heuristic: short input + no tools + modest max output → on-device; else cloud |
 */

import type {
  EstimateConfig,
  HeuristicConfig,
  PolicyConfig,
  PreferredMode,
  RequestShape,
  ResolvedPolicyConfig,
  TaskHint,
} from './types';

/** The default hint → preferred-mode table. */
export const DEFAULT_TAXONOMY: Record<TaskHint, PreferredMode> = {
  classification: 'on-device',
  extraction: 'on-device',
  summarization: 'on-device',
  chat: 'cloud',
  reasoning: 'cloud',
  creative: 'cloud',
};

/** Default heuristic thresholds. */
export const DEFAULT_HEURISTICS: HeuristicConfig = {
  shortInputMaxChars: 280,
  modestMaxOutputTokens: 256,
  longDocumentChars: 8000,
};

/** Default per-mode cost/latency estimates used by budget checks. */
export const DEFAULT_ESTIMATES: EstimateConfig = {
  cloudCost: 1,
  onDeviceCost: 0,
  cloudLatencyMs: 800,
  onDeviceFullLatencyMs: 1500,
  onDeviceDegradedLatencyMs: 5000,
};

/** Merge user overrides over the built-in defaults into a fully-resolved config. */
export function resolvePolicyConfig(config?: PolicyConfig): ResolvedPolicyConfig {
  return {
    taxonomy: { ...DEFAULT_TAXONOMY, ...config?.taxonomy },
    heuristics: { ...DEFAULT_HEURISTICS, ...config?.heuristics },
    estimates: { ...DEFAULT_ESTIMATES, ...config?.estimates },
  };
}

/**
 * Compute the input size in characters from message content. Handles plain
 * string content and OpenAI-style content-part arrays (`{ type: 'text', text }`);
 * non-text parts contribute nothing.
 */
export function computeInputChars(messages: RequestShape['messages']): number {
  if (!messages) return 0;
  let total = 0;
  for (const message of messages) {
    const { content } = message;
    if (typeof content === 'string') {
      total += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (
          part &&
          typeof part === 'object' &&
          typeof (part as { text?: unknown }).text === 'string'
        ) {
          total += (part as { text: string }).text.length;
        }
      }
    }
  }
  return total;
}

/** A request normalized to just the signals the heuristics need. */
export interface NormalizedRequest {
  inputChars: number;
  hasTools: boolean;
  /** `undefined` means the caller did not set an output cap. */
  maxOutputTokens: number | undefined;
}

/** Derive the heuristic signals from a (possibly undefined) request shape. */
export function normalizeRequest(request?: RequestShape): NormalizedRequest {
  const inputChars = request?.inputChars ?? computeInputChars(request?.messages);
  const hasTools =
    request?.hasTools ?? (request?.toolCount !== undefined ? request.toolCount > 0 : false);
  return {
    inputChars,
    hasTools,
    maxOutputTokens: request?.maxOutputTokens,
  };
}

/** Outcome of resolving the preferred mode, with why-flags for reason strings. */
export interface PreferredResolution {
  preferredMode: PreferredMode;
  /** True when no hint was given and the heuristic decided. */
  usedHeuristic: boolean;
  /** True when a `summarization` hint was overridden toward cloud by the long-document rule. */
  summarizationOverride: boolean;
}

/**
 * The hint-absent heuristic: a request with short input, no tools, and no
 * explicitly large output cap looks like a cheap classification/extraction call
 * and is treated as on-device; anything else is treated like chat (cloud).
 *
 * "modest max output" is satisfied when the caller either set no output cap or
 * set one at/below the threshold — an *explicitly large* cap is what disqualifies.
 */
export function inferHintlessPreference(
  request: NormalizedRequest,
  heuristics: HeuristicConfig,
): PreferredMode {
  const shortInput = request.inputChars <= heuristics.shortInputMaxChars;
  const noTools = !request.hasTools;
  const outputNotLarge =
    request.maxOutputTokens === undefined ||
    request.maxOutputTokens <= heuristics.modestMaxOutputTokens;
  return shortInput && noTools && outputNotLarge ? 'on-device' : 'cloud';
}

/**
 * Resolve the preferred mode from the taxonomy table (when a hint is present)
 * or the heuristic (when it is absent), applying the summarization
 * long-document override.
 */
export function resolvePreferredMode(
  hint: TaskHint | undefined,
  request: NormalizedRequest,
  config: ResolvedPolicyConfig,
): PreferredResolution {
  if (hint === undefined) {
    return {
      preferredMode: inferHintlessPreference(request, config.heuristics),
      usedHeuristic: true,
      summarizationOverride: false,
    };
  }

  const tablePreference = config.taxonomy[hint];

  // Summarization defaults to on-device, but a long document is a known reason
  // to override toward cloud. Only applies when the table still prefers
  // on-device (a user override of the row is respected as-is).
  if (
    hint === 'summarization' &&
    tablePreference === 'on-device' &&
    request.inputChars >= config.heuristics.longDocumentChars
  ) {
    return { preferredMode: 'cloud', usedHeuristic: false, summarizationOverride: true };
  }

  return { preferredMode: tablePreference, usedHeuristic: false, summarizationOverride: false };
}
