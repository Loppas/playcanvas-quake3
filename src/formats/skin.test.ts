import { describe, expect, it } from 'vitest';
import { MAX_SKIN_SURFACES, parseSkin } from './skin';

describe('parseSkin', () => {
  it("reads sarge's head skin and skips its tag line", () => {
    // pak0's models/players/sarge/head_default.skin.
    const skin =
      'tag_head,\nh_cigar,models/players/sarge/cigar.tga\nh_head,models/players/sarge/band.tga\n';
    expect(parseSkin(skin)).toEqual([
      { surface: 'h_cigar', shader: 'models/players/sarge/cigar.tga' },
      { surface: 'h_head', shader: 'models/players/sarge/band.tga' }
    ]);
  });

  it('lowercases the surface and keeps the shader as written', () => {
    expect(parseSkin('U_Torso,Models/Players/Keel/Keel.TGA')).toEqual([
      { surface: 'u_torso', shader: 'Models/Players/Keel/Keel.TGA' }
    ]);
  });

  it('skips a pair whose surface contains tag_ anywhere, not only at its start', () => {
    expect(parseSkin('u_tag_x,\nu_torso,b.tga')).toEqual([{ surface: 'u_torso', shader: 'b.tga' }]);
  });

  it("leaves a tag line's shader, if it names one, to be read as the next surface, as Q3 does", () => {
    // The tag is skipped before its shader is read (`tr_image.c:1585–1587`). Retail tag lines
    // end at the comma, so none of them trips this.
    expect(parseSkin('tag_weapon,x.tga\nh_head,band.tga')[0]).toEqual({
      surface: 'x.tga',
      shader: 'h_head'
    });
  });

  it('reads CRLF line ends and skips comments', () => {
    expect(parseSkin('// made by hand\r\nl_legs,a.tga /* the legs */\r\n')).toEqual([
      { surface: 'l_legs', shader: 'a.tga' }
    ]);
  });

  it('reads a quoted token whole', () => {
    expect(parseSkin('"u torso","models/x y.tga"')).toEqual([
      { surface: 'u torso', shader: 'models/x y.tga' }
    ]);
  });

  it("gives a pair that names no shader the next line's first token, as CommaParse does", () => {
    expect(parseSkin('h_head,\nh_cigar,cigar.tga')[0]).toEqual({ surface: 'h_head', shader: 'h_cigar' });
  });

  it('keeps no more than MAX_SKIN_SURFACES pairs', () => {
    const lines = Array.from({ length: MAX_SKIN_SURFACES + 5 }, (_, i) => `s${i},t${i}.tga`);
    const skin = parseSkin(lines.join('\n'));
    expect(skin).toHaveLength(MAX_SKIN_SURFACES);
    const last = MAX_SKIN_SURFACES - 1;
    expect(skin.at(-1)).toEqual({ surface: `s${last}`, shader: `t${last}.tga` });
  });

  it('reads nothing from a file with no pair to keep', () => {
    expect(parseSkin('')).toEqual([]);
    expect(parseSkin('tag_torso,\n')).toEqual([]);
  });
});
