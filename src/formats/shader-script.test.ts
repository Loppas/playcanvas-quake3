import { describe, expect, it } from 'vitest';
import { havePak, openPak } from '../pak/pak-test-fixtures';
import { PakFileSystem } from '../pak/vfs';
import { shaderTextOrder } from './asset-library';
import {
  SS_BANNER,
  SS_BLEND1,
  SS_DECAL,
  SS_ENVIRONMENT,
  SS_NEAREST,
  SS_OPAQUE,
  SS_PORTAL,
  SS_SEE_THROUGH,
  SS_UNDERWATER,
  compress,
  diffuseReference,
  isSpriteDeform,
  parseShader,
  parseShaderScripts,
  type ShaderScript
} from './shader-script';

/** C's float, as the parse keeps a number. */
const f = Math.fround;

/** The shader `s`, read from `text`. */
function shaderOf(text: string): ShaderScript {
  return parseShaderScripts([text]).get('s')!;
}

/** The first stage of a shader `s` whose one stage is `body`, a line each part. */
function stageOf(body: string) {
  return shaderOf(`s {\n{\nmap t.tga\n${body}\n}\n}`).stages[0];
}

describe('parseShaderScripts: the text, as COM_Compress and COM_ParseExt cut it', () => {
  it('strips line and block comments', () => {
    const shaders = parseShaderScripts([
      `// leading comment
       thing
       {
         /* a block
            comment */
         { map t.tga } // trailing
       }`
    ]);
    expect(shaders.get('thing')!.stages[0].maps).toEqual(['t.tga']);
  });

  it('joins the words a block comment sits between, and cuts one at a line comment', () => {
    // `COM_Compress` drops a block comment whole, leaving no space, and starts a line comment
    // anywhere in a word.
    expect(compress('map a/* x */b.tga')).toBe('map ab.tga');
    expect(compress('map a.tga// rest\nnext')).toBe('map a.tga\nnext');
    // Each run of spaces is one, and each run of line breaks one; a lone return is a break.
    expect(compress('a  \t b\r\n\r\nc\rd')).toBe('a b\nc\nd');
    expect(shaderOf('s { { map a/**/b.tga } }').stages[0].maps).toEqual(['ab.tga']);
  });

  it('reads a quoted string as one token, and a byte past 127 as a space between two', () => {
    expect(shaderOf('s { { map "a b.tga" } }').stages[0].maps).toEqual(['a b.tga']);
    expect(compress('"a // b"')).toBe('"a // b"');
    // A `char` past 127 is negative on x86, below a space.
    expect(shaderOf('s { { map a.tgaéblendFunc add } }').stages[0]).toMatchObject({
      maps: ['a.tga'],
      blend: 'add'
    });
  });

  it('lowercases names so an MD3 surface reference matches whatever case it used', () => {
    const shaders = parseShaderScripts([`Models/Weapons2/BFG/BFG { { map x.tga } }`]);
    expect(shaders.get('models/weapons2/bfg/bfg')).toBeDefined();
  });

  it('keeps the first definition when a name is defined twice', () => {
    // As FindShaderInShaderText finds it, the first in the joined text.
    const shaders = parseShaderScripts([`dup { { map a.tga } }`, `dup { { map b.tga } }`]);
    expect(shaders.get('dup')!.stages[0].maps).toEqual(['a.tga']);
  });

  it("leaves out a file whose braces don't match, warning of it, as ScanAndLoadShaderFiles does", () => {
    const warnings: string[] = [];
    const shaders = parseShaderScripts(
      [
        { name: 'scripts/good.shader', text: 'good { { map g.tga } }' },
        { name: 'scripts/open.shader', text: 'kept { }\n// a note\nMade by me\n{ }' },
        { name: 'scripts/unclosed.shader', text: 'first { }\n\nlast {\n{ map l.tga }' },
        { name: 'scripts/attached.shader', text: 'joined {map j.tga}' }
      ],
      (text) => warnings.push(text)
    );
    expect([...shaders.keys()]).toEqual(['good']);
    expect(warnings).toEqual([
      'WARNING: Ignoring shader file scripts/open.shader. Shader "Made" on line 3 missing opening ' +
        'brace (found "by" on line 3).\n',
      'WARNING: Ignoring shader file scripts/unclosed.shader. Shader "last" on line 3 missing ' +
        'closing brace.\n',
      'WARNING: Ignoring shader file scripts/attached.shader. Shader "joined" on line 1 missing ' +
        'opening brace (found "{map" on line 1).\n'
    ]);
  });

  it('reads a file only up to its first NUL, as strcat joins it, and the files after it', () => {
    const shaders = parseShaderScripts([
      'a { { map a.tga } }\0b { { map b.tga } }',
      'c { { map c.tga } }'
    ]);
    expect([...shaders.keys()]).toEqual(['a', 'c']);
  });
});

