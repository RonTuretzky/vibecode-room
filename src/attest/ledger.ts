// A byte ledger of what the room actually RECEIVED on one stream of one attested
// source — the raw PCM frames of a mic socket, or the newline-terminated JSON
// frames of a hands/gesture socket. Chunk records from the phone are checked
// against these bytes, so a passing chunk means "the bytes the room consumed are
// the bytes the Titan M2 signed", not merely that some signed bytes exist.
//
// Bounded: a phone that streams but never posts chunk records cannot grow the
// ledger without limit; past `maxPendingBytes` the stream is flagged and reset.
export class ByteLedger {
  #queue: Uint8Array[] = [];
  #headOffset = 0;
  #pending = 0;
  #consumed = 0;
  readonly maxPendingBytes: number;
  overflowed = false;

  constructor(maxPendingBytes = 32 * 1024 * 1024) {
    this.maxPendingBytes = maxPendingBytes;
  }

  get available(): number {
    return this.#pending;
  }

  get consumed(): number {
    return this.#consumed;
  }

  append(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    if (this.#pending + bytes.length > this.maxPendingBytes) {
      this.overflowed = true;
      this.#queue = [];
      this.#headOffset = 0;
      this.#pending = 0;
      return;
    }
    this.#queue.push(bytes);
    this.#pending += bytes.length;
  }

  // Removes and returns exactly `size` bytes from the head, or null (and takes
  // nothing) when fewer are available.
  take(size: number): Uint8Array | null {
    if (size < 0 || size > this.#pending) return null;
    const out = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      const head = this.#queue[0]!;
      const remaining = head.length - this.#headOffset;
      const n = Math.min(remaining, size - filled);
      out.set(head.subarray(this.#headOffset, this.#headOffset + n), filled);
      filled += n;
      this.#headOffset += n;
      if (this.#headOffset === head.length) {
        this.#queue.shift();
        this.#headOffset = 0;
      }
    }
    this.#pending -= size;
    this.#consumed += size;
    return out;
  }
}
