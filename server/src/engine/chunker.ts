export interface ChunkerOptions {
  /** Emit even without a paragraph break once the buffer is this long (outside code blocks). */
  maxChars: number;
  /** Emit what we have after this long without a paragraph break. */
  idleMs: number;
}

const DEFAULTS: ChunkerOptions = { maxChars: 1500, idleMs: 4000 };
const FENCE = /^\s{0,3}(```|~~~)/;

/**
 * Buffers streamed text and emits it roughly one paragraph at a time.
 * Emitted slices are exact consecutive substrings: concatenating them yields the full text.
 * Fenced code blocks are kept whole.
 */
export class ParagraphChunker {
  private buf = "";
  private timer: NodeJS.Timeout | null = null;
  private readonly opts: ChunkerOptions;

  constructor(
    private readonly emit: (text: string) => void,
    opts: Partial<ChunkerOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  push(delta: string): void {
    if (!delta) return;
    this.buf += delta;
    this.drain();
    this.arm();
  }

  /** Emits whatever is left (call at the end of the block). */
  flush(): void {
    this.clearTimer();
    if (this.buf) {
      const out = this.buf;
      this.buf = "";
      this.emit(out);
    }
  }

  private drain(): void {
    for (;;) {
      const cut = findCut(this.buf, this.opts.maxChars);
      if (cut <= 0 || cut > this.buf.length) return;
      const piece = this.buf.slice(0, cut);
      this.buf = this.buf.slice(cut);
      this.emit(piece);
    }
  }

  private arm(): void {
    this.clearTimer();
    if (!this.buf) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.buf) return;
      // Cut at the last whitespace so we never split a word.
      const ws = Math.max(this.buf.lastIndexOf(" "), this.buf.lastIndexOf("\n"));
      const cut = ws > 0 ? ws + 1 : this.buf.length;
      const piece = this.buf.slice(0, cut);
      this.buf = this.buf.slice(cut);
      if (piece) this.emit(piece);
      this.arm();
    }, this.opts.idleMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Returns the index to cut at (exclusive), or -1 when no cut point is ready yet. */
export function findCut(buf: string, maxChars: number): number {
  let inFence = false;
  let start = 0;
  let sawContent = false;
  let lastNewlineBeforeMax = -1;
  while (start < buf.length) {
    const nl = buf.indexOf("\n", start);
    if (nl === -1) break; // incomplete last line
    const line = buf.slice(start, nl);
    if (FENCE.test(line)) inFence = !inFence;
    const blank = line.trim() === "";
    if (!inFence && blank && sawContent) return nl + 1;
    if (!blank) sawContent = true;
    if (!inFence && nl < maxChars) lastNewlineBeforeMax = nl;
    start = nl + 1;
  }
  if (buf.length > maxChars && !inFence) {
    if (lastNewlineBeforeMax > 0) return lastNewlineBeforeMax + 1;
    const sp = buf.lastIndexOf(" ", maxChars);
    return sp > 0 ? sp + 1 : maxChars;
  }
  if (inFence && buf.length > maxChars * 8) {
    const nl = buf.lastIndexOf("\n");
    return nl > 0 ? nl + 1 : buf.length;
  }
  return -1;
}
