import { messageHuffmanTree, receiveSymbol, type HuffmanTree } from './huffman';

/**
 * Quake 3's message buffer (`msg.c`): a byte array addressed in bits, where everything but the
 * odd remainder goes through the Huffman code in {@link messageHuffmanTree}.
 *
 * Two things about it are easy to get wrong and are load-bearing here.
 *
 * **Bits run from the bottom of each byte.** The first bit written lands in bit 0 of byte 0, the
 * eighth in bit 7, the ninth in bit 0 of byte 1. A value's own bits go the same way, least
 * significant first. So the buffer is not a big-endian bit string and cannot be read as one.
 *
 * **A field's width is part of the protocol, not a hint.** `writeBits(value, 10)` and
 * `readBits(10)` are a pair; reading the same bytes at a different width yields garbage rather
 * than an error, which is why the delta field tables that sit on top of this carry widths rather
 * than types. A negative width means the value is signed and the read sign-extends it.
 *
 * Out-of-band mode ({@link Message.oob}) turns the compression off and writes whole little-endian
 * bytes instead, which is what Quake 3 uses for connectionless packets that must be readable
 * before a tree exists.
 */

/** `MAX_MSGLEN` (qcommon.h:184): the largest message the protocol allows. */
export const MAX_MSGLEN = 16384;

/** `MAX_STRING_CHARS` (q_shared.h:233), the cap on an ordinary string. */
export const MAX_STRING_CHARS = 1024;

/** `BIG_INFO_STRING` (q_shared.h:241), the cap on a system-info string. */
export const BIG_INFO_STRING = 8192;

/** The byte a character Quake 3 will not send is replaced with. */
const SUBSTITUTE = '.'.charCodeAt(0);

/** `%` is replaced along with the high bytes, so a string can never be a format specifier. */
const PERCENT = '%'.charCodeAt(0);

/** Scratch for the float conversions, so `writeFloat` does not allocate. */
const floatBytes = new DataView(new ArrayBuffer(4));

export class Message {
  /** The bytes themselves. Its length is the maximum size. */
  readonly data: Uint8Array;

  /**
   * How many bytes the message occupies. After a compressed write this is one past the byte the
   * last bit fell in, which is what Quake 3 reports and can exceed the bits actually used by up
   * to seven.
   */
  curSize = 0;

  /** How many bytes a reader has consumed; past {@link curSize} means the read ran off the end. */
  readCount = 0;

  /** The bit cursor, for reading and for writing alike — Quake 3's shared `bloc`. */
  bit = 0;

  /** Whether to write plain little-endian bytes rather than Huffman-coded bits. */
  oob: boolean;

  /** Set once a write has run out of room; every later write is dropped. */
  overflowed = false;

  /**
   * @param data - The buffer to write into or read out of. Its length is the limit.
   * @param oob - Start in out-of-band mode, as `MSG_InitOOB` does.
   */
  constructor(data: Uint8Array, oob = false) {
    this.data = data;
    this.oob = oob;
  }

  /** A message with room for a full-sized packet (`MSG_Init`). */
  static write(length = MAX_MSGLEN): Message {
    return new Message(new Uint8Array(length));
  }

  /**
   * A message positioned to read the bytes already in a buffer (`MSG_Init` then
   * `MSG_BeginReading`).
   *
   * @param data - The bytes to read. All of them count as written.
   */
  static read(data: Uint8Array): Message {
    const msg = new Message(data);
    msg.curSize = data.length;
    return msg;
  }

  /** The bytes written so far, as a view onto {@link data}. */
  get written(): Uint8Array {
    return this.data.subarray(0, this.curSize);
  }

  /** The buffer's capacity in bits, which is where an overflow is measured against. */
  private get maxBits(): number {
    return this.data.length << 3;
  }

  /** `MSG_Clear`: keep the buffer, throw away what is in it. */
  clear(): void {
    this.curSize = 0;
    this.overflowed = false;
    this.bit = 0;
  }

  /** `MSG_Bitstream`: leave out-of-band mode, so the rest of the message is compressed. */
  bitstream(): void {
    this.oob = false;
  }

  /**
   * `MSG_BeginReading`: rewind to the start of the message.
   *
   * @param oob - Read plain bytes rather than compressed bits.
   */
  beginReading(oob = false): void {
    this.readCount = 0;
    this.bit = 0;
    this.oob = oob;
  }

  // --- bits ------------------------------------------------------------------------------