describe('parseShaderScripts: ParseShader', () => {
  it('reads a stage map and treats a bare shader as opaque', () => {
    const shaders = parseShaderScripts([
      `
      models/weapons2/rocketl/rocketl
      {
        {
          map models/weapons2/rocketl/rocketl.tga
        }
      }
      `
    ]);
    const shader = shaders.get('models/weapons2/rocketl/rocketl')!;
    expect(shader.ok).toBe(true);
    expect(shader.warnings).toEqual([]);
    expect(shader.stages).toHaveLength(1);
    expect(shader.stages[0].maps).toEqual(['models/weapons2/rocketl/rocketl.tga']);
    expect(shader.stages[0].blend).toBe('opaque');
    expect(shader.additive).toBe(false);
  });

  it('fails a shader at a keyword Q3 does not know, at either level, where its parse stops', () => {
    const general = shaderOf(`s {\n{\nmap a.tga\n}\ncloudparms 512 full\n{\nmap b.tga\n}\n}`);
    expect(general.ok).toBe(false);
    expect(general.warnings).toEqual([
      "WARNING: unknown general shader parameter 'cloudparms' in 's'\n"
    ]);
    expect(general.stages.map((stage) => stage.maps)).toEqual([['a.tga']]);
    const staged = shaderOf(`s {\n{\nmap a.tga\nalphaMap a.tga\nblendFunc add\n}\n}`);
    expect(staged.ok).toBe(false);
    expect(staged.warnings).toEqual(["WARNING: unknown parameter 'alphaMap' in shader 's'\n"]);
    // The stage it failed in is left as far as it was read: its image, and no state.
    expect(staged.stages).toMatchObject([{ maps: ['a.tga'], blend: 'opaque', depthWrite: false }]);
  });

  it('fails a shader with no stages, unless it is a sky or a fog, and warns of nothing', () => {
    expect(shaderOf('s { surfaceparm nodraw }')).toMatchObject({ ok: false, warnings: [] });
    expect(shaderOf('s { skyparms - 512 -\n}').ok).toBe(true);
    expect(shaderOf('s { surfaceparm fog\n}').ok).toBe(true);
  });

  it("fails a ninth stage, and a shader or stage the text ends in, in Q3's words", () => {
    const nine = shaderOf(`s { ${'{ map a.tga } '.repeat(9)}}`);
    expect([nine.ok, nine.stages.length]).toEqual([false, 8]);
    expect(nine.warnings).toEqual(['WARNING: too many stages in shader s (max is 8)\n']);
    // A line read to its end takes a brace on it, so the text can run out though the braces
    // match: a file whose braces don't is left out whole.
    expect(shaderOf('s { fogparms ( 1 1 1 ) 64 }').warnings).toEqual([
      "WARNING: no concluding '}' in shader s\n"
    ]);
    expect(shaderOf('s { { map a.tga tcMod scroll 1 0 } }').warnings).toEqual([
      "WARNING: no matching '}' found\n"
    ]);
  });

  it('reads nomipmaps, nopicmip, entityMergable, polygonOffset, clampTime and light', () => {
    const shader = shaderOf(
      `s { nomipmaps\nentityMergable\npolygonOffset\nclampTime 2.5\nlight 300\n{ map a.tga } }`
    );
    expect(shader).toMatchObject({
      ok: true,
      noMipMaps: true,
      // `nomipmaps` implies `nopicmip` (`tr_shader.c:1547-1552`).
      noPicMip: true,
      entityMergable: true,
      polygonOffset: true,
      clampTime: 2.5
    });
    expect(shaderOf('s { nopicmip { map a.tga } }')).toMatchObject({
      noMipMaps: false,
      noPicMip: true,
      polygonOffset: false,
      clampTime: 0
    });
  });

  it('skips the rest of a qer, q3map or tessSize line, and a short q3map_sun line the next', () => {
    const shader = shaderOf(`s {
      qer_editorimage a.tga anything
      q3map_lightimage b.tga
      tessSize 128 x
      q3map_sun 1 1 1 100 45 60 extra
      { map a.tga }
    }`);
    expect([shader.ok, shader.stages.length]).toEqual([true, 1]);
    // Its six read, the line's end giving one empty and the next line the rest, whose rest is
    // then skipped, a stage and all.
    const short = shaderOf(`s {\nq3map_sun 1 1 1 100 45\n{ map a.tga }\n{ map b.tga }\n}`);
    expect(short.stages.map((stage) => stage.maps)).toEqual([['b.tga']]);
    const whole = shaderOf(`s {\nq3map_sun 1 1 1 100 45 60\n{ map a.tga }\n{ map b.tga }\n}`);
    expect(whole.stages.map((stage) => stage.maps)).toEqual([['a.tga'], ['b.tga']]);
  });

  it("reads a q3map_sun's or q3map_sunExt's last two numbers as the sun, in floats", () => {
    // `pj_dm9sky`'s, q3dm11's: 165 degrees about, 60 up.
    const sun = shaderOf(`s {\nq3map_sun .5 .6 .8 140 165 60\n{ map a.tga }\n}`).sunDirection!;
    const radians = (degrees: number) => f(f(f(degrees) / 180) * Math.PI);
    const [a, b] = [radians(165), radians(60)];
    expect(sun).toEqual([
      f(Math.cos(a) * Math.cos(b)),
      f(Math.sin(a) * Math.cos(b)),
      f(Math.sin(b))
    ]);
    expect(Math.hypot(...sun)).toBeCloseTo(1, 6);
    // ioquake3's own, with its two more numbers past the six.
    const extended = shaderOf(`s {\nq3map_sunExt 1 1 1 100 0 90 2 16\n{ map a.tga }\n}`);
    expect(extended.sunDirection?.[2]).toBe(1);
    expect(extended.stages).toHaveLength(1);
    // The last one read; none for a shader with none.
    const twice = shaderOf(`s {\nq3map_sun 1 1 1 1 0 90\nq3map_sun 1 1 1 1 0 0\n{ map a.tga }\n}`);
    expect(twice.sunDirection).toEqual([1, 0, 0]);
    expect(shaderOf(`s {\n{ map a.tga }\n}`).sunDirection).toBeUndefined();
  });

  it('reads cull by its names, warning of one Q3 does not know and keeping the last', () => {
    const cull = (body: string) => shaderOf(`s {\n${body}\n{ map a.tga } }`);
    expect(cull('cull none').cull).toBe('none');
    expect(cull('cull twosided').cull).toBe('none');
    expect(cull('cull disable').cull).toBe('none');
    expect(cull('cull back').cull).toBe('back');
    expect(cull('cull backside').cull).toBe('back');
    expect(cull('cull BACKSIDED').cull).toBe('back');
    expect(cull('cull front').cull).toBe('front');
    const odd = cull('cull none\ncull sideways');
    expect([odd.cull, odd.warnings]).toEqual([
      'none',
      ["WARNING: invalid cull parm 'sideways' in shader 's'\n"]
    ]);
    expect(cull('cull').warnings).toEqual(["WARNING: missing cull parms in shader 's'\n"]);
  });

  it('reads a sort by its names, or as a float, and portal as a sort', () => {
    const sort = (body: string) => shaderOf(`s {\n${body}\n{ map a.tga } }`).sort;
    const names: [string, number][] = [
      ['portal', SS_PORTAL],
      ['Sky', SS_ENVIRONMENT],
      ['opaque', SS_OPAQUE],
      ['decal', SS_DECAL],
      ['seeThrough', SS_SEE_THROUGH],
      ['banner', SS_BANNER],
      ['additive', SS_BLEND1],
      ['nearest', SS_NEAREST],
      ['underwater', SS_UNDERWATER]
    ];
    for (const [name, value] of names) expect(sort(`sort ${name}`), name).toBe(value);
    expect(sort('sort 6.3')).toBe(f(6.3));
    // A name `ParseSort` doesn't know is `atof`'s 0, which is no sort.
    expect(sort('sort blend')).toBe(0);
    expect(sort('')).toBe(0);
    expect(sort('portal')).toBe(SS_PORTAL);
    expect(shaderOf('s {\nsort\n{ map a.tga } }').warnings).toEqual([
      "WARNING: missing sort parameter in shader 's'\n"
    ]);
  });

  it('reads the surfaceparms Q3 knows, and passes over the rest', () => {
    const shader = shaderOf(`s {
      surfaceparm noimpact
      surfaceparm Sky
      surfaceparm nomipmaps
      surfaceparm trans
      { map $lightmap } }`);
    expect([shader.ok, shader.surfaceParms]).toEqual([true, ['noimpact', 'sky', 'trans']]);
  });
});

