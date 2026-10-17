import { describe, expect, it } from 'vitest';
import { havePak0, openPak } from '../pak/pak-test-fixtures';
import { findTag, lerpTag, parseMd3, type Md3Model } from './md3';

/** Every weapon the plan needs, by its `models/weapons2/<w>/` directory name. */
const WEAPONS = [
  'gauntlet',
  'machinegun',
  'shotgun',
  'grenadel',
  'rocketl',
  'lightning',
  'railgun',
  'plasma',
  'bfg',
  'grapple'
];

/**
 * Build a synthetic MD3 so the parser's structure handling is covered without the pak: one
 * surface, one triangle, `frames` morph frames, and one tag per frame.
 */
function buildMd3(
  options: { frames?: number; tagOrigins?: number[][]; surfaceName?: string } = {}
): Uint8Array {
  const numFrames = options.frames ?? 1;
  const numTags = 1;
  const numVerts = 3;
  const numTris = 1;

  const HEADER = 108;
  const FRAME = 56;
  const TAG = 112;
  const SURF_HEADER = 108;
  const SHADER = 68;

  const ofsFrames = HEADER;
  const ofsTags = ofsFrames + numFrames * FRAME;
  const ofsSurfaces = ofsTags + numFrames * numTags * TAG;

  const ofsShaders = SURF_HEADER;
  const ofsTriangles = ofsShaders + SHADER;
  const ofsSt = ofsTriangles + numTris * 12;
  const ofsXyz = ofsSt + numVerts * 8;
  const surfEnd = ofsXyz + numFrames * numVerts * 8;

  const bytes = new Uint8Array(ofsSurfaces + surfEnd);
  const view = new DataView(bytes.buffer);
  const writeName = (at: number, text: string, width = 64) => {
    bytes.set(new TextEncoder().encode(text).subarray(0, width - 1), at);
  };

  view.setUint32(0, 0x33504449, true); // "IDP3"
  view.setInt32(4, 15, true);
  writeName(8, 'models/test/probe');
  view.setInt32(76, numFrames, true);
  view.setInt32(80, numTags, true);
  view.setInt32(84, 1, true); // numSurfaces
  view.setInt32(92, ofsFrames, true);
  view.setInt32(96, ofsTags, true);
  view.setInt32(100, ofsSurfaces, true);

  for (let f = 0; f < numFrames; f++) {
    const at = ofsFrames + f * FRAME;
    view.setFloat32(at, -1, true);
    view.setFloat32(at + 4, -2, true);
    view.setFloat32(at + 8, -3, true);
    view.setFloat32(at + 12, 4, true);
    view.setFloat32(at + 16, 5, true);
    view.setFloat32(at + 20, 6, true);
    view.setFloat32(at + 36, 7.5, true); // radius
    writeName(at + 40, `frame${f}`, 16);
  }

  for (let f = 0; f < numFrames; f++) {
    const at = ofsTags + f * numTags * TAG;
    writeName(at, 'tag_weapon');
    const origin = options.tagOrigins?.[f] ?? [f, 0, 0];
    view.setFloat32(at + 64, origin[0], true);
    view.setFloat32(at + 68, origin[1], true);
    view.setFloat32(at + 72, origin[2], true);
    // Identity axes.
    view.setFloat32(at + 76, 1, true);
    view.setFloat32(at + 92, 1, true);
    view.setFloat32(at + 108, 1, true);
  }

  const s = ofsSurfaces;
  view.setUint32(s, 0x33504449, true);
  writeName(s + 4, options.surfaceName ?? 'w_probe');
  view.setInt32(s + 72, numFrames, true);
  view.setInt32(s + 76, 1, true); // numShaders
  view.setInt32(s + 80, numVerts, true);
  view.setInt32(s + 84, numTris, true);
  view.setInt32(s + 88, ofsTriangles, true);
  view.setInt32(s + 92, ofsShaders, true);
  view.setInt32(s + 96, ofsSt, true);
  view.setInt32(s + 100, ofsXyz, true);
  view.setInt32(s + 104, surfEnd, true);

  writeName(s + ofsShaders, 'models/test/probe.TGA');
  for (let i = 0; i < 3; i++) view.setInt32(s + ofsTriangles + i * 4, i, true);
  for (let v = 0; v < numVerts; v++) {
    view.setFloat32(s + ofsSt + v * 8, v * 0.25, true);
    view.setFloat32(s + ofsSt + v * 8 + 4, 1 - v * 0.25, true);
  }
  for (let f = 0; f < numFrames; f++) {
    for (let v = 0; v < numVerts; v++) {
      const at = s + ofsXyz + (f * numVerts + v) * 8;
      view.setInt16(at, 64 * (v + 1), true); // 1, 2, 3 units after the 1/64 scale
      view.setInt16(at + 2, -64, true);
      view.setInt16(at + 4, 32 * f, true);
      view.setUint16(at + 6, 0, true); // lat 0, lng 0 -> +Z
    }
  }

  return bytes;
}