  /**
   * `MSG_WriteBits` (msg.c:105–188): the only write there is; everything else is a width.
   *
   * The odd bits left over from a width that is not a multiple of eight go in raw, low bit
   * first, and only the whole bytes after them are coded. A width of 32 is the largest, and a
   * negative width writes the same bits — the sign only matters on the way back.
   *
   * @param value - The value. Bits above the width are discarded.
   * @param bits - The width, 1 to 32, or its negative for a signed field.
   */
  writeBits(value: number, bits: number): void {
    if (this.overflowed) return;
    if (bits === 0 || bits < -31 || bits > 32) {
      throw new Error(`msg: bad width ${bits}`);
    }
    if (bits < 0) bits = -bits;

    if (this.oob) {
      if (this.curSize + (bits >> 3) > this.data.length) {
        this.overflowed = true;
        return;
      }
      if (bits === 8) {
        this.data[this.curSize] = value;
        this.curSize += 1;
      } else if (bits === 16) {
        this.data[this.curSize] = value;
        this.data[this.curSize + 1] = value >>> 8;
        this.curSize += 2;
      } else if (bits === 32) {
        this.data[this.curSize] = value;
        this.data[this.curSize + 1] = value >>> 8;
        this.data[this.curSize + 2] = value >>> 16;
        this.data[this.curSize + 3] = value >>> 24;
        this.curSize += 4;
      } else {
        throw new Error(`msg: cannot write ${bits} bits out of band`);
      }
      this.bit += bits;
      return;
    }

    // Mask to the width. A 32-bit field keeps every bit, and `>>> 0` is what stops the shift
    // below from dragging a sign down with it.
    let rest = bits === 32 ? value >>> 0 : (value & ((1 << bits) - 1)) >>> 0;

    const remainder = bits & 7;
    if (remainder) {
      if (this.bit + remainder >= this.maxBits) {
        this.overflowed = true;
        return;
      }
      for (let i = 0; i < remainder; i++) {
        this.putBit(rest & 1);
        rest = rest >>> 1;
      }
      bits -= remainder;
    }

    if (bits) {
      const tree = messageHuffmanTree();
      for (let i = 0; i < bits; i += 8) {
        this.transmit(tree, rest & 0xff);
        rest = rest >>> 8;
        if (this.bit >= this.maxBits) {
          this.overflowed = true;
          return;
        }
      }
    }

    this.curSize = (this.bit >> 3) + 1;
  }

  /**
   * `MSG_ReadBits` (msg.c:190–262): read a field back at the width it was written.
   *
   * @param bits - The width, 1 to 32, or its negative to sign-extend the result.
   * @returns The value, as a signed 32-bit integer — a 32-bit field with its top bit set reads
   *   back negative whatever the sign of the width, exactly as Quake 3's `int` does.
   */
  readBits(bits: number): number {
    if (this.readCount > this.curSize) return 0;

    let value = 0;
    const signed = bits < 0;
    if (signed) bits = -bits;

    if (this.oob) {
      if (this.readCount + (bits >> 3) > this.curSize) {
        this.readCount = this.curSize + 1;
        return 0;
      }
      if (bits === 8) {
        value = this.data[this.readCount];
        this.readCount += 1;
      } else if (bits === 16) {
        value = ((this.data[this.readCount + 1] << 8) | this.data[this.readCount]) << 16 >> 16;
        this.readCount += 2;
      } else if (bits === 32) {
        value =
          (this.data[this.readCount] |
            (this.data[this.readCount + 1] << 8) |
            (this.data[this.readCount + 2] << 16) |
            (this.data[this.readCount + 3] << 24)) |
          0;
        this.readCount += 4;
      } else {
        throw new Error(`msg: cannot read ${bits} bits out of band`);
      }
      this.bit += bits;
      return value;
    }

    let remainder = 0;
    if (bits & 7) {
      remainder = bits & 7;
      if (this.bit + remainder > this.curSize << 3) {
        this.readCount = this.curSize + 1;
        return 0;
      }
      for (let i = 0; i < remainder; i++) value |= this.getBit() << i;
      bits -= remainder;
    }

    if (bits) {
      const tree = messageHuffmanTree();
      for (let i = 0; i < bits; i += 8) {
        const byte = receiveSymbol(tree, this.readBitBounded);
        value = (value | (byte << (i + remainder))) | 0;
        if (this.bit > this.curSize << 3) {
          this.readCount = this.curSize + 1;
          return 0;
        }
      }
    }

    this.readCount = (this.bit >> 3) + 1;

    // Sign-extend against the width *left over* after the remainder was taken off, which is what
    // the C does. For a signed field whose width is not a multiple of eight it would test the
    // wrong bit; no such field exists — the only signed ones are `weaponTime` and `pm_time` at 16
    // and `viewheight` at 8 — so the two readings never differ on real data.
    if (signed && bits > 0 && bits < 32) {
      const sign = 1 << (bits - 1);
      if (value & sign) value |= -1 ^ ((1 << bits) - 1);
    }
    return value;
  }

