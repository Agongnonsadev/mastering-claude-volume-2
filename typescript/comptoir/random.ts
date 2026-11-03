// Python's random.Random(seed): the same generator (Mersenne Twister, MT19937), seeded the same way, and
// the same draws (randrange, choice, sample, shuffle). With the same seed, the TypeScript version draws
// the same confirmation codes (chapter 17: the harness) and the same sample of answers to grade as the
// Python version.

const N = 624;
const M = 397;

export class PythonRandom {
  private readonly mt = new Uint32Array(N);
  private index = N;

  /** random.seed(seed) for an integer: the key is |seed|, cut into 32-bit words. */
  constructor(seed: number) {
    let rest = BigInt(Math.abs(seed));
    const key: number[] = [];
    do {
      key.push(Number(rest & 0xffffffffn));
      rest >>= 32n;
    } while (rest > 0n);
    this.init(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const p = this.mt[i - 1]! ^ (this.mt[i - 1]! >>> 30);
      this.mt[i] = ((this.mt[i]! ^ Math.imul(p, 1664525)) >>> 0) + key[j]! + j;
      i++;
      j++;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1]!;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const p = this.mt[i - 1]! ^ (this.mt[i - 1]! >>> 30);
      this.mt[i] = ((this.mt[i]! ^ Math.imul(p, 1566083941)) >>> 0) - i;
      i++;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1]!;
        i = 1;
      }
    }
    this.mt[0] = 0x80000000;
  }

  private init(s: number): void {
    this.mt[0] = s;
    for (let i = 1; i < N; i++) {
      const p = this.mt[i - 1]! ^ (this.mt[i - 1]! >>> 30);
      this.mt[i] = Math.imul(1812433253, p) + i;
    }
    this.index = N;
  }

  private twist(): void {
    for (let k = 0; k < N; k++) {
      const y = (this.mt[k]! & 0x80000000) | (this.mt[(k + 1) % N]! & 0x7fffffff);
      this.mt[k] = this.mt[(k + M) % N]! ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
    }
    this.index = 0;
  }

  /** A 32-bit word (genrand_uint32). */
  private word(): number {
    if (this.index >= N) this.twist();
    let y = this.mt[this.index++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** getrandbits(k), for k ≤ 32: the k high-order bits of a word. */
  getrandbits(k: number): number {
    if (k < 0 || k > 32) throw new RangeError("getrandbits: from 0 to 32 bits here");
    return k === 0 ? 0 : this.word() >>> (32 - k);
  }

  /** _randbelow(n): an integer from 0 to n − 1, drawn by rejection on the number of bits of n. */
  randbelow(n: number): number {
    const k = 32 - Math.clz32(n);
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  /** randrange(n). */
  randrange(n: number): number {
    if (n <= 0) throw new RangeError("randrange: empty range");
    return this.randbelow(n);
  }

  choice<T>(seq: readonly T[]): T {
    if (!seq.length) throw new RangeError("choice: empty sequence");
    return seq[this.randbelow(seq.length)]!;
  }

  /** shuffle(x), in place, from the end. */
  shuffle<T>(x: T[]): void {
    for (let i = x.length - 1; i > 0; i--) {
      const j = this.randbelow(i + 1);
      [x[i], x[j]] = [x[j]!, x[i]!];
    }
  }

  /** sample(population, k), with Python's two methods, chosen the same way. */
  sample<T>(population: readonly T[], k: number): T[] {
    const n = population.length;
    if (k < 0 || k > n) throw new RangeError("sample: sample larger than the population");
    const result: T[] = new Array(k);
    let size = 21;
    if (k > 5) size += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4));
    if (n <= size) {
      const pool = [...population];
      for (let i = 0; i < k; i++) {
        const j = this.randbelow(n - i);
        result[i] = pool[j]!;
        pool[j] = pool[n - i - 1]!;
      }
    } else {
      const chosen = new Set<number>();
      for (let i = 0; i < k; i++) {
        let j = this.randbelow(n);
        while (chosen.has(j)) j = this.randbelow(n);
        chosen.add(j);
        result[i] = population[j]!;
      }
    }
    return result;
  }
}
