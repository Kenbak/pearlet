import { useRef, useState, type ComponentRef } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { palette } from './PearlDesign';
import { isRecoveryWord, splitRecoveryWords } from './pearl-keys';

export const phraseLength = 12;
export const longPhraseLength = 24;

export function emptyPhrase(length: number = phraseLength): string[] {
  return Array.from({ length }, () => '');
}

/**
 * Numbered word fields, 12 by default or 24. Pasting several words into any
 * field spreads them across the fields; a full paste always starts at word 1,
 * and a paste of more than 12 words switches to 24 fields. Space or return
 * moves to the next field. Unknown words are outlined after the field loses focus.
 */
export default function PhraseInput({ words, onChange, editable = true, label = 'Recovery phrase' }: {
  words: readonly string[];
  onChange: (words: string[]) => void;
  editable?: boolean;
  label?: string;
}) {
  const inputs = useRef<(ComponentRef<typeof TextInput> | null)[]>([]);
  const [focused, setFocused] = useState<number | null>(null);
  const length = words.length;

  function resize(nextLength: number) {
    const next = emptyPhrase(nextLength);
    words.slice(0, nextLength).forEach((word, index) => {
      next[index] = word;
    });
    onChange(next);
  }

  function update(index: number, text: string) {
    const parts = splitRecoveryWords(text);
    if (parts.length > 1) {
      const fullPaste = parts.length >= phraseLength;
      const size = fullPaste && parts.length > phraseLength ? longPhraseLength : fullPaste ? phraseLength : length;
      const next = fullPaste ? emptyPhrase(size) : [...words];
      const start = fullPaste ? 0 : index;
      parts.slice(0, size - start).forEach((word, offset) => {
        next[start + offset] = word;
      });
      onChange(next);
      if (start + parts.length >= size) inputs.current[index]?.blur();
      else inputs.current[Math.min(start + parts.length, size - 1)]?.focus();
      return;
    }
    const next = [...words];
    const advance = /\s$/.test(text) && parts.length === 1;
    next[index] = parts[0] ?? '';
    onChange(next);
    if (advance && index < length - 1) inputs.current[index + 1]?.focus();
  }

  return (
    <View style={styles.wrap}>
    <View style={styles.lengthRow} accessibilityRole="radiogroup">
      {[phraseLength, longPhraseLength].map((option) => (
        <Pressable
          key={option}
          accessibilityRole="radio"
          accessibilityState={{ selected: length === option, disabled: !editable }}
          disabled={!editable}
          hitSlop={6}
          onPress={() => length !== option && resize(option)}
          style={[styles.lengthOption, length === option && styles.lengthOptionSelected]}
        >
          <Text style={[styles.lengthText, length === option && styles.lengthTextSelected]}>{option} words</Text>
        </Pressable>
      ))}
    </View>
    <View accessibilityLabel={label} style={styles.grid}>
      {words.map((word, index) => {
        const invalid = Boolean(word) && focused !== index && !isRecoveryWord(word);
        return (
          <View key={index} style={[styles.cell, focused === index && styles.cellFocused, invalid && styles.cellInvalid]}>
            <Text style={styles.index}>{index + 1}</Text>
            <TextInput
              ref={(ref) => {
                inputs.current[index] = ref;
              }}
              accessibilityLabel={'Word ' + (index + 1) + (invalid ? ', not a recovery word' : '')}
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect={false}
              blurOnSubmit={index === length - 1}
              editable={editable}
              importantForAutofill="no"
              keyboardType={Platform.OS === 'ios' ? 'ascii-capable' : 'visible-password'}
              onBlur={() => setFocused((current) => (current === index ? null : current))}
              onChangeText={(text) => update(index, text)}
              onFocus={() => setFocused(index)}
              onSubmitEditing={() => inputs.current[index + 1]?.focus()}
              returnKeyType={index === length - 1 ? 'done' : 'next'}
              spellCheck={false}
              style={styles.input}
              textContentType="none"
              value={word}
            />
          </View>
        );
      })}
    </View>
    </View>
  );
}

export function phraseFromWords(words: readonly string[]): string {
  return words.map((word) => word.trim()).filter(Boolean).join(' ');
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  lengthRow: { flexDirection: 'row', alignSelf: 'center', gap: 4, padding: 3, borderRadius: 999, backgroundColor: 'rgba(22, 19, 31, 0.05)' },
  lengthOption: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999 },
  lengthOptionSelected: { backgroundColor: 'rgba(255, 255, 255, 0.92)' },
  lengthText: { color: palette.muted, fontSize: 13, fontWeight: '500' },
  lengthTextSelected: { color: palette.ink, fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: {
    flexBasis: '45%',
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingLeft: 11,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: 'rgba(22, 19, 31, 0.08)',
    backgroundColor: palette.glassStrong,
  },
  cellFocused: { borderColor: 'rgba(22, 19, 31, 0.28)', backgroundColor: 'rgba(255, 255, 255, 0.9)' },
  cellInvalid: { borderColor: 'rgba(164, 56, 86, 0.55)' },
  index: { width: 18, color: palette.faint, fontSize: 12, fontVariant: ['tabular-nums'] },
  input: { flex: 1, paddingVertical: 10, paddingRight: 10, color: palette.ink, fontSize: 15, fontWeight: '500' },
});
