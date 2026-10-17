/**
 * Quake 3's message compression (`huffman.c`), which is an adaptive algorithm put to a static
 * use.
 *
 * `Huff_addRef` grows a tree one symbol at a time, promoting each symbol past its equals as its
 * weight rises — Vitter's algorithm, with a node's rank implied by where it sits in a
 * doubly-linked list rather than stored. Quake 3 runs that a million times at startup over a
 * frequency table measured from real traffic (`MSG_initHuffman`, msg.c:1669), and then never
 * touches the tree again: {@link Message} encodes and decodes through
 * `Huff_offsetTransmit`/`Huff_offsetReceive`, neither of which updates a weight. So what the
 * message layer actually uses is a fixed prefix code, and the adaptive machinery exists only to
 * derive it.
 *
 * That is why {@link HuffmanTree} carries a code table as well as a tree. `send()`
 * (huffman.c:301–316) walks from a leaf to the root on every symbol; since the tree is frozen,
 * the walk is done once here and the answer kept. Decoding still walks, because that is what
 * reading a prefix code is.
 *
 * The one adaptive use is {@link huffCompress}: a fresh tree per buffer, grown as it is coded,
 * which is how a `connect` packet's userinfo crosses before the two ends share anything.
 */

/** Largest symbol value, so the alphabet is 0–255 (`qcommon.h`, `HMAX`). */
const HMAX = 256;

/**
 * "Not yet transmitted": the leaf a symbol's first appearance is announced through. Every symbol
 * in Q3's table appears, so the finished tree's NYT leaf is unreachable by anything this encoder
 * writes — see {@link receiveSymbol}.
 */
const NYT = HMAX;

/** The symbol an interior node carries, which is no symbol at all. */
const INTERNAL_NODE = HMAX + 1;

/** `huff_t.nodeList[768]`: two nodes per symbol plus the NYT, with room to spare. */
const MAX_NODES = 768;

/** A null node or pointer index. The C uses `NULL`; an index array needs a value. */
const NIL = -1;

/** A code longer than this cannot be held in the table, and no sane frequency table makes one. */
const MAX_CODE_BITS = 32;

/**
 * A finished prefix code: the table to encode with, and the tree to decode with.
 *
 * Node indices are into {@link left}, {@link right} and {@link symbols} together. A node whose
 * symbol is not a real symbol is interior, and the walk continues through it.
 */
export interface HuffmanTree {
  /**
   * The bits of each symbol's code, packed with the **first bit sent in bit 0**, matching the
   * order `add_bit` lays them into the buffer (huffman.c:62–68).
   */
  readonly codes: Int32Array;
  /** How many of {@link codes}' bits each symbol uses. */
  readonly codeLengths: Uint8Array;
  /** Each node's left child, taken on a 0 bit; {@link NIL} on a leaf. */
  readonly left: Int32Array;
  /** Each node's right child, taken on a 1 bit; {@link NIL} on a leaf. */
  readonly right: Int32Array;
  /** Each node's symbol, or a value `>= 256` for an interior node or the NYT leaf. */
  readonly symbols: Int32Array;
  /** Where a decode starts. */
  readonly root: number;
}

/**
 * `huff_t` (qcommon.h:1185–1196): a tree that grows one symbol at a time, over parallel arrays
 * rather than linked structs.
 *
 * It starts as the NYT leaf alone (`Huff_Init`, huffman.c:435–449). Every symbol counted into it
 * with {@link addRef} gets a leaf the first time and a heavier one after, and the tree reshapes so
 * that heavier symbols sit nearer the root.
 */
class AdaptiveHuffman {
  // node_t, as parallel arrays. `head` is `node_t **head` in the C — a pointer into `nodePtrs`,
  // shared by every node of equal weight so that promoting one promotes the block. Here it is an
  // index into `ptrs`, and `ptrs[i]` holds a node index.
  readonly left = new Int32Array(MAX_NODES).fill(NIL);
  readonly right = new Int32Array(MAX_NODES).fill(NIL);
  readonly symbols = new Int32Array(MAX_NODES);
  private readonly parent = new Int32Array(MAX_NODES).fill(NIL);
  private readonly next = new Int32Array(MAX_NODES).fill(NIL);
  private readonly prev = new Int32Array(MAX_NODES).fill(NIL);
  private readonly head = new Int32Array(MAX_NODES).fill(NIL);
  private readonly weight = new Int32Array(MAX_NODES);

