import { describe, expect, it, vi } from 'vitest';
import { blobSource, httpSource, memorySource } from './byte-source';

const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);

describe('memorySource', () => {
  it('reads views of the bytes, not copies', async () => {
    const read = await memorySource('m', bytes).read(10, 5);
    expect([...read]).toEqual([10, 11, 12, 13, 14]);
    expect(read.buffer).toBe(bytes.buffer);
  });

  it('tells the progress once, whole, since the bytes are all there', async () => {
    const heard: [number, number][] = [];
    await memorySource('m', bytes).read(10, 5, (received, total) => heard.push([received, total]));
    expect(heard).toEqual([[5, 5]]);
  });

  it('rejects a range that leaves the source', async () => {
    const source = memorySource('m', bytes);
    await expect(source.read(98, 3)).rejects.toThrow(RangeError);
    await expect(source.read(-1, 1)).rejects.toThrow(RangeError);
    expect((await source.read(100, 0)).byteLength).toBe(0);
  });
});

describe('blobSource', () => {
  it("slices the blob, and takes its label from a File's name", async () => {
    const source = blobSource(new File([bytes], 'pak0.pk3'));
    expect(source.label).toBe('pak0.pk3');
    expect(source.size).toBe(100);
    expect([...(await source.read(95, 5))]).toEqual([95, 96, 97, 98, 99]);
  });

  it('rejects a range past the end', async () => {
    await expect(blobSource(new Blob([bytes]), 'b').read(96, 5)).rejects.toThrow(RangeError);
  });

  it('tells the progress once the slice is read', async () => {
    const heard: [number, number][] = [];
    const source = blobSource(new Blob([bytes]), 'b');
    await source.read(0, 8, (received, total) => heard.push([received, total]));
    expect(heard).toEqual([[8, 8]]);
  });
});

describe('httpSource', () => {
  /** A fetch answering every request with `status` and `body`, keeping the Range asked for. */
  function answering(status: number, body: Uint8Array<ArrayBuffer>) {
    const ranges: (string | null)[] = [];
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      ranges.push(new Headers(init?.headers).get('Range'));
      return new Response(body, { status });
    });
    return { fetchFn, ranges };
  }

  it('asks for the range, inclusive, and returns the 206 body', async () => {
    const { fetchFn, ranges } = answering(206, bytes.slice(10, 20));
    const source = httpSource('/baseq3/pak0.pk3', 'pak0.pk3', 100, fetchFn);
    expect([...(await source.read(10, 10))]).toEqual([...bytes.slice(10, 20)]);
    expect(ranges).toEqual(['bytes=10-19']);
    expect(fetchFn).toHaveBeenCalledWith('/baseq3/pak0.pk3', expect.anything());
  });

  it('refuses a 200, which would be the whole pak', async () => {
    const { fetchFn } = answering(200, bytes);
    await expect(httpSource('/p', 'pak0.pk3', 100, fetchFn).read(0, 10)).rejects.toThrow(
      /pak0\.pk3: expected 206 for bytes 0-9, got 200/
    );
  });

  it('rejects a short body', async () => {
    const { fetchFn } = answering(206, bytes.slice(0, 5));
    await expect(httpSource('/p', 'pak0.pk3', 100, fetchFn).read(0, 10)).rejects.toThrow(
      /asked for 10 bytes at 0, got 5/
    );
  });

  it('refuses a range past the end without asking the server', async () => {
    const { fetchFn } = answering(206, bytes);
    await expect(httpSource('/p', 'pak0.pk3', 100, fetchFn).read(95, 10)).rejects.toThrow(RangeError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  /** A 206 whose body arrives in the given pieces, as a slow download does. */
  function inPieces(pieces: Uint8Array<ArrayBuffer>[]): typeof fetch {
    return vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const piece of pieces) controller.enqueue(piece);
          controller.close();
        }
      });
      return new Response(body, { status: 206 });
    });
  }

  it('tells the progress as each piece of the body comes in', async () => {
    const fetchFn = inPieces([bytes.slice(10, 14), bytes.slice(14, 15), bytes.slice(15, 20)]);
    const heard: [number, number][] = [];
    const read = await httpSource('/p', 'pak0.pk3', 100, fetchFn).read(10, 10, (received, total) =>
      heard.push([received, total])
    );
    expect([...read]).toEqual([...bytes.slice(10, 20)]);
    expect(heard).toEqual([
      [4, 10],
      [5, 10],
      [10, 10]
    ]);
  });

  it('rejects a watched body that runs short or long', async () => {
    const short = httpSource('/p', 'pak0.pk3', 100, inPieces([bytes.slice(0, 4)]));
    await expect(short.read(0, 10, () => {})).rejects.toThrow(/asked for 10 bytes at 0, got 4/);
    const pieces = inPieces([bytes.slice(0, 6), bytes.slice(6, 12)]);
    const long = httpSource('/p', 'pak0.pk3', 100, pieces);
    await expect(long.read(0, 10, () => {})).rejects.toThrow(/asked for 10 bytes at 0, got 12/);
  });

  it('reads nothing for an empty range, which Range cannot spell', async () => {
    const { fetchFn } = answering(206, bytes);
    expect((await httpSource('/p', 'pak0.pk3', 100, fetchFn).read(50, 0)).byteLength).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
