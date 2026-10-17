import { describe, expect, it } from 'vitest';
import { parseMd3, type Md3Model, type Md3Tag } from '../formats/md3';
import { havePak0, openPak } from '../pak/pak-test-fixtures';
import { anglesToAxis, type Axis } from './hand-pose';
import {
  poseWeapon,
  posePlayer,
  positionEntityOnTag,
  positionRotatedEntityOnTag,
  type PosedModel
} from './player-pose';
import { IDENTITY_AXIS, matrixMultiply } from './q-math';

function expectVector(actual: readonly number[], expected: readonly number[], digits = 5): void {
  for (let i = 0; i < 3; i++) expect(actual[i], `[${i}]`).toBeCloseTo(expected[i], digits);
}

function expectAxis(actual: Axis, expected: Axis): void {
  for (let row = 0; row < 3; row++) expectVector(actual[row], expected[row]);
}

/** A model with only tags: each named tag's origin and axis, one entry per frame. */
function tagged(tags: Record<string, Array<{ origin: number[]; axis?: Axis }>>): Md3Model {
  const names = Object.keys(tags);
  const numFrames = Math.max(...names.map((name) => tags[name].length));
  return {
    name: 'models/test/tagged',
    numFrames,
    frames: [],
    tagNames: names,
    tags: Array.from({ length: numFrames }, (_, frame) =>
      names.map(
        (name): Md3Tag => ({
          name,
          origin: tags[name][frame].origin as [number, number, number],
          axis: tags[name][frame].axis ?? IDENTITY_AXIS
        })
      )
    ),
    surfaces: []
  };
}

/** A model placed at `origin`, turned by `axis`, still at its frame 0. */
function placed(model: Md3Model, origin: number[] = [0, 0, 0], axis: Axis = IDENTITY_AXIS): PosedModel {
  return { model, origin: origin as [number, number, number], axis, oldFrame: 0, frame: 0, backlerp: 0 };
}

describe('positionEntityOnTag', () => {
  it('moves the child along the parent’s own axes, turned as the parent is', () => {
    const parent = placed(tagged({ tag_a: [{ origin: [10, 0, 0] }] }), [100, 0, 0], anglesToAxis(0, 90, 0));
    const child = positionEntityOnTag(parent, 'tag_a');
    // The parent faces +Y, so 10 along its forward is 10 along the world's Y.
    expectVector(child.origin, [100, 10, 0]);
    expectAxis(child.axis, anglesToAxis(0, 90, 0));
  });

  it('reads the tag between the parent’s frames, at 1 − backlerp', () => {
    const model = tagged({ tag_a: [{ origin: [0, 0, 0] }, { origin: [10, 0, 0] }] });
    const parent: PosedModel = { ...placed(model), oldFrame: 0, frame: 1, backlerp: 0.25 };
    expectVector(positionEntityOnTag(parent, 'tag_a').origin, [7.5, 0, 0]);
  });

  it('treats a tag the model lacks as the identity at the parent’s origin', () => {
    const parent = placed(tagged({ tag_a: [{ origin: [10, 0, 0] }] }), [5, 6, 7], anglesToAxis(0, 30, 0));
    const child = positionEntityOnTag(parent, 'tag_missing');
    expectVector(child.origin, [5, 6, 7]);
    expectAxis(child.axis, anglesToAxis(0, 30, 0));
  });
});

describe('positionRotatedEntityOnTag', () => {
  it('turns the child inside the tag’s frame: child × tag × parent', () => {
    const tag = anglesToAxis(0, 90, 0);
    const parent = placed(tagged({ tag_a: [{ origin: [0, 0, 0], axis: tag }] }));
    const child = positionRotatedEntityOnTag(anglesToAxis(30, 0, 0), parent, 'tag_a');
    // Pitched 30° down within a frame that faces +Y: forward is along +Y, and down.
    expectVector(child.axis[0], [0, Math.cos(Math.PI / 6), -0.5]);
    expectAxis(
      positionRotatedEntityOnTag(IDENTITY_AXIS, parent, 'tag_a').axis,
      matrixMultiply(tag, IDENTITY_AXIS)
    );
  });
});