  private readonly ptrs = new Int32Array(MAX_NODES).fill(NIL);
  /** The freelist `free_ppnode` threads through the slots it releases. */
  private readonly ptrNext = new Int32Array(MAX_NODES).fill(NIL);

  private nodeCount = 0;
  private ptrCount = 0;
  private freelist = NIL;
  root = NIL;
  /** `huff_t.lhead`: the lowest-ranked node, which is always the NYT. */
  private listHead = NIL;
  /** `huff_t.loc`: each symbol's leaf, or {@link NIL} for one not yet seen. */
  private readonly leafOf = new Int32Array(HMAX + 1).fill(NIL);

  constructor() {
    this.root = this.listHead = this.nodeCount++;
    this.leafOf[NYT] = this.root;
    this.symbols[this.root] = NYT;
    this.weight[this.root] = 0;
  }

  /**
   * `Huff_addRef` (huffman.c:196–262): count one occurrence of a symbol. A symbol seen for the
   * first time splits the NYT leaf into an interior node with the old NYT on the left and the new
   * symbol on the right.
   */
  addRef(symbol: number): void {
    const { left, right, symbols, parent, next, prev, head, weight, ptrs, leafOf } = this;
    if (leafOf[symbol] !== NIL) {
      this.increment(leafOf[symbol]);
      return;
    }

    const listHead = this.listHead;
    const leaf = this.nodeCount++;
    const branch = this.nodeCount++;

    symbols[branch] = INTERNAL_NODE;
    weight[branch] = 1;
    next[branch] = next[listHead];
    if (next[listHead] !== NIL) {
      prev[next[listHead]] = branch;
      if (weight[next[listHead]] === 1) {
        head[branch] = head[next[listHead]];
      } else {
        head[branch] = this.takePtr();
        ptrs[head[branch]] = branch;
      }
    } else {
      head[branch] = this.takePtr();
      ptrs[head[branch]] = branch;
    }
    next[listHead] = branch;
    prev[branch] = listHead;

    symbols[leaf] = symbol;
    weight[leaf] = 1;
    next[leaf] = next[listHead];
    if (next[listHead] !== NIL) {
      prev[next[listHead]] = leaf;
      // The node just linked in is the branch, whose weight is 1, so this is the branch's block.
      head[leaf] = head[next[listHead]];
    } else {
      head[leaf] = this.takePtr();
      ptrs[head[leaf]] = leaf;
    }
    next[listHead] = leaf;
    prev[leaf] = listHead;
    left[leaf] = right[leaf] = NIL;

    if (parent[listHead] !== NIL) {
      // The NYT is always a left child, so the branch takes its place there.
      if (left[parent[listHead]] === listHead) left[parent[listHead]] = branch;
      else right[parent[listHead]] = branch;
    } else {
      this.root = branch;
    }

    right[branch] = leaf;
    left[branch] = listHead;
    parent[branch] = parent[listHead];
    parent[listHead] = parent[leaf] = branch;

    leafOf[symbol] = leaf;
    this.increment(parent[branch]);
  }

  /**
   * The bits of a symbol's code, root first: `send()`'s walk from its leaf up (huffman.c:306–321),
   * read back down. A symbol not yet seen has no leaf, and gets an empty code.
   */
  code(symbol: number): number[] {
    const path: number[] = [];
    const { parent, right } = this;
    const leaf = this.leafOf[symbol];
    if (leaf === NIL) return path;
    for (let node = leaf; parent[node] !== NIL; node = parent[node]) {
      path.push(right[parent[node]] === node ? 1 : 0);
    }
    return path.reverse();
  }

  /** Whether a symbol has a leaf yet: `huff->loc[ch] != NULL`. */
  seen(symbol: number): boolean {
    return this.leafOf[symbol] !== NIL;
  }

  private takePtr(): number {
    if (this.freelist === NIL) return this.ptrCount++;
    const slot = this.freelist;
    this.freelist = this.ptrNext[slot];
    return slot;
  }

  private releasePtr(slot: number): void {
    this.ptrs[slot] = NIL;
    this.ptrNext[slot] = this.freelist;
    this.freelist = slot;
  }

