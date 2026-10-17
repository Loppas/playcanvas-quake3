import { describe, expect, it } from 'vitest';

import { MAX_STRING_CHARS, Message, angleToShort, shortToAngle } from './msg';

/** Write with one message and read with another, over the bytes the first produced. */
function roundTrip(write: (msg: Message) => void, read: (msg: Message) => void): Message {
  const out = Message.write(256);
  write(out);
  expect(out.overflowed).toBe(false);

  const back = Message.read(out.written.slice());
  read(back);
  return back;
}

describe('Message.writeBits', () => {
  it('fills each byte from its lowest bit up', () => {
    const msg = Message.write(16);
    msg.writeBits(1, 1);
    msg.writeBits(0, 1);
    msg.writeBits(1, 1);
    expect(msg.data[0] & 0b111).toBe(0b101);
    expect(msg.bit).toBe(3);
  });

  it('sends a value low bit first', () => {
    const msg = Message.write(16);
    msg.writeBits(0b110, 3);
    expect(msg.data[0] & 0b111).toBe(0b110);
  });

  it('round-trips every width from 1 to 32', () => {
    for (let bits = 1; bits <= 32; bits++) {
      const value = bits === 32 ? -1 : (1 << bits) - 1;
      const msg = Message.write(64);
      msg.writeBits(value, bits);
      msg.writeBits(0, bits);
      msg.beginReading();
      expect(msg.readBits(bits)).toBe(value | 0);
      expect(msg.readBits(bits)).toBe(0);
    }
  });

  it('discards the bits above the width', () => {
    const msg = Message.write(16);
    msg.writeBits(0xff, 4);
    msg.beginReading();
    expect(msg.readBits(4)).toBe(0xf);
  });

  it('sign-extends only when the width is given as a negative', () => {
    const msg = Message.write(16);
    msg.writeBits(-3, 8);
    msg.writeBits(-3, 16);
    msg.beginReading();
    expect(msg.readBits(8)).toBe(253);
    expect(msg.readBits(-16)).toBe(-3);
  });

  it('keeps a 32-bit field with its top bit set, as a signed int', () => {
    const msg = Message.write(16);
    msg.writeBits(0x80000000, 32);
    msg.beginReading();
    expect(msg.readBits(32)).toBe(-2147483648);
  });

  it('refuses a width the protocol has no room for', () => {
    const msg = Message.write(16);
    expect(() => msg.writeBits(0, 0)).toThrow(/bad width/);
    expect(() => msg.writeBits(0, 33)).toThrow(/bad width/);
    expect(() => msg.writeBits(0, -32)).toThrow(/bad width/);
  });
});

describe('Message widths', () => {
  it('round-trips a mixed message in the order it was written', () => {
    roundTrip(
      (msg) => {
        msg.writeByte(200);
        msg.writeChar(-8);
        msg.writeShort(-30000);
        msg.writeLong(123456789);
        msg.writeBits(5, 3);
        msg.writeFloat(0.5);
        msg.writeString('hello');
      },
      (msg) => {
        expect(msg.readByte()).toBe(200);
        expect(msg.readChar()).toBe(-8);
        expect(msg.readShort()).toBe(-30000);
        expect(msg.readLong()).toBe(123456789);
        expect(msg.readBits(3)).toBe(5);
        expect(msg.readFloat()).toBe(0.5);
        expect(msg.readString()).toBe('hello');
      }
    );
  });

  it('round-trips raw bytes', () => {
    const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
    roundTrip(
      (msg) => msg.writeData(bytes),
      (msg) => expect([...msg.readData(bytes.length)]).toEqual([...bytes])
    );
  });

  it('reads raw bytes into an array it is given, from its start, leaving the rest', () => {
    const into = Uint8Array.from([9, 9, 9, 9]);
    roundTrip(
      (msg) => msg.writeData(Uint8Array.from([1, 2])),
      (msg) => {
        expect(msg.readData(2, into)).toBe(into);
        expect([...into]).toEqual([1, 2, 9, 9]);
      }
    );
  });

  it('keeps an angle to a 256th of a turn', () => {
    const msg = Message.write(16);
    msg.writeAngle(90);
    msg.beginReading();
    expect(msg.readByte()).toBe(64);
  });

  it('keeps an angle16 to about a hundredth of a degree', () => {
    for (const degrees of [0, 45, 90, 179.9, 270]) {
      expect(shortToAngle(angleToShort(degrees))).toBeCloseTo(degrees, 1);
    }
    // The wrap is a mask, so a full turn comes back as none at all.
    expect(angleToShort(360)).toBe(0);
  });
});

