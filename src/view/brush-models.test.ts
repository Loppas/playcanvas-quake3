import { describe, expect, it } from 'vitest';

import { readEntities } from '../formats/entity-text';
import { brushModelsAtRest, moverModel2s } from './brush-models';

/** Inline models of these bounds, the world's first. */
function models(...bounds: [number[], number[]][]) {
  return [[[0, 0, 0], [0, 0, 0]] as [number[], number[]], ...bounds].map(([mins, maxs]) => ({
    mins: mins as [number, number, number],
    maxs: maxs as [number, number, number]
  }));
}

/** A map's entities from blocks of pairs, worldspawn first. */
function entities(...blocks: Record<string, string>[]) {
  const text = [{ classname: 'worldspawn' }, ...blocks]
    .map((pairs) => `{\n${Object.entries(pairs).map(([k, v]) => `"${k}" "${v}"`).join('\n')}\n}`)
    .join('\n');
  return readEntities(text);
}

const CUBE: [number[], number[]] = [
  [0, 0, 0],
  [64, 64, 100]
];

describe('brushModelsAtRest', () => {
  it('stands each mover where its spawn function puts it, in entity order', () => {
    const poses = brushModelsAtRest(
      entities(
        { classname: 'func_static', model: '*2', origin: '1 2 3' },
        { classname: 'func_button', model: '*1', origin: '4 5 6', angle: '90' },
        { classname: 'func_door', model: '*3', angle: '-1' },
        {
          classname: 'func_rotating',
          model: '*4',
          origin: '-3200 -2444 -28',
          model2: 'models/x.md3'
        },
        { classname: 'func_bobbing', model: '*5', origin: '0 0 8', phase: '0.5' },
        { classname: 'func_pendulum', model: '*6', angles: '0 45 10' }
      ),
      models(CUBE, CUBE, CUBE, CUBE, CUBE, CUBE)
    );
    expect(poses).toEqual([
      { model: 2, origin: [1, 2, 3], angles: [0, 0, 0] },
      { model: 1, origin: [4, 5, 6], angles: [0, 0, 0] },
      { model: 3, origin: [0, 0, 0], angles: [0, 0, 0] },
      { model: 4, origin: [-3200, -2444, -28], angles: [0, 0, 0], model2: 'models/x.md3' },
      { model: 5, origin: [0, 0, 8], angles: [0, 0, 0] },
      { model: 6, origin: [0, 0, 0], angles: [0, 45, 10] }
    ]);
  });

  it('rests a door that starts open at its far end, by its bounds spread a unit each way', () => {
    const [up, east] = brushModelsAtRest(
      entities(
        { classname: 'func_door', model: '*1', angle: '-1', spawnflags: '1' },
        {
          classname: 'func_door',
          model: '*1',
          angle: '0',
          spawnflags: '1',
          lip: '2',
          origin: '10 0 0'
        }
      ),
      models(CUBE)
    );
    // Up 102 high less the default lip of 8; east 66 wide less a lip of 2.
    expect(up.origin).toEqual([0, 0, 94]);
    expect(east.origin).toEqual([74, 0, 0]);
  });

  it('rests a platform at the bottom: its height, or its own height less its lip', () => {
    const [plain, given] = brushModelsAtRest(
      entities(
        { classname: 'func_plat', model: '*1', origin: '0 0 200' },
        { classname: 'func_plat', model: '*1', height: '50', lip: '30' }
      ),
      models(CUBE)
    );
    expect(plain.origin).toEqual([0, 0, 200 - 94]);
    expect(given.origin).toEqual([0, 0, -50]);
  });

  it('starts a train at its first corner once its corners close a ring, else at the origin', () => {
    const corners: Record<string, string>[] = [
      { classname: 'path_corner', targetname: 'A', target: 'b', origin: '10 20 30' },
      { classname: 'target_delay', targetname: 'b' },
      { classname: 'path_corner', targetname: 'b', target: 'a', origin: '40 50 60' }
    ];
    const ring = brushModelsAtRest(
      entities({ classname: 'func_train', model: '*1', target: 'a' }, ...corners),
      models(CUBE)
    );
    expect(ring).toEqual([{ model: 1, origin: [10, 20, 30], angles: [0, 0, 0] }]);

    const broken = brushModelsAtRest(
      entities(
        { classname: 'func_train', model: '*1', target: 'a' },
        { classname: 'path_corner', targetname: 'a', origin: '10 20 30' }
      ),
      models(CUBE)
    );
    expect(broken[0].origin).toEqual([0, 0, 0]);
    // With no target at all the train is freed.
    const lost = entities({ classname: 'func_train', model: '*1' });
    expect(brushModelsAtRest(lost, models(CUBE))).toEqual([]);
  });

  it('keeps only what a free-for-all keeps, and draws no other classname', () => {
    const poses = brushModelsAtRest(
      entities(
        { classname: 'func_door', model: '*1', notfree: '1' },
        { classname: 'func_door', model: '*2', notteam: '1' },
        { classname: 'func_static', model: '*3', gametype: 'ctf' },
        { classname: 'trigger_multiple', model: '*4' }
      ),
      models(CUBE, CUBE, CUBE, CUBE)
    );
    expect(poses.map((pose) => pose.model)).toEqual([2]);
  });

  it("refuses a mover's model in Q3's words", () => {
    const rest = (pairs: Record<string, string>) => () =>
      brushModelsAtRest(entities({ classname: 'func_static', ...pairs }), models(CUBE));
    expect(rest({})).toThrow(new Error('SV_SetBrushModel: NULL'));
    expect(rest({ model: 'models/x.md3' })).toThrow(
      new Error("SV_SetBrushModel: models/x.md3 isn't a brush model")
    );
    expect(rest({ model: '*2' })).toThrow(new Error('CM_InlineModel: bad number'));
    expect(rest({ model: '*-1' })).toThrow(new Error('CM_InlineModel: bad number'));
  });
});

describe('moverModel2s', () => {
  it("gives each mover's model2 by its inline model, whatever gametype keeps it", () => {
    const model2s = moverModel2s(
      entities(
        { classname: 'func_door', model: '*1', model2: 'models/a.md3', notfree: '1' },
        { classname: 'func_static', model: '*2' },
        { classname: 'func_rotating', model: '*3', model2: 'models/b.md3', gametype: 'ctf' },
        { classname: 'trigger_multiple', model: '*4', model2: 'models/c.md3' }
      ),
      5
    );
    expect([...model2s]).toEqual([
      [1, 'models/a.md3'],
      [3, 'models/b.md3']
    ]);
  });

  it('leaves out a model the map has not got, and keeps the first a model is named with', () => {
    const model2s = moverModel2s(
      entities(
        { classname: 'func_static', model: '*0', model2: 'models/a.md3' },
        { classname: 'func_static', model: '*2', model2: 'models/b.md3' },
        { classname: 'func_static', model: 'models/x.md3', model2: 'models/c.md3' },
        { classname: 'func_static', model: '*1', model2: 'models/d.md3' },
        { classname: 'func_bobbing', model: '*1', model2: 'models/e.md3' }
      ),
      2
    );
    expect([...model2s]).toEqual([[1, 'models/d.md3']]);
  });
});