describe('parseShaderScripts: skyParms and fogParms', () => {
  it('reads skyParms from its own line, as ParseSkyParms does', () => {
    const sky = (body: string) => {
      const shader = shaderOf(`s {\n${body}\n}`);
      return { sky: shader.sky, isSky: shader.isSky, warnings: shader.warnings };
    };
    expect(sky('skyparms env/space1 - -')).toEqual({
      sky: { outerBox: 'env/space1', cloudHeight: 512 },
      isSky: true,
      warnings: []
    });
    // `atof` reads what it can, into a float, and 0 is 512.
    expect(sky('skyparms full 128.1x -').sky).toEqual({ outerBox: 'full', cloudHeight: f(128.1) });
    expect(sky('skyparms - 0 -').sky).toEqual({ cloudHeight: 512 });
    // A line short of a parameter keeps what it read, and makes no sky.
    const missing = ["WARNING: 'skyParms' missing parameter in shader 's'\n"];
    expect(sky('skyparms - 384')).toEqual({ sky: { cloudHeight: 384 }, isSky: false, warnings: missing });
    expect(sky('skyparms env/x')).toEqual({ sky: { outerBox: 'env/x' }, isSky: false, warnings: missing });
    expect(sky('skyparms')).toEqual({ sky: {}, isSky: false, warnings: missing });
    // The last box named, `-` naming none, and the last height read.
    expect(sky('skyparms env/a 256 -\nskyparms - 64 -').sky).toEqual({
      outerBox: 'env/a',
      cloudHeight: 64
    });
    // A comment ends the line, and a block comment's own line breaks do not.
    expect(sky('skyparms env/x // the rest\n- -').isSky).toBe(false);
    expect(sky('skyparms env/x /* a comment\nover lines */ 256 -').isSky).toBe(true);
  });

  it('reads fogParms from its own line, as ParseShader does', () => {
    const fog = (body: string) => shaderOf(`s { surfaceparm fog\n${body}\n}`);
    expect(fog('FOGPARMS ( 1 0 0 ) 128').fogParms).toEqual({ color: [1, 0, 0], depthForOpaque: 128 });
    // Each by `atof`, into a float.
    expect(fog('fogparms ( 0.3 .2x 1e1 ) 300.3abc').fogParms).toEqual({
      color: [f(0.3), f(0.2), 10],
      depthForOpaque: f(300.3)
    });
    // The rest of the line is skipped: an old gradient's direction.
    const gradient = shaderOf('s { fogparms ( 1 1 1 ) 64 ( 0 0 1 ) old\n{ map a.tga } }');
    expect([gradient.ok, gradient.stages.length]).toEqual([true, 1]);
    // With no depth, a warning, and the line not skipped.
    const noDepth = fog('fogparms ( 1 1 1 )\n{ map b.tga }');
    expect(noDepth.fogParms).toEqual({ color: [1, 1, 1], depthForOpaque: 0 });
    expect(noDepth.warnings).toEqual([
      "WARNING: missing parm for 'fogParms' keyword in shader 's'\n"
    ]);
    expect(noDepth.stages).toHaveLength(1);
  });

  it('fails a fogParms short of a parenthesis or a channel, keeping what it read', () => {
    const open = fog('fogparms 1 1 1 ) 64');
    expect([open.ok, open.fogParms, open.warnings]).toEqual([
      false,
      { color: [0, 0, 0], depthForOpaque: 0 },
      ["WARNING: missing parenthesis in shader 's'\n"]
    ]);
    const short = fog('fogparms ( 1 0.5\n{ map a.tga }');
    expect([short.ok, short.fogParms?.color, short.warnings, short.stages.length]).toEqual([
      false,
      [1, 0.5, 0],
      ["WARNING: missing vector element in shader 's'\n"],
      0
    ]);
    expect(fog('fogparms ( 1 1 1 64').fogParms?.color).toEqual([1, 1, 1]);

    function fog(body: string) {
      return shaderOf(`s { surfaceparm fog\n${body}\n}`);
    }
  });
});