  /** `swap` (huffman.c:92–119): exchange two nodes' places in the tree. */
  private swapNodes(a: number, b: number): void {
    const { left, right, parent } = this;
    const parentA = parent[a];
    const parentB = parent[b];

    if (parentA !== NIL) {
      if (left[parentA] === a) left[parentA] = b;
      else right[parentA] = b;
    } else {
      this.root = b;
    }
    if (parentB !== NIL) {
      if (left[parentB] === b) left[parentB] = a;
      else right[parentB] = a;
    } else {
      this.root = a;
    }

    parent[a] = parentB;
    parent[b] = parentA;
  }

  /** `swaplist` (huffman.c:122–148): exchange two nodes' places in the rank list. */
  private swapList(a: number, b: number): void {
    const { next, prev } = this;
    let t = next[a];
    next[a] = next[b];
    next[b] = t;

    t = prev[a];
    prev[a] = prev[b];
    prev[b] = t;

    if (next[a] === a) next[a] = b;
    if (next[b] === b) next[b] = a;
    if (next[a] !== NIL) prev[next[a]] = a;
    if (next[b] !== NIL) prev[next[b]] = b;
    if (prev[a] !== NIL) next[prev[a]] = a;
    if (prev[b] !== NIL) next[prev[b]] = b;
  }

  /**
   * `increment` (huffman.c:151–186): add one to a node's weight and to every ancestor's, moving
   * it past the block of equal weight first so the list stays ordered. The recursion is bounded
   * by the tree's height.
   */
  private increment(node: number): void {
    if (node === NIL) return;
    const { parent, next, prev, head, weight, ptrs } = this;

    if (next[node] !== NIL && weight[next[node]] === weight[node]) {
      const leader = ptrs[head[node]];
      if (leader !== parent[node]) this.swapNodes(leader, node);
      this.swapList(leader, node);
    }

    if (prev[node] !== NIL && weight[prev[node]] === weight[node]) {
      ptrs[head[node]] = prev[node];
    } else {
      this.releasePtr(head[node]);
    }

    weight[node]++;

    if (next[node] !== NIL && weight[next[node]] === weight[node]) {
      head[node] = head[next[node]];
    } else {
      head[node] = this.takePtr();
      ptrs[head[node]] = node;
    }

    if (parent[node] === NIL) return;

    this.increment(parent[node]);
    if (prev[node] === parent[node]) {
      this.swapList(node, parent[node]);
      if (ptrs[head[node]] === node) ptrs[head[node]] = parent[node];
    }
  }
}

/**
 * Build the tree Quake 3 builds, by referencing each symbol as many times as the table says.
 *
 * This is `MSG_initHuffman` (msg.c:1669–1680) and the `Huff_addRef` chain under it. The result is
 * deterministic: the same frequencies always give the same tree, because every tie is broken by
 * list position and the list is built in the same order.
 *
 * @param frequencies - One count per symbol, 256 of them, each at least one. A symbol that is
 *   never referenced never gets a leaf, and would have to be sent through the NYT escape the
 *   message layer does not use; Quake 3's own table has no zero in it, so the case cannot arise.
 * @returns The finished tree and its code table.
 */
export function buildHuffmanTree(frequencies: readonly number[]): HuffmanTree {
  if (frequencies.length !== HMAX) {
    throw new Error(`huffman: expected ${HMAX} frequencies, got ${frequencies.length}`);
  }
  const unseen = frequencies.findIndex((count) => !Number.isInteger(count) || count < 1);
  if (unseen !== -1) {
    throw new Error(`huffman: symbol ${unseen} has no occurrences, so it would have no code`);
  }

  const huff = new AdaptiveHuffman();
  for (let symbol = 0; symbol < HMAX; symbol++) {
    const count = frequencies[symbol];
    for (let i = 0; i < count; i++) huff.addRef(symbol);
  }

  // `send()`, done once for every symbol.
  const codes = new Int32Array(HMAX);
  const codeLengths = new Uint8Array(HMAX);
  for (let symbol = 0; symbol < HMAX; symbol++) {
    const path = huff.code(symbol);
    if (path.length > MAX_CODE_BITS) {
      throw new Error(`huffman: symbol ${symbol} needs ${path.length} bits`);
    }
    let code = 0;
    // The root's bit is sent first, so it goes in bit 0.
    for (let i = 0; i < path.length; i++) code |= path[i] << i;
    codes[symbol] = code;
    codeLengths[symbol] = path.length;
  }

  return {
    codes,
    codeLengths,
    left: huff.left,
    right: huff.right,
    symbols: huff.symbols,
    root: huff.root
  };
}

