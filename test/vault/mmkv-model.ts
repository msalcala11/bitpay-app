// Platform-boundary model of the pinned default, unencrypted MMKV layout.
// Encoding is constructed byte-by-byte independently of the production planner.
// Native fresh-process tests remain the authority for core behavior.
export const uint32 = (value: number): Buffer => {
  const bytes: number[] = [];
  do {
    const next = value % 128;
    value = Math.floor(value / 128);
    bytes.push(next + (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
};
export const entry = (key: string, value?: any): Buffer => {
  const name = Buffer.from(key, 'utf8');
  let data = Buffer.alloc(0);
  if (typeof value === 'string') {
    const text = Buffer.from(value, 'utf8');
    data = Buffer.concat([uint32(text.length), text]);
  } else if (value !== undefined) data = Buffer.from([value ? 1 : 0]);
  return Buffer.concat([uint32(name.length), name, uint32(data.length), data]);
};
export class MmkvModel {
  bytes: Buffer;
  actual = 0;
  peak: number;
  rejectGrowth = false;
  failShrink = false;
  trimNoop = false;
  constructor(readonly values: Map<string, any>, readonly page = 4096) {
    this.bytes = Buffer.alloc(page);
    this.peak = page;
  }
  private header() {
    this.bytes.writeUInt32LE(this.actual, 0);
  }
  private compact() {
    const data = Buffer.concat([
      Buffer.from([0x80, 0x80, 0x80, 1]),
      ...[...this.values].map(([k, v]) => entry(k, v)),
    ]);
    data.copy(this.bytes, 4);
    this.actual = data.length;
    this.header();
  }
  private append(data: Buffer) {
    if (
      data.length >= this.bytes.length - 4 - this.actual ||
      this.values.size === 0
    ) {
      const compact =
        4 + [...this.values].reduce((n, [k, v]) => n + entry(k, v).length, 0);
      const needed = compact + 4 + data.length;
      const future = 8 * Math.ceil(needed / Math.max(1, this.values.size + 1));
      if (
        needed >= this.bytes.length ||
        (this.values.size > 0 && needed + future >= this.bytes.length)
      ) {
        if (this.rejectGrowth)
          throw new Error('synthetic allocation rejection');
        let size = this.bytes.length;
        do {
          size *= 2;
        } while (size <= needed + future);
        const grown = Buffer.alloc(size);
        this.bytes.copy(grown);
        this.bytes = grown;
        this.peak = Math.max(this.peak, size);
      }
      this.compact();
    }
    data.copy(this.bytes, 4 + this.actual);
    this.actual += data.length;
    this.header();
  }
  set(key: string, value: any) {
    const data = entry(key, value);
    const override =
      (this.values.has(key) && this.values.size === 1) ||
      (this.values.size === 0 && this.actual > 0);
    if (override && data.length + 8 <= this.bytes.length) {
      this.actual = 4;
      Buffer.from([0x80, 0x80, 0x80, 1]).copy(this.bytes, 4);
      data.copy(this.bytes, 8);
      this.actual += data.length;
      this.header();
    } else this.append(data);
    this.values.set(key, value);
  }
  delete(key: string) {
    if (this.values.has(key)) {
      this.append(entry(key));
      this.values.delete(key);
    }
  }
  trim() {
    if (this.trimNoop) return;
    if (!this.values.size) {
      this.actual = 0;
      if (!this.failShrink) this.bytes = this.bytes.subarray(0, this.page);
      this.header();
      return;
    }
    if (this.bytes.length <= this.page) return;
    this.compact();
    let size = this.bytes.length;
    while (size > (this.actual + 4) * 2) size /= 2;
    size = Math.max(size, this.page);
    if (!this.failShrink) this.bytes = this.bytes.subarray(0, size);
  }
}