describe('Message strings', () => {
  it('replaces the bytes Quake 3 will not send, in both directions', () => {
    roundTrip(
      (msg) => msg.writeString('a%béc'),
      (msg) => expect(msg.readString()).toBe('a.b.c')
    );
  });

  it('sends nothing but the terminator for a null string', () => {
    roundTrip(
      (msg) => msg.writeString(null),
      (msg) => expect(msg.readString()).toBe('')
    );
  });

  it('sends an empty string rather than truncating one over the cap', () => {
    const msg = Message.write(4096);
    msg.writeString('x'.repeat(MAX_STRING_CHARS));
    msg.beginReading();
    expect(msg.readString()).toBe('');
  });

  it('stops a line at a newline and an ordinary string does not', () => {
    roundTrip(
      (msg) => msg.writeString('one\ntwo'),
      (msg) => expect(msg.readStringLine()).toBe('one')
    );
    roundTrip(
      (msg) => msg.writeString('one\ntwo'),
      (msg) => expect(msg.readString()).toBe('one\ntwo')
    );
  });

  it('round-trips a string longer than an ordinary one as a big string', () => {
    const long = 'y'.repeat(2000);
    const out = Message.write(4096);
    out.writeBigString(long);
    const back = Message.read(out.written.slice());
    expect(back.readBigString()).toBe(long);
  });
});

describe('Message out of band', () => {
  it('writes plain little-endian bytes with no compression', () => {
    const msg = new Message(new Uint8Array(16), true);
    msg.writeShort(0x1234);
    msg.writeLong(0x0a0b0c0d);
    expect([...msg.written]).toEqual([0x34, 0x12, 0x0d, 0x0c, 0x0b, 0x0a]);
    expect(msg.curSize).toBe(6);
  });

  it('reads back what it wrote, with the short signed', () => {
    const msg = new Message(new Uint8Array(16), true);
    msg.writeShort(-2);
    msg.writeByte(250);
    msg.writeLong(-1);
    msg.beginReading(true);
    expect(msg.readBits(16)).toBe(-2);
    expect(msg.readBits(8)).toBe(250);
    expect(msg.readBits(32)).toBe(-1);
  });

  it('switches to the compressed stream at bitstream(), as a connection does', () => {
    const msg = new Message(new Uint8Array(64), true);
    msg.writeLong(7);
    msg.bitstream();
    msg.writeByte(9);

    msg.beginReading(true);
    expect(msg.readLong()).toBe(7);
    msg.bitstream();
    expect(msg.readByte()).toBe(9);
  });

  it('refuses a width that is not a whole number of bytes', () => {
    const msg = new Message(new Uint8Array(16), true);
    expect(() => msg.writeBits(0, 3)).toThrow(/out of band/);
  });
});

describe('Message bounds', () => {
  it('stops writing once the buffer is full and says so', () => {
    const msg = Message.write(4);
    for (let i = 0; i < 64; i++) msg.writeByte(0xff);
    expect(msg.overflowed).toBe(true);
    expect(msg.curSize).toBeLessThanOrEqual(4);
  });

  it('reads zero past the end of the message, and marks the read as spent', () => {
    const out = Message.write(16);
    out.writeByte(1);

    const back = Message.read(out.written.slice());
    expect(back.readByte()).toBe(1);
    back.readBits(32);
    back.readBits(32);
    expect(back.readCount).toBeGreaterThan(back.curSize);
    expect(back.readByte()).toBe(-1);
  });
});

describe('Message cursor', () => {
  it('looks ahead without consuming', () => {
    roundTrip(
      (msg) => {
        msg.writeByte(3);
        msg.writeByte(4);
      },
      (msg) => {
        expect(msg.lookaheadByte()).toBe(3);
        expect(msg.lookaheadByte()).toBe(3);
        expect(msg.readByte()).toBe(3);
        expect(msg.readByte()).toBe(4);
      }
    );
  });

  it('clears to an empty message that can be written again', () => {
    const msg = Message.write(16);
    msg.writeBits(0b1111, 4);
    msg.clear();
    msg.writeBits(0b0001, 4);
    msg.beginReading();
    // The stale bits of the first pass are gone: the byte is entered clean.
    expect(msg.readBits(4)).toBe(0b0001);
  });

  it('compresses a run of the commonest byte to about a quarter of its size', () => {
    const msg = Message.write(1024);
    for (let i = 0; i < 400; i++) msg.writeByte(0);
    // Byte 0 costs two bits, so four hundred of them fit in about a hundred bytes.
    expect(msg.curSize).toBe(101);
  });
});