describe('parseMd3', () => {
  it('reads the header, frames and tags', () => {
    const model = parseMd3(buildMd3({ frames: 2 }));
    expect(model.name).toBe('models/test/probe');
    expect(model.numFrames).toBe(2);
    expect(model.tagNames).toEqual(['tag_weapon']);
    expect(model.frames[0].mins).toEqual([-1, -2, -3]);
    expect(model.frames[0].maxs).toEqual([4, 5, 6]);
    expect(model.frames[0].radius).toBe(7.5);
    expect(model.frames[1].name).toBe('frame1');
  });

  it('keeps surface names as the renderer does: lowercased, with a two-character _x ending cut', () => {
    // `tr_model.c:470–478`, so a LOD's surfaces match the skin's lines.
    const name = (surfaceName: string) => parseMd3(buildMd3({ surfaceName })).surfaces[0].name;
    expect(name('L_Legs_1')).toBe('l_legs');
    expect(name('u_torso_2')).toBe('u_torso');
    expect(name('h_head')).toBe('h_head');
    // Any character after the underscore, not only a digit; one ending only; never a whole name.
    expect(name('a_b_c')).toBe('a_b');
    expect(name('l_legs_12')).toBe('l_legs_12');
    expect(name('_b')).toBe('_b');
  });

  it('scales vertex shorts by 1/64 into Quake units', () => {
    const surface = parseMd3(buildMd3()).surfaces[0];
    expect([...surface.frames[0].positions]).toEqual([1, -1, 0, 2, -1, 0, 3, -1, 0]);
  });

  it('unpacks the lat/lng normal encoding', () => {
    // lat 0 / lng 0 is the +Z pole: sin(lng) is 0, so the latitude term drops out entirely.
    const normals = parseMd3(buildMd3()).surfaces[0].frames[0].normals;
    expect(normals[0]).toBeCloseTo(0, 6);
    expect(normals[1]).toBeCloseTo(0, 6);
    expect(normals[2]).toBeCloseTo(1, 6);
  });

  it('keeps every morph frame of a surface', () => {
    const surface = parseMd3(buildMd3({ frames: 3 })).surfaces[0];
    expect(surface.frames).toHaveLength(3);
    // Frame index drives the Z short, so the frames must not alias each other.
    expect(surface.frames[0].positions[2]).toBe(0);
    expect(surface.frames[1].positions[2]).toBe(0.5);
    expect(surface.frames[2].positions[2]).toBe(1);
  });

  it('reads indices, uvs and the embedded shader name', () => {
    const surface = parseMd3(buildMd3()).surfaces[0];
    expect([...surface.indices]).toEqual([0, 1, 2]);
    expect([...surface.uvs]).toEqual([0, 1, 0.25, 0.75, 0.5, 0.5]);
    // Case is preserved here; the pak lookup is what lowercases (zip.ts).
    expect(surface.shaders).toEqual(['models/test/probe.TGA']);
  });

  it('stores tags frame-major, so an animated tag differs per frame', () => {
    const model = parseMd3(buildMd3({ frames: 3, tagOrigins: [[0, 0, 0], [10, 0, 0], [20, 0, 0]] }));
    expect(findTag(model, 'tag_weapon', 0)!.origin[0]).toBe(0);
    expect(findTag(model, 'tag_weapon', 2)!.origin[0]).toBe(20);
    expect(findTag(model, 'tag_missing')).toBeUndefined();
  });

  it('rejects a file that is not an MD3', () => {
    expect(() => parseMd3(new Uint8Array(200))).toThrow(/not an MD3/);
  });

  it('rejects an unexpected version', () => {
    const bytes = buildMd3();
    new DataView(bytes.buffer).setInt32(4, 14, true);
    expect(() => parseMd3(bytes)).toThrow(/version 14/);
  });

  it('rejects a surface whose frame count disagrees with the model', () => {
    // Silently mis-indexing here would read another surface's vertices as morph targets.
    const bytes = buildMd3({ frames: 2 });
    expect(() => parseMd3(bytes)).not.toThrow();
    // Corrupt only the surface's own frame count, at ofsSurfaces + 72.
    new DataView(bytes.buffer).setInt32(108 + 2 * 56 + 2 * 112 + 72, 3, true);
    expect(() => parseMd3(bytes)).toThrow(/has 3 frames, model has 2/);
  });
});