describe('parseShaderScripts: ParseStage', () => {
  it('recognises additive blending in both spellings', () => {
    const shaders = parseShaderScripts([
      `beamLong { { map a.tga  blendFunc GL_ONE GL_ONE } }
       beamShort { { map b.tga  blendFunc add } }`
    ]);
    expect(shaders.get('beamlong')!.stages[0].blend).toBe('add');
    expect(shaders.get('beamshort')!.stages[0].blend).toBe('add');
    expect(shaders.get('beamlong')!.additive).toBe(true);
  });

  it('classifies alpha blend and filter separately from additive', () => {
    const shaders = parseShaderScripts([
      `smoke { { map s.tga  blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA } }
       shadow { { map d.tga  blendFunc GL_DST_COLOR GL_ZERO } }`
    ]);
    expect(shaders.get('smoke')!.stages[0].blend).toBe('blend');
    expect(shaders.get('shadow')!.stages[0].blend).toBe('filter');
    expect(shaders.get('smoke')!.additive).toBe(false);
  });

  it('keeps the two factors as Q3 names them, a shorthand standing for its pair', () => {
    const patriot = stageOf('blendFunc GL_DST_COLOR GL_SRC_ALPHA');
    expect(patriot.blendFactors).toEqual(['gl_dst_color', 'gl_src_alpha']);
    // Reduced to a mode all the same.
    expect(patriot.blend).toBe('blend');
    expect(stageOf('blendFunc add').blendFactors).toEqual(['gl_one', 'gl_one']);
    expect(stageOf('blendFunc filter').blendFactors).toEqual(['gl_dst_color', 'gl_zero']);
    expect(stageOf('blendFunc blend').blendFactors).toEqual(['gl_src_alpha', 'gl_one_minus_src_alpha']);
    expect(stageOf('').blendFactors).toBeUndefined();
  });

  it('reads a name Q3 does not know as GL_ONE, warning of it, and GL_ONE GL_ZERO as no blend', () => {
    const unknown = shaderOf('s { { map t.tga\nblendFunc add\nblendFunc GL_FOO GL_ZERO\n} }');
    // `GL_ONE GL_ZERO` writes as no blend does, its depth too, whatever came before.
    expect(unknown.stages[0]).toMatchObject({ blend: 'opaque', depthWrite: true });
    expect(unknown.stages[0].blendFactors).toBeUndefined();
    expect(unknown.warnings).toEqual([
      "WARNING: unknown blend mode 'GL_FOO' in shader 's', substituting GL_ONE\n"
    ]);
    expect(stageOf('blendFunc GL_ONE GL_BAR').blendFactors).toEqual(['gl_one', 'gl_one']);
  });

  it('leaves the framebuffer factor unread where the line ends after the source, as Q3 does', () => {
    // GL_State drops the map for this when it draws.
    const short = shaderOf('s { { map t.tga\nblendFunc GL_ONE\n} }');
    expect(short.stages[0]).toMatchObject({ blend: 'blend', blendFactors: ['gl_one', undefined] });
    expect(short.warnings).toEqual(["WARNING: missing parm for blendFunc in shader 's'\n"]);
    // An earlier blend's framebuffer factor stays, and the depth write with it.
    const stale = stageOf('blendFunc add\nblendFunc GL_ZERO');
    expect([stale.blendFactors, stale.depthWrite]).toEqual([['gl_zero', 'gl_one'], false]);
    expect(stageOf('blendFunc').blendFactors).toBeUndefined();
  });

  it('turns depth writes off for blended stages, as Q3 infers', () => {
    expect(stageOf('blendFunc GL_ONE GL_ONE').depthWrite).toBe(false);
  });

  it('keeps depthWrite on a blended stage that asks for it, before or after its blendFunc', () => {
    expect(stageOf('blendFunc blend\ndepthWrite').depthWrite).toBe(true);
    expect(stageOf('depthWrite\nblendFunc GL_ONE GL_ONE').depthWrite).toBe(true);
  });

  it('collects an animMap flipbook with its frame rate, up to 8 frames, to its line\'s end', () => {
    const shaders = parseShaderScripts([
      `rocketExplosion
       {
         cull none
         {
           animMap 8 models/weaphits/rlboom/rlboom_1.tga models/weaphits/rlboom/rlboom_2.tga
           blendFunc GL_ONE GL_ONE
         }
       }`
    ]);
    const stage = shaders.get('rocketexplosion')!.stages[0];
    expect(stage.animFps).toBe(8);
    expect(stage.maps).toHaveLength(2);
    expect(shaders.get('rocketexplosion')!.cull).toBe('none');
    const frames = Array.from({ length: 10 }, (_, i) => `f${i}.tga`);
    const long = shaderOf(`s { { animMap 0.2 ${frames.join(' ')}\n} }`);
    expect([long.stages[0].maps, long.stages[0].animFps]).toEqual([frames.slice(0, 8), f(0.2)]);
    expect(long.warnings).toEqual([
      "WARNING: ignoring excess images for 'animMap' (found 10, max is 8) in shader 's'\n"
    ]);
    // A map after it takes the first frame's place.
    expect(stageOf('animMap 1 a.tga b.tga\nmap c.tga').maps).toEqual(['c.tga', 'b.tga']);
  });

  it('reads clampMap, videoMap, detail, depthFunc and alphaFunc', () => {
    expect(stageOf('clampmap c.tga')).toMatchObject({ maps: ['c.tga'], clamp: true });
    expect(stageOf('').clamp).toBe(false);
    // A cinematic the port has no player for: its stage keeps the image it had.
    expect(stageOf('videoMap intro.roq')).toMatchObject({ maps: ['t.tga'], videoMap: 'intro.roq' });
    expect(stageOf('detail').detail).toBe(true);
    expect(stageOf('depthFunc equal').depthFunc).toBe('equal');
    expect(stageOf('depthFunc equal\ndepthFunc lequal').depthFunc).toBeUndefined();
    const odd = shaderOf('s { { map t.tga\ndepthFunc equal\ndepthFunc gequal\n} }');
    expect([odd.stages[0].depthFunc, odd.warnings]).toEqual([
      'equal',
      ["WARNING: unknown depthfunc 'gequal' in shader 's'\n"]
    ]);
    expect(stageOf('alphaFunc GE128').alphaFunc).toBe('GE128');
    expect(stageOf('alphaFunc gt0').alphaFunc).toBe('GT0');
    expect(stageOf('alphaFunc LT128').alphaFunc).toBe('LT128');
    const unknown = shaderOf('s { { map t.tga\nalphaFunc GE128\nalphaFunc GE64\n} }');
    expect([unknown.stages[0].alphaFunc, unknown.warnings]).toEqual([
      undefined,
      ["WARNING: invalid alphaFunc name 'GE64' in shader 's'\n"]
    ]);
  });

  it('fails a shader at a keyword whose parameter the line lacks, and at a missing image', () => {
    for (const keyword of ['map', 'clampmap', 'animMap', 'videoMap', 'alphaFunc', 'depthfunc']) {
      const shader = shaderOf(`s { {\n${keyword}\n} }`);
      expect([shader.ok, shader.warnings], keyword).toEqual([
        false,
        [`WARNING: missing parameter for '${keyword}' keyword in shader 's'\n`]
      ]);
    }
    const script = shaderOf('s {\n{ map a.tga }\n{ animMap 1 b.tga c.tga\nblendFunc add }\n}');
    const missing = parseShader(script, 'S', (image) => image !== 'c.tga');
    expect([missing.ok, missing.warnings]).toEqual([
      false,
      ["WARNING: R_FindImageFile could not find 'c.tga' in shader 'S'\n"]
    ]);
    // The stage it stopped in holds the frame before, and no blend.
    expect(missing.stages.map((stage) => [stage.maps, stage.blend])).toEqual([
      [['a.tga'], 'opaque'],
      [['b.tga'], 'opaque']
    ]);
    // `$lightmap` and `$whiteimage` are no images to `map`, but are to `clampmap`.
    const special = shaderOf('s { { map $LIGHTMAP } { map $whiteimage } { clampmap $lightmap } }');
    const found = parseShader(special, 's', () => false);
    expect([found.ok, found.stages.map((stage) => stage.maps)]).toEqual([
      false,
      [['$LIGHTMAP'], ['$whiteimage'], []]
    ]);
    expect(found.stages.map((stage) => stage.lightmap)).toEqual([true, undefined, undefined]);
  });

  it('reads scale, scroll, turb, stretch, transform, rotate and entityTranslate in order', () => {
    const stage = stageOf(`tcmod scale -1.3 -1
      tcMod scroll -7.2 0
      tcMod turb 0 .25 0 1.6
      tcMod stretch sin 1 0.2 0 0.4`);
    expect(stage.texMods).toEqual([
      { type: 'scale', s: f(-1.3), t: -1 },
      { type: 'scroll', s: f(-7.2), t: 0 },
      // Always the sine table: Q3 reads the base, and never uses it.
      { type: 'turb', wave: { func: 'sin', base: 0, amplitude: 0.25, phase: 0, frequency: f(1.6) } },
      { type: 'stretch', wave: { func: 'sin', base: 1, amplitude: f(0.2), phase: 0, frequency: f(0.4) } }
    ]);
    expect(stageOf('tcMod transform 1 0.5 -1 2 0.25 3\ntcMod rotate 931\ntcMod entityTranslate').texMods).toEqual([
      { type: 'transform', matrix: [1, 0.5, -1, 2], translate: [0.25, 3] },
      { type: 'rotate', degreesPerSecond: 931 },
      { type: 'entityTranslate' }
    ]);
  });

  it("reads a tcMod's numbers by atof, its function by name, and the rest of its line", () => {
    // q3dm18's `concretefloor1`: `sin` is a base of 0, and the frequency 0.
    expect(stageOf('tcMod turb sin .5 1 0 1').texMods).toEqual([
      { type: 'turb', wave: { func: 'sin', base: 0, amplitude: 0.5, phase: 1, frequency: 0 } }
    ]);
    const noise = shaderOf('s { { map t.tga\ntcMod stretch Noise 1 0 0 1\ntcMod stretch spike 1 0 0 1\n} }');
    expect(noise.stages[0].texMods.map((mod) => mod.type === 'stretch' && mod.wave.func)).toEqual([
      'noise',
      'sin'
    ]);
    expect(noise.warnings).toEqual(["WARNING: invalid genfunc name 'spike' in shader 's'\n"]);
    // The rest of the line is the tcMod's, a `}` among it.
    expect(shaderOf('s { { map t.tga tcMod scroll 1 0 } }').ok).toBe(false);
  });

  it('takes a slot for a tcMod that does not read, which holds nothing', () => {
    const shader = shaderOf(`s { { map t.tga
      tcMod scroll 1
      tcMod spin 4
      tcMod scale 2 2
    } }`);
    expect(shader.stages[0].texMods).toEqual([
      { type: 'none' },
      { type: 'none' },
      { type: 'scale', s: 2, t: 2 }
    ]);
    expect(shader.warnings).toEqual([
      "WARNING: missing scale scroll parms in shader 's'\n",
      "WARNING: unknown tcMod 'spin' in shader 's'\n"
    ]);
    expect(shaderOf('s { { map t.tga\ntcMod turb 0\n} }').warnings).toEqual([
      "WARNING: missing tcMod turb in shader 's'\n"
    ]);
  });

  it('drops the map at a fifth tcMod in a stage, its parse stopping there', () => {
    const shader = shaderOf(`s { { map t.tga\n${'tcMod scale 1 1\n'.repeat(5)}} }`);
    expect(shader.drop).toBe("ERROR: too many tcMod stages in shader 's'");
    expect([shader.ok, shader.stages[0].texMods]).toEqual([false, Array(4).fill({ type: 'scale', s: 1, t: 1 })]);
  });

  it('reads every rgbGen, and the default Q3 gives a stage that names none', () => {
    const kinds = [
      'identity',
      'identityLighting',
      'vertex',
      'exactVertex',
      'entity',
      'oneMinusEntity',
      'oneMinusVertex',
      'lightingDiffuse'
    ];
    for (const kind of kinds) expect(stageOf(`rgbGen ${kind}`).rgbGen, kind).toBe(kind);
    const wave = stageOf('rgbgen wave sin 1 0.5 0 7.1');
    expect(wave.rgbGen).toBe('wave');
    expect(wave.rgbWave).toEqual({ func: 'sin', base: 1, amplitude: 0.5, phase: 0, frequency: f(7.1) });
    expect(stageOf('rgbGen wave noise 0.75 0.25 0 10').rgbWave?.func).toBe('noise');
    // `ParseStage`: identityLighting where the source is added or written as it is, identity
    // where it multiplies the framebuffer.
    expect(stageOf('').rgbGen).toBe('identityLighting');
    expect(stageOf('blendFunc add').rgbGen).toBe('identityLighting');
    expect(stageOf('blendFunc GL_ONE GL_ZERO').rgbGen).toBe('identityLighting');
    expect(stageOf('blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA').rgbGen).toBe('identityLighting');
    expect(stageOf('blendFunc filter').rgbGen).toBe('identity');
    expect(stageOf('blendFunc GL_ZERO GL_SRC_COLOR').rgbGen).toBe('identity');
    const unknown = shaderOf('s { { map t.tga\nrgbGen vertex\nrgbGen glow\n} }');
    expect([unknown.stages[0].rgbGen, unknown.warnings]).toEqual([
      'vertex',
      ["WARNING: unknown rgbGen parameter 'glow' in shader 's'\n"]
    ]);
  });

  it("reads rgbGen const and alphaGen const into bytes, each 255 times its value, wrapped", () => {
    expect(stageOf('rgbGen const ( 1 0.5 0 )')).toMatchObject({
      rgbGen: 'const',
      constantColor: [255, 127, 0, 0]
    });
    expect(stageOf('rgbGen const ( 1.5 -1 0.2 )\nalphaGen const 0.4').constantColor).toEqual([
      126, 1, 51, 102
    ]);
    // A vector short of a parenthesis keeps what it read, and fails nothing.
    const short = shaderOf('s { { map t.tga\nrgbGen const ( 1 1\n} }');
    expect([short.ok, short.stages[0].constantColor]).toEqual([true, [255, 255, 0, 0]]);
  });

  it('reads every alphaGen, and a portal its range', () => {
    const kinds = ['identity', 'entity', 'oneMinusEntity', 'vertex', 'lightingSpecular', 'oneMinusVertex'];
    for (const kind of kinds) {
      expect(stageOf(`rgbGen vertex\nalphaGen ${kind}`).alphaGen, kind).toBe(kind);
    }
    const wave = stageOf('alphaGen wave sawtooth 0 1 0 5');
    expect([wave.alphaGen, wave.alphaWave]).toEqual([
      'wave',
      { func: 'sawtooth', base: 0, amplitude: 1, phase: 0, frequency: 5 }
    ]);
    const portal = shaderOf('s { { map t.tga\nalphaGen portal 64.5\n} }');
    expect([portal.stages[0].alphaGen, portal.portalRange]).toEqual(['portal', 64.5]);
    const unranged = shaderOf('s { { map t.tga\nalphaGen portal\n} }');
    expect([unranged.portalRange, unranged.warnings]).toEqual([
      256,
      ["WARNING: missing range parameter for alphaGen portal in shader 's', defaulting to 256\n"]
    ]);
  });

  it('takes alphaGen vertex from an rgbGen vertex with none before but identity', () => {
    // gfx.shader's numbers: `rgbgen vertex` alone, so they fade with the colour.
    expect(stageOf('rgbgen vertex').alphaGen).toBe('vertex');
    // `AGEN_IDENTITY` is 0, so said first it counts as none.
    expect(stageOf('alphaGen identity\nrgbGen vertex').alphaGen).toBe('vertex');
    expect(stageOf('alphaGen const 0.5\nrgbGen vertex').alphaGen).toBe('const');
    expect(stageOf('rgbGen exactVertex').alphaGen).toBeUndefined();
  });

  it('skips the alpha of a stage at rgbGen identity or lightingDiffuse that names none but identity', () => {
    expect(stageOf('rgbGen identity').alphaGen).toBe('skip');
    expect(stageOf('rgbGen lightingDiffuse\nalphaGen identity').alphaGen).toBe('skip');
    expect(stageOf('blendFunc filter').alphaGen).toBe('skip');
    expect(stageOf('rgbGen identity\nalphaGen vertex').alphaGen).toBe('vertex');
    expect(stageOf('').alphaGen).toBeUndefined();
  });

  it('reads every tcGen, a vector its two vectors', () => {
    expect(stageOf('tcGen environment').tcGen).toBe('environment');
    expect(stageOf('TEXGEN Environment').tcGen).toBe('environment');
    expect(stageOf('tcGen lightmap').tcGen).toBe('lightmap');
    expect(stageOf('tcGen texture').tcGen).toBe('texture');
    expect(stageOf('tcGen base').tcGen).toBe('texture');
    expect(stageOf('tcGen vector ( 0.01 0 0 ) ( 0 0.5 1 )')).toMatchObject({
      tcGen: 'vector',
      tcGenVectors: [
        [f(0.01), 0, 0],
        [0, 0.5, 1]
      ]
    });
    expect(stageOf('').tcGen).toBeUndefined();
    const odd = shaderOf('s { { map t.tga\ntcGen sphere\n} }');
    expect([odd.stages[0].tcGen, odd.warnings]).toEqual([
      undefined,
      ["WARNING: unknown texgen parm in shader 's'\n"]
    ]);
  });

  it('warns of a keyword whose parameter the line lacks, where Q3 carries on', () => {
    const shader = shaderOf(`s { { map t.tga
      blendFunc
      rgbGen
      alphaGen
      tcGen
      rgbGen wave
      alphaGen wave sin 0 1
    } }`);
    expect(shader.ok).toBe(true);
    expect(shader.warnings).toEqual([
      "WARNING: missing parm for blendFunc in shader 's'\n",
      "WARNING: missing parameters for rgbGen in shader 's'\n",
      "WARNING: missing parameters for alphaGen in shader 's'\n",
      "WARNING: missing texgen parm in shader 's'\n",
      "WARNING: missing waveform parm in shader 's'\n",
      "WARNING: missing waveform parm in shader 's'\n"
    ]);
    // A wave with no function has none; one short of its numbers keeps those it read.
    expect(shader.stages[0].rgbWave).toEqual({ func: 'none', base: 0, amplitude: 0, phase: 0, frequency: 0 });
    expect(shader.stages[0].alphaWave).toEqual({ func: 'sin', base: 0, amplitude: 1, phase: 0, frequency: 0 });
  });
});