  // --- widths ----------------------------------------------------------------------------

  /** An 8-bit signed field (`MSG_WriteChar`). */
  writeChar(value: number): void {
    this.writeBits(value, 8);
  }

  /** An 8-bit unsigned field (`MSG_WriteByte`). */
  writeByte(value: number): void {
    this.writeBits(value, 8);
  }

  /** A 16-bit field (`MSG_WriteShort`). */
  writeShort(value: number): void {
    this.writeBits(value, 16);
  }

  /** A 32-bit field (`MSG_WriteLong`). */
  writeLong(value: number): void {
    this.writeBits(value, 32);
  }

  /** A float, sent as its 32 bits (`MSG_WriteFloat`). */
  writeFloat(value: number): void {
    floatBytes.setFloat32(0, value, true);
    this.writeBits(floatBytes.getInt32(0, true), 32);
  }

  /**
   * Raw bytes, one byte-width field each (`MSG_WriteData`) — still compressed, since every byte
   * goes through {@link writeByte}.
   *
   * @param bytes - The bytes to write.
   */
  writeData(bytes: Uint8Array): void {
    for (const byte of bytes) this.writeByte(byte);
  }

  /**
   * An angle in a byte: a 256th of a turn (`MSG_WriteAngle`). The precision is about 1.4°, which
   * is why it is used for things nobody aims with.
   */
  writeAngle(degrees: number): void {
    this.writeByte(Math.trunc((degrees * 256) / 360) & 255);
  }

  /** An angle in a short, `ANGLE2SHORT` (q_shared.h:1072): a 65536th of a turn. */
  writeAngle16(degrees: number): void {
    this.writeShort(angleToShort(degrees));
  }

  /** Reads an 8-bit signed field; `-1` also means the read ran off the end. */
  readChar(): number {
    const value = (this.readBits(8) << 24) >> 24;
    return this.readCount > this.curSize ? -1 : value;
  }

  /** Reads an 8-bit unsigned field; `-1` means the read ran off the end. */
  readByte(): number {
    const value = this.readBits(8) & 0xff;
    return this.readCount > this.curSize ? -1 : value;
  }

  /**
   * `MSG_LookaheadByte`: the next byte, without consuming it. The bit cursor and the read
   * position are put back exactly as they were.
   */
  lookaheadByte(): number {
    const { readCount, bit } = this;
    const value = this.readByte();
    this.readCount = readCount;
    this.bit = bit;
    return value;
  }

  /** Reads a 16-bit signed field; `-1` also means the read ran off the end. */
  readShort(): number {
    const value = (this.readBits(16) << 16) >> 16;
    return this.readCount > this.curSize ? -1 : value;
  }

  /** Reads a 32-bit field; `-1` also means the read ran off the end. */
  readLong(): number {
    const value = this.readBits(32);
    return this.readCount > this.curSize ? -1 : value;
  }

  /** Reads a float; `-1` also means the read ran off the end. */
  readFloat(): number {
    floatBytes.setInt32(0, this.readBits(32), true);
    const value = floatBytes.getFloat32(0, true);
    return this.readCount > this.curSize ? -1 : value;
  }

  /**
   * Raw bytes (`MSG_ReadData`). A byte past the end of the message reads as `-1`, which lands in
   * the array as 255.
   *
   * @param length - How many bytes to read.
   * @param into - Where to put them, from its start, as `MSG_ReadData` fills its caller's; a new
   *   array unless given.
   * @returns `into`.
   */
  readData(length: number, into: Uint8Array = new Uint8Array(length)): Uint8Array {
    for (let i = 0; i < length; i++) into[i] = this.readByte();
    return into;
  }

  /** Reads an angle written by {@link writeAngle16}. */
  readAngle16(): number {
    return shortToAngle(this.readShort());
  }