describe('lerpTag', () => {
  const model = parseMd3(buildMd3({ frames: 2, tagOrigins: [[0, 0, 0], [10, 20, 30]] }));

  it('returns the start frame at frac 0 and the end frame at frac 1', () => {
    expect(lerpTag(model, 'tag_weapon', 0, 1, 0)!.origin).toEqual([0, 0, 0]);
    expect(lerpTag(model, 'tag_weapon', 0, 1, 1)!.origin).toEqual([10, 20, 30]);
  });

  it('interpolates the origin linearly', () => {
    expect(lerpTag(model, 'tag_weapon', 0, 1, 0.25)!.origin).toEqual([2.5, 5, 7.5]);
  });

  it('re-normalizes each axis row, as R_LerpTag does', () => {
    // Two identity frames make the averaged rows already unit-length; the guarantee that
    // matters is that every row comes out normalized regardless.
    const tag = lerpTag(model, 'tag_weapon', 0, 1, 0.5)!;
    for (const row of tag.axis) expect(Math.hypot(...row)).toBeCloseTo(1, 6);
  });

  it('clamps out-of-range frames rather than reading past the array', () => {
    expect(lerpTag(model, 'tag_weapon', -5, 99, 1)!.origin).toEqual([10, 20, 30]);
  });
});