describe('parseShaderScripts: deformVertexes', () => {
  /** The shader `s`, with `body` before its one stage. */
  function deformsOf(body: string) {
    return shaderOf(`s {\n${body}\n{ map t.tga\nblendfunc add\n} }`);
  }

  it("reads a powerup shell's swell: its wave, and one over its div as the spread", () => {
    const shell = deformsOf('deformVertexes wave 100 sin 3 0 0 0');
    expect(shell.deforms).toEqual([
      { type: 'wave', spread: f(0.01), wave: { func: 'sin', base: 3, amplitude: 0, phase: 0, frequency: 0 } }
    ]);
    // And carries on past it to the stage.
    expect(shell.stages[0].maps).toEqual(['t.tga']);
    // In any case, as Q3 matches it.
    expect(deformsOf('DEFORMVERTEXES Wave 50 Triangle 1 2 0.5 4').deforms).toEqual([
      { type: 'wave', spread: f(0.02), wave: { func: 'triangle', base: 1, amplitude: 2, phase: 0.5, frequency: 4 } }
    ]);
  });

  it('refuses a div that reads as nothing, for a spread of 100, warning of it', () => {
    const zero = deformsOf('deformVertexes wave 0 sin 3 0 0 0');
    expect(zero.deforms[0]).toMatchObject({ type: 'wave', spread: 100 });
    expect(zero.warnings).toEqual([
      "WARNING: illegal div value of 0 in deformVertexes command for shader 's'\n"
    ]);
    expect(deformsOf('deformVertexes wave x sin 3 0 0 0').deforms[0]).toMatchObject({ spread: 100 });
  });

  it("reads the other kinds with their arguments, as ParseDeform does: a flag's and a hologram's", () => {
    // pak0's `models/flags/r_flag2` and `models/mapobjects/bitch/hologirl`, then the rest.
    const shader = deformsOf(
      `deformVertexes normal .3 .2
       deformVertexes Move 0 0 .7 sin 0 5 0 0.2
       deformVertexes bulge 3 10 1`
    );
    expect(shader.deforms).toEqual([
      { type: 'normal', amplitude: f(0.3), frequency: f(0.2) },
      { type: 'move', vector: [0, 0, f(0.7)], wave: { func: 'sin', base: 0, amplitude: 5, phase: 0, frequency: f(0.2) } },
      { type: 'bulge', width: 3, height: 10, speed: 1 }
    ]);
    expect(shader.stages[0].maps).toEqual(['t.tga']);
    const sprites = deformsOf('deformVertexes autoSprite\ndeformVertexes AUTOSPRITE2').deforms;
    expect(sprites).toEqual([{ type: 'autosprite' }, { type: 'autosprite2' }]);
    // Both turn their quads to the viewer; nothing else does.
    expect(sprites.every(isSpriteDeform)).toBe(true);
    expect(shader.deforms.some(isSpriteDeform)).toBe(false);
  });

  it('reads projectionShadow, and text by its number, past 7 being 0', () => {
    expect(
      deformsOf('deformVertexes projectionShadow\ndeformVertexes text3\ndeformVertexes text9').deforms
    ).toEqual([{ type: 'projectionShadow' }, { type: 'text', index: 3 }, { type: 'text', index: 0 }]);
    expect(deformsOf('deformVertexes TEXT').deforms).toEqual([{ type: 'text', index: 0 }]);
  });

  it('takes a slot for a kind it does not know, or one short of its numbers, which deforms nothing', () => {
    const shader = deformsOf('deformVertexes ripple\ndeformVertexes bulge 3 x\ndeformVertexes normal');
    expect(shader.deforms).toEqual([{ type: 'none' }, { type: 'none' }, { type: 'none' }]);
    expect(shader.warnings).toEqual([
      "WARNING: unknown deformVertexes subtype 'ripple' found in shader 's'\n",
      "WARNING: missing deformVertexes bulge parm in shader 's'\n",
      "WARNING: missing deformVertexes parm in shader 's'\n"
    ]);
    // A wave or a move short of its waveform is one all the same.
    expect(deformsOf('deformVertexes move 0 0 1 sin 2').deforms).toEqual([
      { type: 'move', vector: [0, 0, 1], wave: { func: 'sin', base: 2, amplitude: 0, phase: 0, frequency: 0 } }
    ]);
  });

  it('keeps three deforms, warning of a fourth, whose numbers then fail the shader', () => {
    const four = deformsOf(`deformVertexes autosprite
       deformVertexes wave 10 sin 1 0 0 0
       deformVertexes wave 20 sin 2 0 0 0
       deformVertexes autosprite2`);
    expect(four.deforms.map((deform) => deform.type)).toEqual(['autosprite', 'wave', 'wave']);
    expect([four.ok, four.warnings]).toEqual([true, ["WARNING: MAX_SHADER_DEFORMS in 's'\n"]]);
    const numbered = deformsOf(`deformVertexes autosprite
       deformVertexes autosprite
       deformVertexes autosprite
       deformVertexes wave 40 sin 4 0 0 0`);
    expect([numbered.ok, numbered.warnings]).toEqual([
      false,
      [
        "WARNING: MAX_SHADER_DEFORMS in 's'\n",
        "WARNING: unknown general shader parameter '40' in 's'\n"
      ]
    ]);
  });

  it('reads a noise wave, which Q3 has no table for', () => {
    expect(deformsOf('deformVertexes wave 100 noise 0 1 0 1').deforms[0]).toMatchObject({
      wave: { func: 'noise' }
    });
  });

  it('takes a closing brace on its line as a number, as COM_ParseExt hands it over', () => {
    const cut = shaderOf('s { deformVertexes bulge 3 10 }');
    expect([cut.ok, cut.deforms]).toEqual([false, [{ type: 'bulge', width: 3, height: 10, speed: 0 }]]);
  });
});

