/**
 * The router: ties the policy engine to the configured backends.
 *
 * `router.chat.completions.create(...)` runs `decide()`, dispatches to the
 * on-device or cloud backend, applies one bounded cross-mode retry on failure,
 * and returns an OpenAI-shaped response annotated with `routedTo` /
 * `routingReason`. The surface mirrors `local-first-llm` (web) so the mental
 * model carries over.
 */

import { builtinCapabilityProvider } from './capability/builtin';
import { NoBackendError, RoutingBlockedError } from './errors';
import { decide } from './policy/decide';
import type { Capability, DecideInput, Privacy } from './policy/types';
import type {
  Backend,
  BackendKind,
  CapabilityProvider,
  ChatCompletionCreateParams,
  ChatCompletionRequest,
  Router,
  RouterChatResult,
  RouterConfig,
} from './types';

/** Whether a request may be (re)routed to `mode`, honoring the sensitive-privacy guarantee. */
function canUseMode(mode: BackendKind, privacy: Privacy, capability: Capability): boolean {
  if (mode === 'cloud') {
    // Never send a sensitive request to the cloud — not even as a fallback.
    return privacy !== 'sensitive';
  }
  // On-device is only usable when capability allows it.
  return capability === 'on-device-full' || capability === 'on-device-degraded';
}

/** Build the pure {@link DecideInput} from create() params and the resolved capability. */
function toDecideInput(params: ChatCompletionCreateParams, capability: Capability): DecideInput {
  return {
    capability,
    hint: params.hint,
    privacy: params.privacy,
    costBudget: params.costBudget,
    latencyBudget: params.latencyBudget,
    request: {
      messages: params.messages,
      hasTools: Array.isArray(params.tools) && params.tools.length > 0,
      maxOutputTokens: params.max_tokens,
    },
  };
}

/** Strip routing/transport fields, leaving a plain OpenAI-shaped request for a backend. */
function toBackendRequest(params: ChatCompletionCreateParams): ChatCompletionRequest {
  const request: ChatCompletionRequest = { messages: params.messages };
  if (params.model !== undefined) request.model = params.model;
  if (params.max_tokens !== undefined) request.max_tokens = params.max_tokens;
  if (params.temperature !== undefined) request.temperature = params.temperature;
  if (params.top_p !== undefined) request.top_p = params.top_p;
  if (params.stop !== undefined) request.stop = params.stop;
  if (params.tools !== undefined) request.tools = params.tools;
  return request;
}

export function createRouter(config: RouterConfig): Router {
  const capabilityProvider: CapabilityProvider =
    config.capability ?? builtinCapabilityProvider({ backend: config.onDevice });
  const fallbackEnabled = config.fallback?.enabled ?? true;

  const backendFor = (mode: BackendKind): Backend | undefined =>
    mode === 'on-device' ? config.onDevice : config.cloud;

  return {
    chat: {
      completions: {
        async create(params: ChatCompletionCreateParams): Promise<RouterChatResult> {
          const privacy: Privacy = params.privacy ?? 'normal';
          const capability: Capability =
            params.capability ?? (await capabilityProvider.getCapability(toBackendRequest(params)));

          const decision = decide(toDecideInput(params, capability), config.policy);

          if (decision.mode === 'blocked') {
            throw new RoutingBlockedError(decision.reason);
          }

          const primaryMode = decision.mode;
          const request = toBackendRequest(params);
          const callOptions = { signal: params.signal, onToken: params.onToken };

          // Ordered attempt list: primary, then (at most) the other mode once.
          const attempts: BackendKind[] = [primaryMode];
          if (fallbackEnabled) {
            const other: BackendKind = primaryMode === 'on-device' ? 'cloud' : 'on-device';
            if (canUseMode(other, privacy, capability)) {
              attempts.push(other);
            }
          }

          let lastError: unknown;
          let sawBackend = false;

          for (let i = 0; i < attempts.length; i++) {
            const mode = attempts[i];
            if (!mode) continue;
            const backend = backendFor(mode);
            if (!backend) {
              // Remember why the primary was unusable so a later fallback can explain it.
              lastError =
                lastError ?? new NoBackendError(mode, `No backend configured for '${mode}'.`);
              continue;
            }
            sawBackend = true;

            try {
              const response = await backend.createChatCompletion(request, callOptions);
              const fellBack = i > 0;
              return {
                ...response,
                routedTo: mode,
                routingCode: decision.code,
                routingReason: fellBack
                  ? `${decision.reason} Primary route '${primaryMode}' did not succeed (${errorMessage(lastError)}); served by '${mode}' instead.`
                  : decision.reason,
                fellBack,
              };
            } catch (error) {
              lastError = error;
            }
          }

          if (!sawBackend) {
            throw new NoBackendError(
              primaryMode,
              `Policy chose '${primaryMode}', but no usable backend is configured for it${
                fallbackEnabled ? ' and no fallback was available' : ' (fallback disabled)'
              }. Reason: ${decision.reason}`,
            );
          }
          throw lastError;
        },
      },
    },

    async dispose(): Promise<void> {
      await Promise.all(
        [config.onDevice, config.cloud].map(async (backend) => {
          try {
            await backend?.dispose?.();
          } catch {
            // best-effort
          }
        }),
      );
    },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