// Guarded against the user's install — the numbers below are measured, then pinned.
describe.skipIf(!havePak0)('parseMd3 against retail pak0.pk3', () => {
  // One index of the 479 MB pak for the whole suite; each model is then one ranged read.
  let pak: ReturnType<typeof openPak> | undefined;
  const load = async (path: string): Promise<Md3Model> => {
    const archive = await (pak ??= openPak('pak0.pk3'));
    return parseMd3((await archive.read(path))!, path);
  };

  it('parses the rocket launcher to its recorded geometry', async () => {
    const model = await load('models/weapons2/rocketl/rocketl.md3');
    expect(model.name).toBe('models/weapons2/rocketl/rocketl.md3');
    expect(model.numFrames).toBe(1);
    expect(model.tagNames).toEqual(['tag_flash', 'tag_weapon']);
    expect(model.surfaces.map((s) => [s.name, s.numVerts, s.indices.length / 3])).toEqual([
      ['w_rocketl', 326, 249],
      ['w_rocketl01', 112, 156]
    ]);
    expect(model.surfaces[0].shaders).toEqual(['models/weapons2/rocketl/rocketl.TGA']);
  });

  it('places tag_flash at the rocket launcher muzzle', async () => {
    // 22.8 units down the barrel — the muzzle flash and the rocket both hang off this.
    const tag = findTag(await load('models/weapons2/rocketl/rocketl.md3'), 'tag_flash')!;
    expect(tag.origin[0]).toBeCloseTo(22.8125, 4);
    expect(Math.hypot(...tag.axis[0])).toBeCloseTo(1, 4);
  });

  it('parses every weapon model, flash and hand rig in the set', async () => {
    for (const weapon of WEAPONS) {
      const model = await load(`models/weapons2/${weapon}/${weapon}.md3`);
      expect(model.numFrames, weapon).toBe(1);
      expect(model.surfaces.length, weapon).toBeGreaterThan(0);
      expect(model.tagNames, weapon).toContain('tag_flash');
      expect(model.tagNames, weapon).toContain('tag_weapon');

      const flash = await load(`models/weapons2/${weapon}/${weapon}_flash.md3`);
      expect(flash.surfaces.length, weapon).toBeGreaterThan(0);
    }
  });

  it('confirms hand rigs are animated tags with no geometry', async () => {
    // Q3's first-person view is gun-only, and `_hand.md3` is a
    // pure animation rig. Nine weapons ship 16 frames; the grapple ships 15.
    for (const weapon of WEAPONS) {
      const hand = await load(`models/weapons2/${weapon}/${weapon}_hand.md3`);
      expect(hand.surfaces, weapon).toHaveLength(0);
      expect(hand.tagNames, weapon).toContain('tag_weapon');
      expect(hand.numFrames, weapon).toBe(weapon === 'grapple' ? 15 : 16);
    }
  });

  it('animates tag_weapon across the hand rig frames', async () => {
    // Frame 0 is idle and frame 11 is the bottom of the drop, so they must not coincide —
    // this is the entire source of viewmodel fire/raise/drop motion.
    const hand = await load('models/weapons2/rocketl/rocketl_hand.md3');
    const idle = findTag(hand, 'tag_weapon', 0)!;
    const dropped = findTag(hand, 'tag_weapon', 11)!;
    expect(idle.origin[0]).toBeCloseTo(-10.359, 2);
    expect(dropped.origin[0]).toBeCloseTo(-15.953, 2);

    const halfway = lerpTag(hand, 'tag_weapon', 0, 11, 0.5)!;
    expect(halfway.origin[0]).toBeCloseTo((-10.359 + -15.953) / 2, 2);
  });

  it('parses the barrel models, which only three weapons ship', async () => {
    // gauntlet / machinegun / bfg — the spinning parts.
    for (const weapon of ['gauntlet', 'machinegun', 'bfg']) {
      const barrel = await load(`models/weapons2/${weapon}/${weapon}_barrel.md3`);
      expect(barrel.surfaces.length, weapon).toBeGreaterThan(0);
    }
    // And the other seven genuinely ship none — a missing barrel is silently skipped by
    // `CG_RegisterWeapon`, so this is a data fact the viewmodel rig has to handle.
    const pak0 = await openPak('pak0.pk3');
    expect(pak0.entry('models/weapons2/rocketl/rocketl_barrel.md3')).toBeUndefined();
  });

  it('parses the rocket missile model used by both the rocket and the grapple hook', async () => {
    const rocket = await load('models/ammo/rocket/rocket.md3');
    expect(rocket.surfaces.map((s) => s.name)).toEqual(['flash', 'flare', 'rocket', 'fins']);
    // Multiple shaders per surface is the skin-flicker mechanism (`skinNum = clientFrame & 1`).
    expect(rocket.surfaces[0].shaders.length).toBeGreaterThan(1);
  });
});
