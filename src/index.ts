/**
 * local-first-llm-react-native
 *
 * On-device vs. cloud routing policy for React Native LLM apps. The public
 * surface is intentionally shaped like `local-first-llm` (web) so the mental
 * model carries over, even though nothing is shared under the hood.
 *
 * Backends are also available as subpath imports so a cloud-only consumer never
 * loads the executorch adapter:
 *   - `local-first-llm-react-native/backends/executorch`
 *   - `local-first-llm-react-native/backends/openai-compatible`
 *   - `local-first-llm-react-native/backends/anthropic`
 *   - `local-first-llm-react-native/capability/builtin`
 */

// Router.
export { createRouter } from './router';

// Backends (also importable via subpaths).
export { executorchBackend } from './backends/executorch';
export { openaiCompatibleBackend } from './backends/openai-compatible';
export { anthropicBackend } from './backends/anthropic';

// Capability.
export { builtinCapabilityProvider } from './capability/builtin';

// Policy engine — the ported decision tree (pure, synchronous, zero I/O).
export { decide } from './policy/decide';
export {
  DEFAULT_ESTIMATES,
  DEFAULT_HEURISTICS,
  DEFAULT_TAXONOMY,
  resolvePolicyConfig,
} from './policy/taxonomy';

// Errors.
export { BackendError, NoBackendError, RoutingBlockedError } from './errors';

// Types — wire + backend contract.
export type {
  Backend,
  BackendCallOptions,
  BackendKind,
  CapabilityProvider,
  ChatCompletionChoice,
  ChatCompletionCreateParams,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  FinishReason,
  RoutingParams,
  Router,
  RouterChatResult,
  RouterConfig,
  FallbackConfig,
  ToolCall,
  Usage,
} from './types';

// Types — policy.
export type {
  Capability,
  DecideInput,
  DecideResult,
  DecisionCode,
  EstimateConfig,
  HeuristicConfig,
  PolicyConfig,
  PreferredMode,
  Privacy,
  RequestShape,
  ResolvedPolicyConfig,
  RoutingMode,
  TaskHint,
} from './policy/types';

// Types — backend configs.
export type {
  ExecutorchBackendConfig,
  ExecutorchGenerationConfig,
  ExecutorchModelSources,
  ExecutorchResourceSource,
} from './backends/executorch';
export type { OpenAICompatibleBackendConfig } from './backends/openai-compatible';
export type { AnthropicBackendConfig } from './backends/anthropic';
export type { BuiltinCapabilityProviderOptions } from './capability/builtin';
