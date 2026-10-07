/** A display-only buffer. The complete received text remains in sessionStore. */
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
function ends(text: string, offset = 0): number[] {
  const pieces = segmenter ? [...segmenter.segment(text)].map(part => part.segment) : Array.from(text);
  const result: number[] = [];
  for (const piece of pieces) {
    offset += piece.length;
    // Hold an unfinished surrogate pair until the next provider chunk arrives.
    const last = piece.charCodeAt(piece.length - 1);
    if (last < 0xd800 || last > 0xdbff) result.push(offset);
  }
  return result;
}
export class TextReveal {
  target: string;
  private boundaries: number[];
  private cursor: number;
  private revision: number;
  private clock: number | null = null;
  private credit = 0;
  private freshTarget = false;
  private catchupRate = 0;
  constructor(text = '', revision = 0) {
    this.target = text; this.revision = revision; this.boundaries = ends(text); this.cursor = text.length;
  }
  update(text: string, revision = this.revision) {
    if (text === this.target && revision === this.revision) return;
    const append = revision === this.revision && text.startsWith(this.target);
    const wasComplete = !this.pending;
    const previousLength = this.target.length;
    const start = append && this.boundaries.length > 1 ? this.boundaries[this.boundaries.length - 2] : 0;
    const retained = append ? this.boundaries.filter(end => end <= start) : [];
    this.boundaries = [...retained, ...ends(text.slice(start), start)];
    if (!append) { this.cursor = 0; this.clock = null; this.credit = 0; }
    else if (previousLength > 0 && this.cursor === previousLength && this.boundaries[retained.length] > this.cursor) this.cursor = this.boundaries[retained.length];
    if (wasComplete) { this.clock = null; this.credit = 0; }
    this.target = text; this.revision = revision;
    this.freshTarget = true;
  }
  get text() { return this.target.slice(0, this.cursor); }
  get pending() { return this.cursor < (this.boundaries[this.boundaries.length - 1] || 0); }
  flush() { this.cursor = this.target.length; this.clock = null; this.credit = 0; return this.text; }
  advance(now: number, charactersPerSecond: number, maxCatchupMs: number) {
    if (!this.pending) return this.text;
    let lo = 0, hi = this.boundaries.length;
    while (lo < hi) { const middle = (lo + hi) >>> 1; if (this.boundaries[middle] <= this.cursor) lo = middle + 1; else hi = middle; }
    const remaining = this.boundaries.length - lo;
    if (this.freshTarget) { this.catchupRate = remaining * 1000 / maxCatchupMs; this.freshTarget = false; }
    const rate = Math.max(charactersPerSecond, this.catchupRate);
    this.credit += this.clock === null ? 1 : Math.min(100, Math.max(0, now - this.clock)) * rate / 1000;
    this.clock = now;
    const count = Math.min(remaining, Math.floor(this.credit));
    if (count) { this.cursor = this.boundaries[lo + count - 1]; this.credit -= count; }
    if (!this.pending) { this.clock = null; this.credit = 0; }
    return this.text;
  }
}
