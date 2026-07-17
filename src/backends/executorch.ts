/**
 * On-device backend wrapping `react-native-executorch`'s imperative `LLMModule`.
 *
 * `react-native-executorch` is an **optional peer dependency**. It is loaded
 * lazily via `require` inside {@link executorchBackend} so that consumers who
 * only use the cloud path never need it installed — importing this module, or
 * the package root, does not pull it in. The wrapped API (verified against
 * `react-native-executorch` ≥ 0.9) is:
 *
 *   - `LLMModule.fromModelName({ modelName, modelSource, tokenizerSource,
 *     tokenizerConfigSource, capabilities? }, onDownloadProgress?, tokenCallback?)`
 *     and `LLMModule.fromCustomModel(...)` load a model.
 *   - `generate(messages, tools?) => Promise<string>` runs a stateless completion
 *     (it does not manage conversation context — the router passes full messages).
 *   - a `tokenCallback` streams token batches; `configure({ generationConfig })`
 *     sets sampling params; `interrupt()` stops generation; `delete()` frees the
 *     model; `getPromptTokensCount()` / `getGeneratedTokenCount()` report usage.
 *
 * `react-native-executorch` exposes no `max_tokens` in its generation config, so
 * that limit is enforced here by watching the streamed token count and calling
 * `interrupt()` (which may emit one more token) — the result's `finish_reason`
 * is then `'length'`.
 */

// Module-scoped ambient declaration for the CommonJS `require` used to lazily
// load the optional peer. Kept local to this file so no standalone `.d.ts` is
// emitted; Metro/CommonJS provides `require` at runtime in React Native.
declare const require: (moduleName: string) => unknown;

import { BackendError } from '../errors';
import type { Capability } from '../policy/types';
import type {
  Backend,
  BackendCallOptions,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
} from '../types';
import { generateId, nowUnix } from './util';

/** A fetchable resource: a URL string, a `require()`d asset id, or a `{ uri }`. */
export type ExecutorchResourceSource = string | number | { uri: string };

/** Sampling / batching parameters forwarded to `LLMModule.configure({ generationConfig })`. */
export interface ExecutorchGenerationConfig {
  temperature?: number;
  topP?: number;
  minP?: number;
  repetitionPenalty?: number;
  outputTokenBatchSize?: number;
  batchTimeInterval?: number;
}

/** A model descriptor — a prebuilt constant (e.g. `LLAMA3_2_3B`) or explicit sources. */
export interface ExecutorchModelSources {
  modelName?: string;
  modelSource: ExecutorchResourceSource;
  tokenizerSource: ExecutorchResourceSource;
  tokenizerConfigSource: ExecutorchResourceSource;
  capabilities?: readonly ('vision' | 'audio')[];
}

/** The slice of `react-native-executorch`'s `LLMModule` instance this backend uses. */
export interface ExecutorchLLMModule {
  generate(messages: { role: string; content: string }[], tools?: object[]): Promise<string>;
  configure?(config: { generationConfig?: ExecutorchGenerationConfig }): void;
  setTokenCallback?(config: { tokenCallback: (token: string) => void }): void;
  interrupt?(): void;
  delete?(): void;
  getPromptTokensCount?(): number;
  getGeneratedTokenCount?(): number;
}

/** The static factory surface of `react-native-executorch`'s `LLMModule`. */
export interface ExecutorchLLMModuleStatic {
  fromModelName(
    namedSources: ExecutorchModelSources,
    onDownloadProgress?: (progress: number) => void,
    tokenCallback?: (token: string) => void,
  ): Promise<ExecutorchLLMModule>;
}

/** Configuration for {@link executorchBackend}. */
export interface ExecutorchBackendConfig {
  /** A prebuilt model descriptor, or explicit sources (`modelName` defaults to `'custom'`). */
  model?: ExecutorchModelSources;
  /** Shorthand: the model binary source for a custom exported `.pte` model. */
  modelSource?: ExecutorchResourceSource;
  /** Shorthand: the tokenizer JSON source (with `modelSource` + `tokenizerConfigSource`). */
  tokenizerSource?: ExecutorchResourceSource;
  /** Shorthand: the tokenizer config JSON source (with `modelSource` + `tokenizerSource`). */
  tokenizerConfigSource?: ExecutorchResourceSource;
  /** Model id echoed back in responses. Default `'executorch'`. */
  modelName?: string;
  /** Default sampling/batching parameters, merged with per-request `temperature`/`top_p`. */
  generationConfig?: ExecutorchGenerationConfig;
  /** Download progress callback (0..1) forwarded to the loader. */
  onDownloadProgress?: (progress: number) => void;
  /** Backend id surfaced in errors/reasons. Default `'executorch'`. */
  id?: string;
  /** Advanced/testing: inject a preloaded module instance (bypasses `react-native-executorch`). */
  module?: ExecutorchLLMModule;
  /** Advanced/testing: a custom loader returning a module instance. */
  loadModule?: () => Promise<ExecutorchLLMModule>;
}

/**
 * Map OpenAI-shaped messages to the executorch message shape. Executorch only
 * knows `system` / `user` / `assistant` roles, so an OpenAI `tool` result
 * message is folded into a `user` turn. `null` content becomes an empty string.
 */
export function toExecutorchMessages(messages: ChatMessage[]): { role: string; content: string }[] {
  return messages.map((message) => ({
    role: message.role === 'tool' ? 'user' : message.role,
    content: message.content ?? '',
  }));
}

