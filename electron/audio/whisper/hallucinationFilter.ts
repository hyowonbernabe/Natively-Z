/**
 * Filters common Whisper hallucinations.
 * Returns an empty string if the text is a known hallucination,
 * otherwise returns the trimmed text.
 */

const EXACT_BLOCKS = new Set([
  '[music]',
  '[applause]',
  '[inaudible]',
  '(music)',
  'thank you for watching',
  'thanks for watching',
  'you',
  'bye',
  '...',
  '.',
]);

// Matches any token that is entirely wrapped in square brackets e.g. [Noise], [BLANK_AUDIO]
const BRACKET_TOKEN_RE = /^\[.*\]$/;

/**
 * Personal build (Natively Z): Whisper decoding loops ("sa pangalawang sa pangalawang sa pangalawang …").
 * Measured on FLEURS Tagalog with whisper-large-v3-turbo: 192% WER raw → 24.5% with loops collapsed.
 * A phrase of 2–8 words repeated 3+ times in a row keeps one copy; a single word needs 4+ repeats, so
 * natural speech like "no, no, no" survives.
 */
export function collapseLoops(text: string): string {
  let words = text.split(/\s+/).filter(Boolean);
  for (let n = 1; n <= 8; n++) {
    const minReps = n === 1 ? 4 : 3;
    const out: string[] = [];
    for (let i = 0; i < words.length;) {
      const gram = words.slice(i, i + n).join(' ').toLowerCase();
      let j = i + n;
      let reps = 1;
      while (j + n <= words.length && words.slice(j, j + n).join(' ').toLowerCase() === gram) { reps++; j += n; }
      if (reps >= minReps) { out.push(...words.slice(i, i + n)); i = j; } else { out.push(words[i]); i++; }
    }
    words = out;
  }
  return words.join(' ');
}

export function filterHallucination(text: string): string {
  const trimmed = collapseLoops(text).trim();

  // Too short
  if (trimmed.length < 2) return '';

  const lower = trimmed.toLowerCase();

  // Exact match against known hallucinations
  if (EXACT_BLOCKS.has(lower)) return '';

  // Any token that is purely a bracketed tag
  if (BRACKET_TOKEN_RE.test(trimmed)) return '';

  return trimmed;
}
