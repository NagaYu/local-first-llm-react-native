/**
 * Native Anthropic Messages API backend.
 *
 * This is a *native* adapter for `POST /v1/messages`, not the OpenAI-compat
 * shim. It handles the wire differences explicitly, with the same rigor as the
 * Anthropic adapters in the sibling `local-first-llm` / `local-first-llm-android`
 * projects:
 *
 *   - `max_tokens` is **required** by the API (defaulted here if the caller omits it).
 *   - the system prompt is a **top-level `system` parameter**, not a message.
 *   - assistant tool calls are **`tool_use` content blocks**, and OpenAI `tool`
 *     result messages become **`tool_result` content blocks** on a user turn —
 *     not `tool_calls`.
 *   - `stop_reason` is mapped explicitly to an OpenAI `finish_reason`.
 */

import { BackendError } from '../errors';
import type {
  Backend,
  BackendCallOptions,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  FinishReason,
  ToolCall,
} from '../types';
import { contentToString, generateId, nowUnix, toStopSequences } from './util';

/** Configuration for {@link anthropicBackend}. */
export interface AnthropicBackendConfig {
  /** Anthropic API key, sent as the `x-api-key` header. */
  apiKey: string;
  /** Default model id (e.g. `'claude-sonnet-5'`). Used when a request omits `model`. */
  model?: string;
  /** API base URL. Default `'https://api.anthropic.com'`. */
  baseURL?: string;
  /** `anthropic-version` header value. Default `'2023-06-01'`. */
  version?: string;
  /** `max_tokens` used when a request does not set one (the API requires it). Default `1024`. */
  maxTokens?: number;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /** Backend id surfaced in errors/reasons. Default `'anthropic'`. */
  id?: string;
  /** Injectable fetch implementation (for testing). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_VERSION = '2023-06-01';

// --- Native wire shapes (only the fields this adapter reads/writes) -----------

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | { type: string; [k: string]: unknown };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicResponse {
  id?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

// --- Request mapping ----------------------------------------------------------

/** Map an OpenAI tool definition to the Anthropic `tools` shape. */
function mapTool(tool: unknown): Record<string, unknown> | undefined {
  const fn = (tool as { function?: { name?: string; description?: string; parameters?: unknown } })
    ?.function;
  if (!fn?.name) return undefined;
  return {
    name: fn.name,
    ...(fn.description ? { description: fn.description } : {}),
    input_schema: fn.parameters ?? { type: 'object', properties: {} },
  };
}

/** Parse an OpenAI tool-call arguments string into an object (empty object on failure). */
function parseArguments(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

/** Turn an assistant message (possibly with tool_calls) into Anthropic content. */
function assistantContent(message: ChatMessage): string | AnthropicContentBlock[] {
  if (message.tool_calls && message.tool_calls.length > 0) {
    const blocks: AnthropicContentBlock[] = [];
    const text = contentToString(message.content);
    if (text) blocks.push({ type: 'text', text });
    for (const call of message.tool_calls) {
      blocks.push({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: parseArguments(call.function.arguments),
      });
    }
    return blocks;
  }
  return contentToString(message.content);
}

interface MappedRequest {
  system?: string;
  messages: AnthropicMessage[];
}

/**
 * Split OpenAI-shaped messages into a top-level `system` string and an
 * Anthropic `messages` array. `system` messages are concatenated; `tool`
 * messages become `tool_result` content blocks on a `user` turn.
 */
export function buildAnthropicMessages(messages: ChatMessage[]): MappedRequest {
  const systemParts: string[] = [];
  const mapped: AnthropicMessage[] = [];

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        systemParts.push(contentToString(message.content));
        break;
      case 'user':
        mapped.push({ role: 'user', content: contentToString(message.content) });
        break;
      case 'assistant':
        mapped.push({ role: 'assistant', content: assistantContent(message) });
        break;
      case 'tool':
        mapped.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.tool_call_id ?? '',
              content: contentToString(message.content),
            },
          ],
        });
        break;
    }
  }

  return {
    ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
    messages: mapped,
  };
}

// --- Response mapping ---------------------------------------------------------

/** Map an Anthropic `stop_reason` to an OpenAI `finish_reason`. */
export function mapStopReason(stopReason: string | null | undefined): FinishReason {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return null;
  }
}

/** Map an Anthropic response body to an OpenAI-shaped chat-completion response. */
export function mapAnthropicResponse(
  data: AnthropicResponse,
  fallbackModel: string,
): ChatCompletionResponse {
  const blocks = data.content ?? [];
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      textParts.push((block as AnthropicTextBlock).text);
    } else if (block.type === 'tool_use') {
      const toolBlock = block as AnthropicToolUseBlock;
      toolCalls.push({
        id: toolBlock.id,
        type: 'function',
        function: { name: toolBlock.name, arguments: JSON.stringify(toolBlock.input ?? {}) },
      });
    }
  }

  const content = textParts.length > 0 ? textParts.join('') : null;
  const message: ChatCompletionResponse['choices'][number]['message'] = {
    role: 'assistant',
    content,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const promptTokens = data.usage?.input_tokens ?? 0;
  const completionTokens = data.usage?.output_tokens ?? 0;

  return {
    id: data.id ?? generateId('msg'),
    object: 'chat.completion',
    created: nowUnix(),
    model: data.model ?? fallbackModel,
    choices: [{ index: 0, message, finish_reason: mapStopReason(data.stop_reason) }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

// --- Backend ------------------------------------------------------------------

export function anthropicBackend(config: AnthropicBackendConfig): Backend {
  const id = config.id ?? 'anthropic';
  const baseURL = (config.baseURL ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const url = `${baseURL}/v1/messages`;
  const version = config.version ?? DEFAULT_VERSION;
  const defaultMaxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const doFetch = config.fetch ?? globalThis.fetch;

  return {
    id,
    kind: 'cloud',

    async createChatCompletion(
      request: ChatCompletionRequest,
      options?: BackendCallOptions,
    ): Promise<ChatCompletionResponse> {
      if (typeof doFetch !== 'function') {
        throw new BackendError('No fetch implementation available.', { backendId: id });
      }

      const model = request.model ?? config.model ?? DEFAULT_MODEL;
      const { system, messages } = buildAnthropicMessages(request.messages);

      const body: Record<string, unknown> = {
        model,
        // max_tokens is required by the Messages API.
        max_tokens: request.max_tokens ?? defaultMaxTokens,
        messages,
      };
      if (system !== undefined) body.system = system;
      if (request.temperature !== undefined) body.temperature = request.temperature;
      if (request.top_p !== undefined) body.top_p = request.top_p;
      const stopSequences = toStopSequences(request.stop);
      if (stopSequences !== undefined) body.stop_sequences = stopSequences;
      if (request.tools !== undefined) {
        const tools = request.tools.map(mapTool).filter(Boolean);
        if (tools.length > 0) body.tools = tools;
      }

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': version,
        ...config.headers,
      };

      let response: Response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: options?.signal,
        });
      } catch (cause) {
        throw new BackendError(`Request to ${id} failed: ${(cause as Error)?.message ?? cause}`, {
          backendId: id,
          cause,
        });
      }

      if (!response.ok) {
        let responseBody: string | undefined;
        try {
          responseBody = await response.text();
        } catch {
          responseBody = undefined;
        }
        throw new BackendError(`${id} returned HTTP ${response.status}.`, {
          backendId: id,
          status: response.status,
          responseBody,
        });
      }

      const data = (await response.json()) as AnthropicResponse;
      return mapAnthropicResponse(data, model);
    },
  };
}