describe('parseShader', () => {
  it('reads a definition again, its images looked up, its warnings naming it as asked', () => {
    const script = shaderOf('s {\n{ map a.tga\nblendFunc FOO ONE\n}\n}');
    expect(script.warnings).toHaveLength(2);
    const asked = parseShader(script, 'Textures/S', () => true);
    expect(asked.name).toBe('s');
    expect(asked.warnings).toEqual([
      "WARNING: unknown blend mode 'FOO' in shader 'Textures/S', substituting GL_ONE\n",
      "WARNING: unknown blend mode 'ONE' in shader 'Textures/S', substituting GL_ONE\n"
    ]);
    expect(asked.stages).toEqual(script.stages);
  });
});

describe('diffuseReference', () => {
  const shaders = parseShaderScripts([
    `fancy
     {
       { map $lightmap }
       { map textures/real.tga  blendFunc GL_ONE GL_ONE }
     }
     empty { cull none }`
  ]);

  it('skips $lightmap-style stages to find a real image', () => {
    expect(diffuseReference(shaders, 'fancy')).toBe('textures/real.tga');
  });

  it('falls back to the name itself when there is no shader script for it', () => {
    // The common case for weapons: their MD3 surfaces name a texture directly.
    expect(diffuseReference(shaders, 'models/weapons2/rocketl/rocketl.TGA')).toBe(
      'models/weapons2/rocketl/rocketl.TGA'
    );
  });

  it('returns undefined for a shader with no image at all', () => {
    expect(diffuseReference(shaders, 'empty')).toBeUndefined();
  });
});

