/**
 * Minimal reference app for `local-first-llm-react-native`.
 *
 * It wires an on-device backend (react-native-executorch) and a cloud backend
 * (any OpenAI-compatible endpoint) into one router, then shows how the same call
 * site is routed differently by task type and privacy — `routedTo` and
 * `routingReason` are surfaced on every result.
 *
 * NOTE: the on-device path requires a real device/simulator with an ExecuTorch
 * model — see the repo's CONTRIBUTING.md. Set EXPO_PUBLIC_OPENAI_API_KEY (and
 * optionally EXPO_PUBLIC_OPENAI_BASE_URL) to exercise the cloud path.
 */

import { useMemo, useState } from 'react';
import { ActivityIndicator, Button, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LLAMA3_2_1B } from 'react-native-executorch';
import { createRouter } from 'local-first-llm-react-native';
import { executorchBackend } from 'local-first-llm-react-native/backends/executorch';
import { openaiCompatibleBackend } from 'local-first-llm-react-native/backends/openai-compatible';
import type { ChatCompletionCreateParams, RouterChatResult } from 'local-first-llm-react-native';

export default function App() {
  const router = useMemo(
    () =>
      createRouter({
        // Wraps react-native-executorch. `LLAMA3_2_1B` is a built-in model
        // descriptor exported by react-native-executorch (model + tokenizer
        // sources). Pick a backend/quantization that fits your target devices.
        onDevice: executorchBackend({ model: LLAMA3_2_1B }),
        cloud: openaiCompatibleBackend({
          baseURL: process.env.EXPO_PUBLIC_OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
          apiKey: process.env.EXPO_PUBLIC_OPENAI_API_KEY ?? '',
          model: 'gpt-4o-mini',
        }),
      }),
    [],
  );

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RouterChatResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(params: ChatCompletionCreateParams) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await router.chat.completions.create(params));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>local-first-llm-react-native</Text>
      <Text style={styles.subtitle}>Same call site, routed by policy.</Text>

      <View style={styles.buttons}>
        <Button
          title="Classify (→ on-device)"
          onPress={() =>
            run({
              hint: 'classification',
              messages: [{ role: 'user', content: 'Is "I love this app" positive or negative?' }],
            })
          }
        />
        <Button
          title="Chat (→ cloud)"
          onPress={() =>
            run({ hint: 'chat', messages: [{ role: 'user', content: 'Tell me a fun fact.' }] })
          }
        />
        <Button
          title="Sensitive (forced on-device or blocked)"
          onPress={() =>
            run({
              hint: 'summarization',
              privacy: 'sensitive',
              messages: [{ role: 'user', content: 'Summarize my private medical note: …' }],
            })
          }
        />
      </View>

      {busy && <ActivityIndicator style={styles.spinner} />}

      {error && (
        <View style={[styles.card, styles.errorCard]}>
          <Text style={styles.label}>Error / Blocked</Text>
          <Text style={styles.mono}>{error}</Text>
        </View>
      )}

      {result && (
        <View style={styles.card}>
          <Text style={styles.label}>routedTo</Text>
          <Text style={styles.mono}>
            {result.routedTo}
            {result.fellBack ? ' (fell back)' : ''}
          </Text>
          <Text style={styles.label}>routingReason</Text>
          <Text style={styles.mono}>{result.routingReason}</Text>
          <Text style={styles.label}>response</Text>
          <Text style={styles.mono}>{result.choices[0]?.message.content ?? '(no content)'}</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 64, gap: 12 },
  title: { fontSize: 20, fontWeight: '700' },
  subtitle: { fontSize: 14, color: '#666', marginBottom: 12 },
  buttons: { gap: 8 },
  spinner: { marginTop: 16 },
  card: { marginTop: 16, padding: 16, borderRadius: 12, backgroundColor: '#f2f2f7', gap: 4 },
  errorCard: { backgroundColor: '#fdecea' },
  label: { fontSize: 12, fontWeight: '600', color: '#888', marginTop: 8 },
  mono: { fontFamily: 'Courier', fontSize: 13 },
});
