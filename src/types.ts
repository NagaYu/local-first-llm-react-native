/**
 * Shared, OpenAI-chat-completions-shaped wire types and the backend contract.
 *
 * The public surface is deliberately shaped like `local-first-llm` (web) so a
 * developer who knows the web version feels at home — even though nothing is
 * shared under the hood.
 */

import type {
  Capability,
  DecisionCode,
  PolicyConfig,
  Privacy,
  RoutingMode,
  TaskHint,
} from './policy/types';

/** A tool/function call, OpenAI-shaped. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** A chat message, OpenAI-shaped. `content` may be `null` on assistant tool-call turns. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

/** Why generation stopped, OpenAI-shaped. */
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;

/** Token usage, OpenAI-shaped. */
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** A base chat-completion request (the OpenAI wire shape, minus routing metadata). */
export interface ChatCompletionRequest {
  messages: ChatMessage[];
  model?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: unknown[];
}

/** One completion choice, OpenAI-shaped. */
export interface ChatCompletionChoice {
  index: number;
  message: { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] };
  finish_reason: FinishReason;
}

/** A chat-completion response, OpenAI-shaped. Every backend maps its output into this shape. */
export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: Usage;
}

/** Whether a backend runs on-device or in the cloud. */
export type BackendKind = 'on-device' | 'cloud';

/** Per-call options passed through the router to a backend. */
export interface BackendCallOptions {
  /** Abort signal for cancelling an in-flight request. */
  signal?: AbortSignal;
  /** Streaming hook, invoked per token/token-batch when the backend supports it. */
  onToken?: (token: string) => void;
}

/**
 * The contract every backend implements. The router selects a backend from the
 * policy decision and calls {@link Backend.createChatCompletion}.
 */
export interface Backend {
  /** Stable identifier, surfaced in errors and reasons (e.g. `'executorch'`, `'openai-compatible'`). */
  readonly id: string;
  /** Whether this backend is the on-device or the cloud path. */
  readonly kind: BackendKind;
  /** Run a chat completion and return an OpenAI-shaped response. */
  createChatCompletion(
    request: ChatCompletionRequest,
    options?: BackendCallOptions,
  ): Promise<ChatCompletionResponse>;
  /**
   * Optional: report on-device viability, used by the built-in
   * {@link CapabilityProvider}. Only meaningful for on-device backends.
   */
  probeCapability?(): Promise<Capability> | Capability;
  /** Optional: release resources (e.g. free an on-device model from memory). */
  dispose?(): Promise<void> | void;
}

/**
 * Reports how viable on-device execution is. The built-in provider derives this
 * from the on-device backend (model-load success/failure); richer providers can
 * bridge to hardware-eligibility signals in the future.
 */
export interface CapabilityProvider {
  getCapability(request?: ChatCompletionRequest): Promise<Capability> | Capability;
}

/** Routing metadata added on top of a chat-completion request. */
export interface RoutingParams {
  /** Task-type hint that drives the taxonomy lookup. */
  hint?: TaskHint;
  /** Privacy classification; `'sensitive'` never silently reaches the cloud. */
  privacy?: Privacy;
  /** Optional cost ceiling (relative units). */
  costBudget?: number;
  /** Optional latency ceiling (ms). */
  latencyBudget?: number;
  /** Explicitly override the capability for this request instead of asking the provider. */
  capability?: Capability;
}

/** Parameters accepted by `router.chat.completions.create(...)`. */
export type ChatCompletionCreateParams = ChatCompletionRequest &
  RoutingParams & {
    /** Abort signal for cancelling an in-flight request. */
    signal?: AbortSignal;
    /** Streaming hook, invoked per token when the routed backend supports it. */
    onToken?: (token: string) => void;
  };

/** The router's result: an OpenAI-shaped response plus routing transparency fields. */
export interface RouterChatResult extends ChatCompletionResponse {
  /** Which backend actually served the request. */
  routedTo: BackendKind;
  /** Human-readable explanation of the routing decision (and any fallback). */
  routingReason: string;
  /** Stable machine-readable deciding factor from the policy engine. */
  routingCode: DecisionCode;
  /** True when the primary route failed and the request was served by a bounded retry on the other mode. */
  fellBack: boolean;
}

/** Fallback/resilience configuration. */
export interface FallbackConfig {
  /**
   * Whether one bounded retry against the *other* mode is attempted on failure.
   * A `'sensitive'` request is never retried against the cloud regardless. Default `true`.
   */
  enabled?: boolean;
}

/** Configuration for {@link createRouter}. */
export interface RouterConfig {
  /** On-device backend (e.g. `executorchBackend(...)`). */
  onDevice?: Backend;
  /** Cloud backend (e.g. `openaiCompatibleBackend(...)` or `anthropicBackend(...)`). */
  cloud?: Backend;
  /** Optional policy overrides (taxonomy rows, heuristic thresholds, estimates). */
  policy?: PolicyConfig;
  /** Optional capability provider. Defaults to one derived from the on-device backend. */
  capability?: CapabilityProvider;
  /** Optional fallback/resilience configuration. */
  fallback?: FallbackConfig;
}

/** The router returned by {@link createRouter}. */
export interface Router {
  chat: {
    completions: {
      create(params: ChatCompletionCreateParams): Promise<RouterChatResult>;
    };
  };
  /** Release resources held by the configured backends. */
  dispose(): Promise<void>;
}

export type { RoutingMode };
