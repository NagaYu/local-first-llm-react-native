import {
  anthropicBackend,
  buildAnthropicMessages,
  mapAnthropicResponse,
  mapStopReason,
} from '../../src/backends/anthropic';
import type { ChatCompletionRequest, ChatMessage } from '../../src/types';
import textResponse from '../fixtures/anthropic-text-response.json';
import toolUseResponse from '../fixtures/anthropic-tooluse-response.json';
import { createFakeFetch } from '../helpers/fake-fetch';

describe('buildAnthropicMessages — request mapping', () => {
  it('lifts system messages to a top-level system string (concatenated)', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are terse.' },
      { role: 'system', content: 'Answer in English.' },
      { role: 'user', content: 'Hi' },
    ];
    const { system, messages: mapped } = buildAnthropicMessages(messages);
    expect(system).toBe('You are terse.\n\nAnswer in English.');
    expect(mapped).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  it('omits system entirely when there are no system messages', () => {
    const { system } = buildAnthropicMessages([{ role: 'user', content: 'Hi' }]);
    expect(system).toBeUndefined();
  });

  it('maps assistant tool_calls to tool_use content blocks (not tool_calls)', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'Checking…',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"Tokyo"}' },
          },
        ],
      },
    ];
    const { messages: mapped } = buildAnthropicMessages(messages);
    expect(mapped[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Checking…' },
        { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { location: 'Tokyo' } },
      ],
    });
  });

  it('maps an OpenAI tool result message to a user tool_result block', () => {
    const messages: ChatMessage[] = [{ role: 'tool', content: '72F', tool_call_id: 'call_1' }];
    const { messages: mapped } = buildAnthropicMessages(messages);
    expect(mapped[0]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '72F' }],
    });
  });

  it('handles assistant tool_calls with no text (no empty text block)', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: 'not-json' } }],
      },
    ];
    const { messages: mapped } = buildAnthropicMessages(messages);
    // invalid JSON arguments degrade to {}
    expect(mapped[0].content).toEqual([{ type: 'tool_use', id: 'c', name: 'f', input: {} }]);
  });
});

describe('mapStopReason', () => {
  it.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['pause_turn', 'stop'],
    ['max_tokens', 'length'],
    ['tool_use', 'tool_calls'],
    ['refusal', 'content_filter'],
  ] as const)('maps %s → %s', (input, expected) => {
    expect(mapStopReason(input)).toBe(expected);
  });

  it('maps unknown/null stop reasons to null', () => {
    expect(mapStopReason('something-new')).toBeNull();
    expect(mapStopReason(null)).toBeNull();
    expect(mapStopReason(undefined)).toBeNull();
  });
});

describe('mapAnthropicResponse — response mapping', () => {
  it('maps a text response with token usage', () => {
    const res = mapAnthropicResponse(textResponse, 'fallback');
    expect(res.object).toBe('chat.completion');
    expect(res.id).toBe('msg_01ABC');
    expect(res.model).toBe('claude-sonnet-5');
    expect(res.choices[0].message.content).toBe('Hello there!');
    expect(res.choices[0].message.tool_calls).toBeUndefined();
    expect(res.choices[0].finish_reason).toBe('stop');
    expect(res.usage).toEqual({ prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 });
  });

  it('maps tool_use content blocks to OpenAI tool_calls with stringified arguments', () => {
    const res = mapAnthropicResponse(toolUseResponse, 'fallback');
    expect(res.choices[0].message.content).toBe('Let me check the weather.');
    const toolCall = res.choices[0].message.tool_calls?.[0];
    expect(toolCall).toEqual({
      id: 'toolu_01',
      type: 'function',
      function: { name: 'get_weather', arguments: JSON.stringify({ location: 'Tokyo' }) },
    });
    expect(res.choices[0].finish_reason).toBe('tool_calls');
  });

  it('produces null content when there is no text block', () => {
    const res = mapAnthropicResponse(
      { content: [{ type: 'tool_use', id: 't', name: 'n', input: {} }], stop_reason: 'tool_use' },
      'fallback',
    );
    expect(res.choices[0].message.content).toBeNull();
  });

  it('uses the fallback model when the body omits one', () => {
    const res = mapAnthropicResponse({ content: [], stop_reason: 'end_turn' }, 'fallback-model');
    expect(res.model).toBe('fallback-model');
  });
});

describe('anthropicBackend — createChatCompletion (native Messages API)', () => {
  const REQUEST: ChatCompletionRequest = {
    messages: [
      { role: 'system', content: 'Be helpful.' },
      { role: 'user', content: 'Hi' },
    ],
    temperature: 0.5,
    top_p: 0.8,
    stop: 'END',
  };

  it('sends x-api-key + anthropic-version, top-level system, and a defaulted max_tokens', async () => {
    const { fetch, calls } = createFakeFetch({ json: textResponse });
    const backend = anthropicBackend({ apiKey: 'ak-1', model: 'claude-sonnet-5', fetch });
    await backend.createChatCompletion(REQUEST);

    const call = calls[0];
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = call.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('ak-1');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(call.body).toMatchObject({
      model: 'claude-sonnet-5',
      max_tokens: 1024, // required by the API, defaulted here
      system: 'Be helpful.',
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0.5,
      top_p: 0.8,
      stop_sequences: ['END'],
    });
  });

  it('honors an explicit max_tokens and a config maxTokens default', async () => {
    const { fetch, calls } = createFakeFetch({ json: textResponse });
    const backend = anthropicBackend({ apiKey: 'ak', maxTokens: 512, fetch });
    await backend.createChatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
    expect((calls[0].body as { max_tokens: number }).max_tokens).toBe(512);

    const { fetch: fetch2, calls: calls2 } = createFakeFetch({ json: textResponse });
    const backend2 = anthropicBackend({ apiKey: 'ak', fetch: fetch2 });
    await backend2.createChatCompletion({
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 99,
    });
    expect((calls2[0].body as { max_tokens: number }).max_tokens).toBe(99);
  });

  it('maps OpenAI tools to Anthropic tools with input_schema', async () => {
    const { fetch, calls } = createFakeFetch({ json: textResponse });
    const backend = anthropicBackend({ apiKey: 'ak', fetch });
    await backend.createChatCompletion({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'gets weather',
            parameters: { type: 'object' },
          },
        },
      ],
    });
    expect((calls[0].body as { tools: unknown[] }).tools).toEqual([
      { name: 'get_weather', description: 'gets weather', input_schema: { type: 'object' } },
    ]);
  });

  it('returns a mapped OpenAI-shaped response from a fixture body', async () => {
    const { fetch } = createFakeFetch({ json: toolUseResponse });
    const backend = anthropicBackend({ apiKey: 'ak', fetch });
    const res = await backend.createChatCompletion(REQUEST);
    expect(res.choices[0].finish_reason).toBe('tool_calls');
    expect(res.choices[0].message.tool_calls?.[0].function.name).toBe('get_weather');
  });

  it('throws a BackendError with status on a non-2xx response', async () => {
    const { fetch } = createFakeFetch({ status: 400, text: '{"error":"bad"}' });
    const backend = anthropicBackend({ apiKey: 'ak', fetch });
    await expect(backend.createChatCompletion(REQUEST)).rejects.toMatchObject({
      name: 'BackendError',
      status: 400,
    });
  });
});
