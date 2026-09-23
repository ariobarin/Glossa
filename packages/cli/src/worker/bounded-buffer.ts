const BLOCK_BYTES = 16 * 1024;

export class BoundedBuffer {
  readonly #chunks: Buffer[] = [];
  #byteLength = 0;

  constructor(readonly capacity: number) {}

  get byteLength(): number {
    return this.#byteLength;
  }

  append(chunk: Buffer): number {
    const accepted = Math.min(chunk.byteLength, this.capacity - this.#byteLength);
    let copied = 0;
    while (copied < accepted) {
      const blockIndex = Math.floor(this.#byteLength / BLOCK_BYTES);
      const blockOffset = this.#byteLength % BLOCK_BYTES;
      const block = this.#chunks[blockIndex] ?? Buffer.allocUnsafe(
        Math.min(BLOCK_BYTES, this.capacity - this.#byteLength),
      );
      this.#chunks[blockIndex] = block;
      const length = Math.min(accepted - copied, block.byteLength - blockOffset);
      chunk.copy(block, blockOffset, copied, copied + length);
      copied += length;
      this.#byteLength += length;
    }
    return accepted;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.#chunks, this.#byteLength);
  }
}