/**
 * `Huff_Compress` (huffman.c:397–433): everything after `offset` coded through a tree of its own,
 * grown as it goes, behind a two-byte length.
 *
 * A symbol's first appearance goes as the NYT's code and then its eight bits, high bit first; each
 * after goes as its code in the tree as it stands. Nothing is shared with the far end but the
 * rules, so the reader grows the same tree as it reads.
 *
 * Quake 3 stops a code's bits at the input's own size, so a buffer that codes larger than it is
 * comes out garbled. A short userinfo does. The port bounds nothing, since a buffer here is only
 * ever a `connect`.
 *
 * @param data - The buffer, whose first `offset` bytes stay as they are.
 * @returns a new buffer; the input itself if nothing follows `offset`
 */
export function huffCompress(data: Uint8Array, offset: number): Uint8Array {
  const size = data.length - offset;
  if (size <= 0) return data;

  const huff = new AdaptiveHuffman();
  // Two bytes of length, the byte `bloc += 8` steps into, and 32 bits a symbol, which no code in
  // a buffer this short reaches.
  const seq = new Uint8Array(3 + size * 4);
  seq[0] = (size >> 8) & 0xff;
  seq[1] = size & 0xff;

  let bloc = 16;
  const addBit = (bit: number): void => {
    if ((bloc & 7) === 0) seq[bloc >> 3] = 0;
    seq[bloc >> 3] |= bit << (bloc & 7);
    bloc++;
  };

  for (let i = 0; i < size; i++) {
    const ch = data[offset + i];
    if (huff.seen(ch)) {
      for (const bit of huff.code(ch)) addBit(bit);
    } else {
      for (const bit of huff.code(NYT)) addBit(bit);
      for (let b = 7; b >= 0; b--) addBit((ch >> b) & 1);
    }
    huff.addRef(ch);
  }

  // "next byte": one past the byte the last bit fell in.
  bloc += 8;

  const out = new Uint8Array(offset + (bloc >> 3));
  out.set(data.subarray(0, offset));
  out.set(seq.subarray(0, bloc >> 3), offset);
  return out;
}

/**
 * `Huff_Decompress` (huffman.c:343–393): {@link huffCompress} undone.
 *
 * The length at the front is believed up to `maxSize`, and a buffer that runs out before it ends
 * is cut short with a NUL, as Quake 3 does it.
 *
 * @param data - The buffer, whose first `offset` bytes stay as they are.
 * @param maxSize - The room the whole result has, which bounds what the length can claim.
 * @returns a new buffer; the input itself if nothing follows `offset`
 */
export function huffDecompress(data: Uint8Array, offset: number, maxSize: number): Uint8Array {
  const size = data.length - offset;
  if (size <= 0) return data;

  const huff = new AdaptiveHuffman();
  let cch = data[offset] * 256 + (data[offset + 1] ?? 0);
  if (cch > maxSize - offset) cch = maxSize - offset;

  let bloc = 16;
  // Past the end reads zeros, where Quake 3 reads whatever the buffer holds there.
  const getBit = (): number => {
    const bit = ((data[offset + (bloc >> 3)] ?? 0) >> (bloc & 7)) & 1;
    bloc++;
    return bit;
  };

  const seq = new Uint8Array(cch);
  for (let j = 0; j < cch; j++) {
    if (bloc >> 3 > size) {
      seq[j] = 0;
      break;
    }
    let ch = receiveSymbol(huff, getBit);
    if (ch === NYT) {
      ch = 0;
      for (let i = 0; i < 8; i++) ch = (ch << 1) + getBit();
    }
    seq[j] = ch;
    huff.addRef(ch);
  }

  const out = new Uint8Array(offset + cch);
  out.set(data.subarray(0, offset));
  out.set(seq, offset);
  return out;
}