  /**
   * A NUL-terminated string (`MSG_WriteString`).
   *
   * Bytes above 127 and `%` are replaced with `.` on the way out, as Quake 3 does, "because old
   * clients don't like them" — the `%` because a string that reaches a `printf` must not be a
   * format specifier. A string at or over the cap is sent as an empty one.
   *
   * @param value - The string, or null for an empty one.
   * @param limit - The cap: {@link MAX_STRING_CHARS}, or {@link BIG_INFO_STRING} for
   *   `MSG_WriteBigString`.
   */
  writeString(value: string | null, limit = MAX_STRING_CHARS): void {
    if (value === null || value.length >= limit) {
      this.writeByte(0);
      return;
    }
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      this.writeByte(code > 127 || code === PERCENT ? SUBSTITUTE : code);
    }
    this.writeByte(0);
  }

  /** {@link writeString} at `BIG_INFO_STRING` (`MSG_WriteBigString`). */
  writeBigString(value: string | null): void {
    this.writeString(value, BIG_INFO_STRING);
  }

  /**
   * A NUL-terminated string (`MSG_ReadString`), with the same substitutions applied again on the
   * way in so a hostile sender cannot get a `%` or a high byte through.
   *
   * @param limit - The cap; reading stops there whether or not a NUL has arrived.
   * @param stopAtNewline - Stop at a newline as well, which is `MSG_ReadStringLine`.
   */
  readString(limit = MAX_STRING_CHARS, stopAtNewline = false): string {
    let out = '';
    for (;;) {
      // A byte read, so that running off the end gives -1 rather than a NUL.
      const code = this.readByte();
      if (code === -1 || code === 0) break;
      if (stopAtNewline && code === 0x0a) break;
      if (out.length >= limit - 1) break;
      out += String.fromCharCode(code > 127 || code === PERCENT ? SUBSTITUTE : code);
    }
    return out;
  }

  /** {@link readString} at `BIG_INFO_STRING` (`MSG_ReadBigString`). */
  readBigString(): string {
    return this.readString(BIG_INFO_STRING);
  }

  /** {@link readString} stopping at a newline as well (`MSG_ReadStringLine`). */
  readStringLine(): string {
    return this.readString(MAX_STRING_CHARS, true);
  }

  // --- the bit cursor --------------------------------------------------------------------

  /**
   * `Huff_putBit` (huffman.c:31–38). The byte is cleared as it is entered, so a buffer written
   * twice does not keep bits from the first pass.
   */
  private putBit(bit: number): void {
    const index = this.bit >> 3;
    if ((this.bit & 7) === 0) this.data[index] = 0;
    this.data[index] |= bit << (this.bit & 7);
    this.bit++;
  }

  /** `Huff_getBit` (huffman.c:53–60). */
  private getBit(): number {
    const bit = (this.data[this.bit >> 3] >> (this.bit & 7)) & 1;
    this.bit++;
    return bit;
  }

  /**
   * {@link getBit} with the bound `Huff_offsetReceive` applies: past the end of the message it
   * stops rather than walking the tree on whatever follows in memory.
   *
   * An arrow function, because {@link receiveSymbol} calls it back.
   */
  private readonly readBitBounded = (): number => {
    if (this.bit >= this.curSize << 3) {
      this.bit = (this.curSize << 3) + 1;
      return 0;
    }
    return this.getBit();
  };

  /**
   * `Huff_offsetTransmit` (huffman.c:333–337), with `send`'s walk already done: the symbol's code
   * goes out root-first, which is the order {@link HuffmanTree.codes} packs it in.
   *
   * Where `send` re-checks the bound at every level as it unwinds, this stops at the first bit
   * that would not fit and leaves the cursor past the end. Either way the caller's own check sees
   * the overflow on the next byte.
   */
  private transmit(tree: HuffmanTree, symbol: number): void {
    const code = tree.codes[symbol];
    const length = tree.codeLengths[symbol];
    for (let i = 0; i < length; i++) {
      if (this.bit >= this.maxBits) {
        this.bit = this.maxBits + 1;
        return;
      }
      this.putBit((code >> i) & 1);
    }
  }
}

/** `ANGLE2SHORT` (q_shared.h:1072). */
export function angleToShort(degrees: number): number {
  return Math.trunc((degrees * 65536) / 360) & 65535;
}

/** `SHORT2ANGLE` (q_shared.h:1073). */
export function shortToAngle(value: number): number {
  return value * (360 / 65536);
}

/**
 * `MSG_HashKey` (msg.c:1163–1176): a number derived from a string, used to key a user command.
 *
 * It is not a hash in the usual sense and nothing looks anything up with it. Both ends work it out
 * from the last server command they agree on, and the sender scrambles its user commands with it,
 * so a command copied off one connection decodes to nonsense on any other.
 *
 * A byte with its high bit set, and a literal percent, are both replaced by a full stop before
 * being weighed. Quake 3 does that because the string ends up in a `printf` format, where neither
 * would survive intact.
 */
export function hashKey(value: string, maxlen: number): number {
  let hash = 0;
  for (let i = 0; i < maxlen && i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0) break;
    hash = (hash + (code >= 0x80 || code === 0x25 ? 0x2e : code) * (119 + i)) | 0;
  }
  return hash ^ (hash >> 10) ^ (hash >> 20);
}