// Guarded against the user's install. Needs the full pak0-8 mount, not just pak0 — see the
// lightning test below.
const haveFullSet = Array.from({ length: 9 }, (_, i) => havePak(`pak${i}.pk3`)).every(Boolean);

describe.skipIf(!haveFullSet)('parseShaderScripts against the retail pak set', () => {
  async function mountAll(): Promise<PakFileSystem> {
    const fs = new PakFileSystem();
    for (let i = 0; i <= 8; i++) fs.mount(await openPak(`pak${i}.pk3`));
    return fs;
  }

  async function loadShaders(fs: PakFileSystem, warn?: (text: string) => void) {
    // In ioq3's order, as the game reads them.
    const files = shaderTextOrder(fs);
    const texts = await Promise.all(files.map(async (f) => (await fs.readText(f))!));
    return parseShaderScripts(
      files.map((name, i) => ({ name, text: texts[i] })),
      warn
    );
  }

  it('parses every shader script in the game, leaving out no file', async () => {
    const fs = await mountAll();
    expect(fs.list('scripts/', 'shader').length).toBe(30);
    const warnings: string[] = [];
    // Measured, then pinned: 1434 definitions across the full set (1399 from pak0 alone).
    expect((await loadShaders(fs, (text) => warnings.push(text))).size).toBe(1434);
    expect(warnings).toEqual([]);
  });

  it('fails the shaders Q3 fails, each with its warning, and drops the map for none', async () => {
    const shaders = [...(await loadShaders(await mountAll())).values()];
    // Measured, then pinned: 87 fail. 32 have no stages and are neither a sky nor a fog, which
    // Q3 fails without a word; the rest stop at a keyword it doesn't know (`sky`, `cloudparms`,
    // `fogonly`, `light1` and `alphaMap`), or a fog's colour short of a parenthesis.
    const failed = shaders.filter((shader) => !shader.ok);
    expect(failed).toHaveLength(87);
    const warned = failed.filter((shader) => shader.warnings.length > 0);
    expect(warned).toHaveLength(55);
    const reasons = new Set(warned.map((shader) => shader.warnings.at(-1)!.replace(/'[^']*'/g, "'…'")));
    expect([...reasons].sort()).toEqual([
      "WARNING: missing parenthesis in shader '…'\n",
      "WARNING: unknown general shader parameter '…' in '…'\n",
      "WARNING: unknown parameter '…' in shader '…'\n"
    ]);
    expect(shaders.filter((shader) => shader.drop !== undefined)).toEqual([]);
  });

  it('reads the explosion flipbooks the effect renderer needs', async () => {
    const shaders = await loadShaders(await mountAll());
    // Measured, then pinned. The rocket gets a longer, faster book than the rest — 8 frames
    // at 8 fps, so exactly one second of flipbook against its 1000 ms sprite life.
    const cases: [string, number, number][] = [
      // shader, animFps, frame count
      ['rocketexplosion', 8, 8],
      ['grenadeexplosion', 5, 3],
      ['bfgexplosion', 5, 3],
      ['bulletexplosion', 5, 4]
    ];
    for (const [name, fps, frames] of cases) {
      const stage = shaders.get(name)!.stages[0];
      expect(stage.animFps, name).toBe(fps);
      expect(stage.maps.length, name).toBe(frames);
      expect(stage.blend, name).toBe('add');
    }
  });

  it('resolves every explosion flipbook frame to a real image', async () => {
    // A flipbook that half-resolves would show gaps mid-explosion, so the whole book has to
    // survive the tga->jpg fallback, not just its first frame.
    const fs = await mountAll();
    const shaders = await loadShaders(fs);
    for (const name of ['rocketexplosion', 'grenadeexplosion', 'bfgexplosion', 'bulletexplosion']) {
      for (const map of shaders.get(name)!.stages[0].maps) {
        expect(fs.resolveImage(map), `${name} -> ${map}`).toBeDefined();
      }
    }
  });

  it('finds the lightning bolt shader only once the point releases are mounted', async () => {
    // `lightningBoltNew` lives in scripts/lightningnew.shader, which ships in pak6 —
    // so the lightning gun is literally unrenderable from pak0 alone. This is what makes
    // mounting the whole pak0-8 set a correctness requirement, not just fidelity.
    const bolt = (await loadShaders(await mountAll())).get('lightningboltnew')!;
    expect(bolt).toBeDefined();
    expect(bolt.additive).toBe(true);
    expect(bolt.stages[0].maps).toEqual(['gfx/misc/lightning3new.tga']);
    // Two bolts, each scaled and scrolled along the beam — the second mirrored and faster. The
    // scrolling is what makes the beam appear to flow toward the target.
    expect(bolt.stages[0].texMods).toEqual([
      { type: 'scale', s: 2, t: 1 },
      { type: 'scroll', s: -5, t: 0 }
    ]);
    expect(bolt.stages[1].texMods).toEqual([
      { type: 'scale', s: f(-1.3), t: -1 },
      { type: 'scroll', s: f(-7.2), t: 0 }
    ]);

    const pak0Only = new PakFileSystem();
    pak0Only.mount(await openPak('pak0.pk3'));
    expect((await loadShaders(pak0Only)).get('lightningboltnew')).toBeUndefined();
  });

  it('resolves weapon skins through the image fallback, which they all need', async () => {
    // Every rocket launcher texture is named `.TGA` in the MD3 but ships only as
    // `.jpg`. The extension fallback is load-bearing.
    const fs = await mountAll();
    expect(fs.resolveImage('models/weapons2/rocketl/rocketl.TGA')).toBe(
      'models/weapons2/rocketl/rocketl.jpg'
    );
    expect(await fs.read('models/weapons2/rocketl/rocketl.tga')).toBeUndefined();
  });

  it('reads the rail and plasma effect shaders', async () => {
    const shaders = await loadShaders(await mountAll());
    expect(shaders.get('railcore')!.stages[0].maps).toEqual(['gfx/misc/railcorethin_mono.tga']);
    expect(shaders.get('railcore')!.additive).toBe(true);
    expect(shaders.get('sprites/plasma1')!.stages[0].maps).toEqual(['sprites/plasmaa.tga']);
    // Smoke is alpha-blended, not additive — it has to darken against the splats.
    expect(shaders.get('smokepuff')!.stages[0].blend).toBe('blend');
  });

  it("reads the rgbGens behind the effects' brightness", async () => {
    const shaders = await loadShaders(await mountAll());
    const gens = (name: string) => shaders.get(name)!.stages.map((stage) => stage.rgbGen);
    // The BFG ball draws at twice a default stage in fullscreen Q3; the lightning's waves climb
    // past 1; the rail core and the smoke take their vertex colour.
    expect(gens('models/weaphits/bfg01')).toEqual(['identity', 'identity']);
    expect(gens('models/weaphits/bfg02')).toEqual(['identity', 'identity']);
    expect(gens('lightningboltnew')).toEqual(['wave', 'wave']);
    expect(gens('models/weaphits/electric')).toEqual(['wave', 'wave']);
    expect(gens('rocketexplosion')).toEqual(['wave', 'wave']);
    expect(gens('railcore')).toEqual(['vertex']);
    expect(gens('smokepuff')).toEqual(['vertex']);
    // A flash names none, and takes a default stage's brightness.
    expect(gens('models/weapons2/rocketl/f_rocketl')).toEqual(['identityLighting']);
  });

  it("reads how far each powerup's shell swells off its body", async () => {
    const shaders = await loadShaders(await mountAll());
    // Measured, then pinned: `wave 100 sin <base> 0 0 0`, a push that never moves.
    const swell = (name: string) =>
      shaders
        .get(name)!
        .deforms.map((deform) =>
          deform.type === 'wave' ? [deform.spread, deform.wave.base, deform.wave.frequency] : []
        );
    expect(swell('powerups/quad')).toEqual([[f(0.01), 3, 0]]);
    expect(swell('powerups/regen')).toEqual([[f(0.01), 3, 0]]);
    expect(swell('powerups/battlesuit')).toEqual([[f(0.01), 1, 0]]);
    expect(swell('powerups/quadweapon')).toEqual([[f(0.01), 0.5, 0]]);
    expect(swell('powerups/battleweapon')).toEqual([[f(0.01), 0.5, 0]]);
    // Invisibility's shimmer lies on the body.
    expect(swell('powerups/invisibility')).toEqual([]);
  });
});