/**
 * Read one symbol out of a bit stream (`Huff_offsetReceive`, huffman.c:279–299).
 *
 * A stream this module wrote never reaches the NYT leaf, because every symbol has a code of its
 * own; a corrupt one can, and returns {@link NYT} — a value of 256, outside the alphabet — rather
 * than a byte. Quake 3 behaves the same way and lets the caller carry the nonsense onward.
 *
 * @param tree - The tree to walk.
 * @param readBit - Yields the next bit of the stream.
 * @returns The symbol, 0–255, or 256 for the NYT leaf.
 */
export function receiveSymbol(
  tree: Pick<HuffmanTree, 'left' | 'right' | 'symbols' | 'root'>,
  readBit: () => number
): number {
  let node = tree.root;
  while (tree.symbols[node] === INTERNAL_NODE) {
    node = readBit() ? tree.right[node] : tree.left[node];
  }
  return tree.symbols[node];
}

/** Q3's tree, built on first use as `MSG_Init` builds it, and kept for the process. */
let cached: HuffmanTree | null = null;

/**
 * The tree every Quake 3 message is coded with, built from {@link MESSAGE_FREQUENCIES}.
 *
 * Building costs about a million `addRef` calls, so it happens once, on the first message rather
 * than at import: `MSG_Init` does the same through its `msgInit` flag (msg.c:44–46).
 */
export function messageHuffmanTree(): HuffmanTree {
  if (!cached) cached = buildHuffmanTree(MESSAGE_FREQUENCIES);
  return cached;
}

/**
 * `msg_hData` (msg.c:1410–1667): how often each byte appeared in the traffic id measured, which
 * is the whole of the protocol's compression. The counts total 1,053,340 and give a mean of about
 * 6.3 bits per byte on data shaped like that traffic.
 */
export const MESSAGE_FREQUENCIES: readonly number[] = [
  250315,  41193,   6292,   7106,   3730,   3750,   6110,  23283,
   33317,   6950,   7838,   9714,   9257,  17259,   3949,   1778,
    8288,   1604,   1590,   1663,   1100,   1213,   1238,   1134,
    1749,   1059,   1246,   1149,   1273,   4486,   2805,   3472,
   21819,   1159,   1670,   1066,   1043,   1012,   1053,   1070,
    1726,    888,   1180,    850,    960,    780,   1752,   3296,
   10630,   4514,   5881,   2685,   4650,   3837,   2093,   1867,
    2584,   1949,   1972,    940,   1134,   1788,   1670,   1206,
    5719,   6128,   7222,   6654,   3710,   3795,   1492,   1524,
    2215,   1140,   1355,    971,   2180,   1248,   1328,   1195,
    1770,   1078,   1264,   1266,   1168,    965,   1155,   1186,
    1347,   1228,   1529,   1600,   2617,   2048,   2546,   3275,
    2410,   3585,   2504,   2800,   2675,   6146,   3663,   2840,
   14253,   3164,   2221,   1687,   3208,   2739,   3512,   4796,
    4091,   3515,   5288,   4016,   7937,   6031,   5360,   3924,
    4892,   3743,   4566,   4807,   5852,   6400,   6225,   8291,
   23243,   7838,   7073,   8935,   5437,   4483,   3641,   5256,
    5312,   5328,   5370,   3492,   2458,   1694,   1821,   2121,
    1916,   1149,   1516,   1367,   1236,   1029,   1258,   1104,
    1245,   1006,   1149,   1025,   1241,    952,   1287,    997,
    1713,   1009,   1187,    879,   1099,    929,   1078,    951,
    1656,    930,   1153,   1030,   1262,   1062,   1214,   1060,
    1621,    930,   1106,    912,   1034,    892,   1158,    990,
    1175,    850,   1121,    903,   1087,    920,   1144,   1056,
    3462,   2240,   4397,  12136,   7758,   1345,   1307,   3278,
    1950,    886,   1023,   1112,   1077,   1042,   1061,   1071,
    1484,   1001,   1096,    915,   1052,    995,   1070,    876,
    1111,    851,   1059,    805,   1112,    923,   1103,    817,
    1899,   1872,    976,    841,   1127,    956,   1159,    950,
    7791,    954,   1289,    933,   1127,   3207,   1020,    927,
    1355,    768,   1040,    745,    952,    805,   1073,    740,
    1013,    805,   1008,    796,    996,   1057,  11457,  13504
];
