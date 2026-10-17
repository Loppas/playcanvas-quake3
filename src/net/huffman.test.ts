import { describe, expect, it } from 'vitest';

import {
  MESSAGE_FREQUENCIES,
  buildHuffmanTree,
  huffCompress,
  huffDecompress,
  messageHuffmanTree,
  receiveSymbol
} from './huffman';

/** Read a symbol back out of a list of bits, oldest first. */
function decode(bits: readonly number[]): number {
  let index = 0;
  return receiveSymbol(messageHuffmanTree(), () => bits[index++]);
}

/** The bits a symbol's code sends, oldest first. */
function encode(symbol: number): number[] {
  const tree = messageHuffmanTree();
  const bits: number[] = [];
  for (let i = 0; i < tree.codeLengths[symbol]; i++) bits.push((tree.codes[symbol] >> i) & 1);
  return bits;
}

describe('MESSAGE_FREQUENCIES', () => {
  it("is msg_hData, all 256 counts of it", () => {
    expect(MESSAGE_FREQUENCIES).toHaveLength(256);
    expect(MESSAGE_FREQUENCIES.reduce((sum, n) => sum + n, 0)).toBe(1_053_340);
    // The first and last entries, as a check that the table did not shift while being laid out.
    expect(MESSAGE_FREQUENCIES[0]).toBe(250_315);
    expect(MESSAGE_FREQUENCIES[255]).toBe(13_504);
  });
});

describe('buildHuffmanTree', () => {
  it('gives every symbol a code, shortest where the byte is commonest', () => {
    const tree = messageHuffmanTree();
    const lengths = [...tree.codeLengths];

    expect(lengths.every((length) => length > 0)).toBe(true);
    expect(Math.min(...lengths)).toBe(2);
    expect(Math.max(...lengths)).toBe(11);

    // Byte 0 is a quarter of all traffic, so it gets the shortest code there is.
    expect(tree.codeLengths[0]).toBe(2);
    expect(encode(0)).toEqual([0, 1]);
  });

  it('averages 6.3 bits a byte over the traffic it was measured from', () => {
    const tree = messageHuffmanTree();
    let bits = 0;
    let bytes = 0;
    for (let symbol = 0; symbol < 256; symbol++) {
      bits += tree.codeLengths[symbol] * MESSAGE_FREQUENCIES[symbol];
      bytes += MESSAGE_FREQUENCIES[symbol];
    }
    expect(bits / bytes).toBeCloseTo(6.305, 3);
  });

  it('is a prefix code, so no symbol can be mistaken for the start of another', () => {
    const tree = messageHuffmanTree();
    for (let a = 0; a < 256; a++) {
      for (let b = 0; b < 256; b++) {
        if (a === b || tree.codeLengths[a] > tree.codeLengths[b]) continue;
        const shared = tree.codes[b] & ((1 << tree.codeLengths[a]) - 1);
        expect(shared).not.toBe(tree.codes[a]);
      }
    }
  });

  it('round-trips every symbol through its own code', () => {
    for (let symbol = 0; symbol < 256; symbol++) {
      expect(decode(encode(symbol))).toBe(symbol);
    }
  });

  it('builds the same tree every time, since every tie breaks on list position', () => {
    const first = buildHuffmanTree(MESSAGE_FREQUENCIES);
    const second = buildHuffmanTree(MESSAGE_FREQUENCIES);
    expect([...first.codes]).toEqual([...second.codes]);
    expect([...first.codeLengths]).toEqual([...second.codeLengths]);
    expect(first.root).toBe(second.root);
  });

  it('spends its short codes on whichever symbols a table favours', () => {
    const frequencies = new Array<number>(256).fill(1);
    frequencies[7] = 100_000;
    const tree = buildHuffmanTree(frequencies);

    expect(tree.codeLengths[7]).toBe(1);
    for (let symbol = 0; symbol < 256; symbol++) expect(tree.codeLengths[symbol]).toBeGreaterThan(0);
  });

  it('refuses a table that is not the whole alphabet', () => {
    expect(() => buildHuffmanTree([1, 2, 3])).toThrow(/256 frequencies/);
  });

  it('refuses a symbol that never occurs, which would leave it with no code at all', () => {
    const frequencies = new Array<number>(256).fill(1);
    frequencies[42] = 0;
    expect(() => buildHuffmanTree(frequencies)).toThrow(/symbol 42 has no occurrences/);
  });
});

describe('messageHuffmanTree', () => {
  it('builds once and hands back the same tree', () => {
    expect(messageHuffmanTree()).toBe(messageHuffmanTree());
  });
});

/** Text as the bytes it is, one to a character. */
function bytes(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

describe('huffCompress', () => {
  it('sends a first sighting as the NYT code and the byte, high bit first, behind a length', () => {
    // The tree is the NYT alone, whose code is empty, so 0x41 goes in as it stands, its high bit
    // into the byte's lowest bit.
    expect([...huffCompress(bytes('A'), 0)]).toEqual([0x00, 0x01, 0x82, 0x00]);
    // The second 'A' has a leaf now, the root's right child: one bit.
    expect([...huffCompress(bytes('AA'), 0)]).toEqual([0x00, 0x02, 0x82, 0x01]);
    // 'B' is new: the NYT's code, the root's left, then 0x42.
    expect([...huffCompress(bytes('AB'), 0)]).toEqual([0x00, 0x02, 0x82, 0x84, 0x00]);
  });

  it('leaves the bytes before the offset as they are', () => {
    const packed = huffCompress(bytes('\xff\xff\xff\xffconnect "\\name\\Sarge"'), 12);
    expect([...packed.subarray(0, 12)]).toEqual([...bytes('\xff\xff\xff\xffconnect ')]);
  });

  it("round-trips a connect's userinfo, however short", () => {
    for (const userinfo of [
      '"\\qport\\1234\\challenge\\0\\protocol\\1"',
      '"\\name\\UnnamedPlayer\\model\\sarge\\headmodel\\sarge\\handicap\\100\\snaps\\125"'
    ]) {
      const packet = bytes(`\xff\xff\xff\xffconnect ${userinfo}`);
      expect(huffDecompress(huffCompress(packet, 12), 12, 16384)).toEqual(packet);
    }
  });

  it('hands back a buffer with nothing past the offset untouched', () => {
    const packet = bytes('\xff\xff\xff\xffconnect ');
    expect(huffCompress(packet, 12)).toBe(packet);
    expect(huffDecompress(packet, 12, 16384)).toBe(packet);
  });
});

describe('huffDecompress', () => {
  it('believes the length only as far as the room', () => {
    expect(huffDecompress(huffCompress(bytes('ABCD'), 0), 0, 2)).toEqual(bytes('AB'));
  });

  it('ends with a NUL where the bits run out', () => {
    const cut = huffCompress(bytes('ABCDEFGH'), 0).subarray(0, 4);
    const out = huffDecompress(cut, 0, 16384);
    expect(out).toHaveLength(8);
    expect([...out.subarray(0, 2)]).toEqual([...bytes('AB')]);
    expect([...out.subarray(3)]).toEqual([0, 0, 0, 0, 0]);
  });
});
