// Aligns recognised speech to script words. Kept free of DOM/audio so it can be unit tested.

export function normalize(word) {
  return word.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}']/gu, '');
}

function close(a, b) {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  // One edit apart counts as a match ("colour"/"color", recogniser slips).
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

export class Matcher {
  constructor(words = []) { this.setWords(words); }

  setWords(words) {
    this.words = words.map(normalize);
    this.pos = 0;
  }

  reset() { this.pos = 0; }

  // Takes the latest recognised phrase; returns the new script index or null.
  // Searches a window ahead of the current position, preferring nearby matches.
  update(phrase, { lookBehind = 8, lookAhead = 60, tail = 6 } = {}) {
    const heard = phrase.split(/\s+/).map(normalize).filter(Boolean).slice(-tail);
    if (!heard.length || !this.words.length) return null;
    const from = Math.max(0, this.pos - lookBehind);
    const to = Math.min(this.words.length, this.pos + lookAhead);
    let best = null;
    for (let end = from; end < to; end++) {
      // Count heard words matching backwards from `end`.
      let score = 0;
      let i = heard.length - 1;
      let j = end;
      while (i >= 0 && j >= from) {
        if (close(heard[i], this.words[j])) { score++; i--; j--; } else if (score === 0) { break; } else { i--; }
      }
      if (score === 0) continue;
      const distance = Math.abs(end - this.pos);
      const value = score * 10 - distance * 0.2;
      if (!best || value > best.value) best = { end, score, value };
    }
    const needed = Math.min(2, heard.length);
    if (!best || best.score < needed) return null;
    this.pos = best.end + 1;
    return this.pos;
  }
}