/** Merge default generation config with per-request `temperature`/`top_p`. */
export function mergeGenerationConfig(
  base: ExecutorchGenerationConfig | undefined,
  request: ChatCompletionRequest,
): ExecutorchGenerationConfig | undefined {
  const merged: ExecutorchGenerationConfig = { ...base };
  if (request.temperature !== undefined) merged.temperature = request.temperature;
  if (request.top_p !== undefined) merged.topP = request.top_p;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function safeCount(fn: (() => number) | undefined): number {
  if (!fn) return 0;
  try {
    return fn() || 0;
  } catch {
    return 0;
  }
}

export function executorchBackend(config: ExecutorchBackendConfig): Backend {
  const id = config.id ?? 'executorch';

  let loaded: ExecutorchLLMModule | undefined;
  let modulePromise: Promise<ExecutorchLLMModule> | undefined;
  let currentOnToken: ((token: string) => void) | undefined;
  let currentMaxTokens: number | undefined;
  let truncatedByMaxTokens = false;

  const forwardToken = (token: string): void => {
    currentOnToken?.(token);
    if (
      loaded &&
      currentMaxTokens !== undefined &&
      safeCount(loaded.getGeneratedTokenCount?.bind(loaded)) >= currentMaxTokens
    ) {
      truncatedByMaxTokens = true;
      loaded.interrupt?.();
    }
  };

  function resolveSources(): ExecutorchModelSources {
    if (config.model) {
      return { modelName: config.model.modelName ?? 'custom', ...config.model };
    }
    if (config.modelSource && config.tokenizerSource && config.tokenizerConfigSource) {
      return {
        modelName: config.modelName ?? 'custom',
        modelSource: config.modelSource,
        tokenizerSource: config.tokenizerSource,
        tokenizerConfigSource: config.tokenizerConfigSource,
      };
    }
    throw new BackendError(
      'executorchBackend requires either a `model` descriptor or `modelSource` + `tokenizerSource` + `tokenizerConfigSource`.',
      { backendId: id },
    );
  }

  function requireExecutorch(): ExecutorchLLMModuleStatic {
    let mod: { LLMModule?: ExecutorchLLMModuleStatic };
    try {
      mod = require('react-native-executorch') as { LLMModule?: ExecutorchLLMModuleStatic };
    } catch (cause) {
      throw new BackendError(
        'react-native-executorch is not installed. It is an optional peer dependency required only by executorchBackend — install it to use the on-device path, or configure a cloud backend only.',
        { backendId: id, cause },
      );
    }
    if (!mod?.LLMModule) {
      throw new BackendError(
        'react-native-executorch did not export LLMModule (unexpected version?).',
        { backendId: id },
      );
    }
    return mod.LLMModule;
  }

  async function load(): Promise<ExecutorchLLMModule> {
    if (config.module) {
      loaded = config.module;
    } else if (config.loadModule) {
      loaded = await config.loadModule();
    } else {
      const LLMModule = requireExecutorch();
      loaded = await LLMModule.fromModelName(
        resolveSources(),
        config.onDownloadProgress ?? (() => {}),
        forwardToken,
      );
    }
    loaded.setTokenCallback?.({ tokenCallback: forwardToken });
    return loaded;
  }

  function ensureLoaded(): Promise<ExecutorchLLMModule> {
    if (!modulePromise) {
      modulePromise = load().catch((error) => {
        // Reset so a later call can retry loading (e.g. after fixing config).
        modulePromise = undefined;
        throw error;
      });
    }
    return modulePromise;
  }

  return {
    id,
    kind: 'on-device',

    async createChatCompletion(
      request: ChatCompletionRequest,
      options?: BackendCallOptions,
    ): Promise<ChatCompletionResponse> {
      const module = await ensureLoaded();

      const generationConfig = mergeGenerationConfig(config.generationConfig, request);
      if (generationConfig && module.configure) {
        module.configure({ generationConfig });
      }

      currentOnToken = options?.onToken;
      currentMaxTokens = request.max_tokens;
      truncatedByMaxTokens = false;

      let text: string;
      try {
        text = await module.generate(
          toExecutorchMessages(request.messages),
          request.tools as object[] | undefined,
        );
      } catch (cause) {
        throw new BackendError(
          `On-device generation failed: ${(cause as Error)?.message ?? cause}`,
          {
            backendId: id,
            cause,
          },
        );
      } finally {
        currentOnToken = undefined;
        currentMaxTokens = undefined;
      }

      const promptTokens = safeCount(module.getPromptTokensCount?.bind(module));
      const completionTokens = safeCount(module.getGeneratedTokenCount?.bind(module));

      return {
        id: generateId('exec'),
        object: 'chat.completion',
        created: nowUnix(),
        model: request.model ?? config.modelName ?? 'executorch',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: truncatedByMaxTokens ? 'length' : 'stop',
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };
    },

    async probeCapability(): Promise<Capability> {
      try {
        await ensureLoaded();
        // Load success is the only honest signal react-native-executorch exposes;
        // it cannot distinguish full from degraded. See capability/builtin.ts.
        return 'on-device-full';
      } catch {
        return 'not-viable';
      }
    },

    async dispose(): Promise<void> {
      try {
        loaded?.interrupt?.();
        loaded?.delete?.();
      } catch {
        // best-effort cleanup
      }
      loaded = undefined;
      modulePromise = undefined;
    },
  };
}