describe('posePlayer', () => {
  const models = {
    lower: tagged({ tag_torso: [{ origin: [0, 0, 10] }] }),
    upper: tagged({ tag_head: [{ origin: [0, 0, 16] }], tag_weapon: [{ origin: [6, -4, 0] }] }),
    head: tagged({ tag_head: [{ origin: [0, 0, 0] }] })
  };
  const still = { oldFrame: 0, frame: 0, backlerp: 0 };

  it('hangs the torso on the legs and the head on the torso, each turned by its own axis', () => {
    const pose = posePlayer(models, [1, 2, 3], {
      legs: anglesToAxis(0, 90, 0),
      torso: anglesToAxis(0, -90, 0),
      head: anglesToAxis(0, 45, 0)
    }, { legs: still, torso: { oldFrame: 3, frame: 4, backlerp: 0.5 } });

    expectVector(pose.legs.origin, [1, 2, 3]);
    expectVector(pose.torso.origin, [1, 2, 13]);
    // The torso's own −90° undoes the legs' 90°: it faces the world's +X.
    expectAxis(pose.torso.axis, IDENTITY_AXIS);
    expectVector(pose.head.origin, [1, 2, 29]);
    expectAxis(pose.head.axis, anglesToAxis(0, 45, 0));
    expect([pose.torso.oldFrame, pose.torso.frame, pose.torso.backlerp]).toEqual([3, 4, 0.5]);
    expect([pose.head.oldFrame, pose.head.frame, pose.head.backlerp]).toEqual([0, 0, 0]);
  });
});

describe('poseWeapon', () => {
  const gun = tagged({
    tag_barrel: [{ origin: [8, 0, 0] }],
    tag_flash: [{ origin: [20, 0, 1] }]
  });
  const torso: PosedModel = {
    ...placed(tagged({ tag_weapon: [{ origin: [6, -4, 0] }] }), [0, 0, 10]),
    oldFrame: 2,
    frame: 3,
    backlerp: 0.4
  };

  it('puts the gun on tag_weapon at its frame 0, carrying the torso’s backlerp', () => {
    const pose = poseWeapon(torso, gun, null, null);
    expectVector(pose.gun.origin, [6, -4, 10]);
    expect([pose.gun.oldFrame, pose.gun.frame, pose.gun.backlerp]).toEqual([0, 0, 0.4]);
    expect(pose.barrel).toBeNull();
    expect(pose.flash).toBeNull();
  });

  it('rolls the barrel and the flash about the gun’s forward, on their tags', () => {
    const pose = poseWeapon(torso, gun, 90, -10);
    expectVector(pose.barrel!.origin, [14, -4, 10]);
    expectAxis(pose.barrel!.axis, anglesToAxis(0, 0, 90));
    expectVector(pose.flash!.origin, [26, -4, 11]);
    expectAxis(pose.flash!.axis, anglesToAxis(0, 0, -10));
  });
});

describe.skipIf(!havePak0)('sarge standing idle (pak0)', () => {
  it('stands his torso and head where the 56-unit box expects them', async () => {
    const pak0 = await openPak('pak0.pk3');
    const part = async (name: string) =>
      parseMd3((await pak0.read(`models/players/sarge/${name}.md3`))!);
    const models = { lower: await part('lower'), upper: await part('upper'), head: await part('head') };
    // LEGS_IDLE's first frame and TORSO_STAND's, facing +X at the origin, 24 above the feet.
    const pose = posePlayer(
      models,
      [0, 0, 0],
      { legs: IDENTITY_AXIS, torso: IDENTITY_AXIS, head: IDENTITY_AXIS },
      { legs: { oldFrame: 166, frame: 166, backlerp: 0 }, torso: { oldFrame: 151, frame: 151, backlerp: 0 } }
    );
    // Measured: the feet reach 24.6 below the origin, and the head's base sits by the eye at 26.
    expect(models.lower.frames[166].mins[2]).toBeCloseTo(-24.6, 1);
    expect(pose.torso.origin[2]).toBeCloseTo(10.6, 1);
    expect(pose.head.origin[2]).toBeCloseTo(26.87, 2);
  });
});
