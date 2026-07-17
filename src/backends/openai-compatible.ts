/**
 * Generic adapter for any OpenAI-wire-compatible chat-completions endpoint
 * (OpenAI, Together, Groq, OpenRouter, a local llama.cpp/vLLM server, …).
 *
 * The request and response are already OpenAI-shaped, so this adapter is mostly
 * transport + normalization. For the native Anthropic Messages API (a different
 * wire shape) use {@link anthropicBackend} instead of pointing this at the
 * Anthropic OpenAI-compat shim.
 */

import { BackendError } from '../errors';
import type {
  Backend,
  BackendCallOptions,
  ChatCompletionChoice,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ToolCall,
  Usage,
} from '../types';
import { generateId, nowUnix } from './util';

/** Configuration for {@link openaiCompatibleBackend}. */
export interface OpenAICompatibleBackendConfig {
  /** Base URL of the API, e.g. `'https://api.openai.com/v1'`. Trailing slash optional. */
  baseURL: string;
  /** API key sent as `Authorization: Bearer <apiKey>`. Omit for unauthenticated local servers. */
  apiKey?: string;
  /** Default model id, used when a request does not specify one. */
  model?: string;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /** Path appended to `baseURL` for chat completions. Default `'/chat/completions'`. */
  path?: string;
  /** Backend id surfaced in errors/reasons. Default `'openai-compatible'`. */
  id?: string;
  /** Injectable fetch implementation (for testing). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

interface RawChoice {
  index?: number;
  message?: { content?: string | null; tool_calls?: ToolCall[] };
  finish_reason?: ChatCompletionChoice['finish_reason'];
}

interface RawResponse {
  id?: string;
  created?: number;
  model?: string;
  choices?: RawChoice[];
  usage?: Partial<Usage>;
}

export function openaiCompatibleBackend(config: OpenAICompatibleBackendConfig): Backend {
  const id = config.id ?? 'openai-compatible';
  const path = config.path ?? '/chat/completions';
  const url = `${config.baseURL.replace(/\/$/, '')}${path}`;
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

      const model = request.model ?? config.model;
      const body: Record<string, unknown> = {
        model,
        messages: request.messages,
      };
      if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
      if (request.temperature !== undefined) body.temperature = request.temperature;
      if (request.top_p !== undefined) body.top_p = request.top_p;
      if (request.stop !== undefined) body.stop = request.stop;
      if (request.tools !== undefined) body.tools = request.tools;

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...config.headers,
      };
      if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

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
        const responseBody = await safeReadText(response);
        throw new BackendError(`${id} returned HTTP ${response.status}.`, {
          backendId: id,
          status: response.status,
          responseBody,
        });
      }

      const data = (await response.json()) as RawResponse;
      if (!Array.isArray(data.choices) || data.choices.length === 0) {
        throw new BackendError(`${id} returned no choices.`, { backendId: id });
      }

      return {
        id: data.id ?? generateId('chatcmpl'),
        object: 'chat.completion',
        created: data.created ?? nowUnix(),
        model: data.model ?? model ?? 'unknown',
        choices: data.choices.map((choice, index) => {
          const message: ChatCompletionChoice['message'] = {
            role: 'assistant',
            content: choice.message?.content ?? null,
          };
          if (choice.message?.tool_calls) message.tool_calls = choice.message.tool_calls;
          return {
            index: choice.index ?? index,
            message,
            finish_reason: choice.finish_reason ?? null,
          };
        }),
        usage: data.usage
          ? {
              prompt_tokens: data.usage.prompt_tokens ?? 0,
              completion_tokens: data.usage.completion_tokens ?? 0,
              total_tokens:
                data.usage.total_tokens ??
                (data.usage.prompt_tokens ?? 0) + (data.usage.completion_tokens ?? 0),
            }
          : undefined,
      };
    },
  };
}

async function safeReadText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}
