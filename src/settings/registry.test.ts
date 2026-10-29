import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, SETTINGS, SETTING_KEYS, settingForCvar, type Settings } from './registry';

const read = (key: keyof Settings, raw: string) => SETTINGS[key].read(raw);

describe('the settings registry', () => {
  it("has Q3's defaults, with the port's sensitivity and fov, and Quake Live's speedometer off", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      name: 'UnnamedPlayer',
      handicap: 100,
      color1: 4,
      model: 'sarge',
      headModel: 'sarge',
      teamModel: 'sarge',
      teamHeadModel: 'sarge',
      sensitivity: 6.8,
      mPitch: 0.022,
      mYaw: 0.022,
      glDriver: 'webgpu',
      renderer: 'opengl1',
      overBrightBits: 1,
      normalMapping: true,
      specularMapping: true,
      picmip: 0,
      fov: 89.2,
      swapInterval: true,
      maxFps: 125,
      maxFpsUnfocused: 0,
      volume: 0.8,
      musicVolume: 0.25,
      doppler: true,
      rate: 50000,
      snaps: 125,
      draw3dIcons: true,
      autoswitch: true,
      centerTime: 3,
      speedometer: 0,
      drawCrosshair: 4,
      crosshairSize: 24,
      marks: true,
      dynamicLight: true,
      shadows: 1,
      marksOnTriangleMeshes: false,
      drawFPS: false,
      lagometer: true,
      draw2D: true,
      drawRewards: true,
      drawFriend: true,
      scorePlums: true,
      deferPlayers: true,
      predictItems: true,
      noPredict: false,
      errorDecay: 100,
      showMiss: 0,
      delagWeapons: 0,
      projectileNudge: 0,
      noPrint: false,
      notifyTime: 3,
      notifyLines: 3,
      conXOffset: 0,
      conSpeed: 3,
      conScale: 1,
      conAutoclear: true,
      conAutochat: true,
      teamChatsOnly: false,
      teamChatHeight: 0,
      teamChatTime: 3000,
      gametype: 0,
      fragLimit: 20,
      timeLimit: 0,
      captureLimit: 8,
      roundLimit: 5,
      doWarmup: false,
      warmup: 20,
      forceRespawn: 20,
      maxClients: 8,
      svFps: 125,
      pmoveMsec: 8,
      dedicated: 0,
      hostname: 'noname',
      master1: 'wss://pcq3-master.cheapskatecorner.com',
      master2: 'localhost',
      netPort: 27960,
      runMaster: false,
      allowGrapple: 1,
      spawnWeapons: false,
      spawnArmor: 0,
      unlagged: 1,
      uiFfaFragLimit: 20,
      uiFfaTimeLimit: 0,
      uiTourneyFragLimit: 0,
      uiTourneyTimeLimit: 15,
      uiTeamFragLimit: 0,
      uiTeamTimeLimit: 20,
      uiTeamFriendly: 1,
      uiCtfCaptureLimit: 8,
      uiCtfTimeLimit: 30,
      uiCtfFriendly: 0,
      uiCaRoundLimit: 5,
      uiCaTimeLimit: 0,
      uiBrowserMaster: 1,
      uiBrowserGameType: 0,
      uiBrowserSortKey: 4,
      uiBrowserShowFull: 1,
      uiBrowserShowEmpty: 1,
      god: false,
      thirdPerson: false,
      drawCollision: false,
      drawBBox: false,
      debugDelag: false,
      drawStatusLine: false,
      flyCamera: false,
      botPause: false,
      packetDelay: 0,
      serverPacketDelay: 0,
      drawEntities: true,
      fullbright: false,
      mapOverBrightBits: 2,
      subdivisions: 4,
      multitexture: true,
      textureEnvAdd: true,
      detailTextures: true,
      lodCurveError: 250,
      fastSky: false,
      noVis: false,
      noCull: false,
      lockPvs: false,
      showCluster: false,
      zNear: 4,
      offsetFactor: -1,
      offsetUnits: -2,
      ambientScale: 0.6,
      directedScale: 1,
      facePlaneCull: true,
      preview: false,
      previewTime: 0,
      noAreas: false,
      noCurves: false,
      playerCurveClip: true,
      gibs: true,
      footsteps: true,
      gsplatColorAngle: 10
    });
  });

  it("names each after its cvar: Q3's, a mod's, or the port's own under pcq_", () => {
    expect(Object.fromEntries(SETTING_KEYS.map((key) => [key, SETTINGS[key].cvar]))).toEqual({
      name: 'name',
      handicap: 'handicap',
      color1: 'color1',
      model: 'model',
      headModel: 'headmodel',
      teamModel: 'team_model',
      teamHeadModel: 'team_headmodel',
      sensitivity: 'sensitivity',
      mPitch: 'm_pitch',
      mYaw: 'm_yaw',
      glDriver: 'r_glDriver',
      renderer: 'cl_renderer',
      overBrightBits: 'r_overBrightBits',
      normalMapping: 'r_normalMapping',
      specularMapping: 'r_specularMapping',
      picmip: 'r_picmip',
      fov: 'cg_fov',
      swapInterval: 'r_swapInterval',
      maxFps: 'com_maxfps',
      maxFpsUnfocused: 'com_maxfpsUnfocused',
      volume: 's_volume',
      musicVolume: 's_musicvolume',
      doppler: 's_doppler',
      rate: 'rate',
      snaps: 'snaps',
      draw3dIcons: 'cg_draw3dIcons',
      autoswitch: 'cg_autoswitch',
      centerTime: 'cg_centertime',
      speedometer: 'cg_speedometer',
      drawCrosshair: 'cg_drawCrosshair',
      crosshairSize: 'cg_crosshairSize',
      marks: 'cg_marks',
      dynamicLight: 'r_dynamiclight',
      shadows: 'cg_shadows',
      marksOnTriangleMeshes: 'r_marksOnTriangleMeshes',
      drawFPS: 'cg_drawFPS',
      lagometer: 'cg_lagometer',
      draw2D: 'cg_draw2D',
      drawRewards: 'cg_drawRewards',
      drawFriend: 'cg_drawFriend',
      scorePlums: 'cg_scorePlums',
      deferPlayers: 'cg_deferPlayers',
      predictItems: 'cg_predictItems',
      noPredict: 'cg_nopredict',
      errorDecay: 'cg_errordecay',
      showMiss: 'cg_showmiss',
      delagWeapons: 'xp_delagWeapons',
      projectileNudge: 'cg_projectileNudge',
      noPrint: 'cl_noprint',
      notifyTime: 'con_notifytime',
      notifyLines: 'con_notifylines',
      conXOffset: 'cl_conXOffset',
      conSpeed: 'scr_conspeed',
      conScale: 'con_scale',
      conAutoclear: 'con_autoclear',
      conAutochat: 'con_autochat',
      teamChatsOnly: 'cg_teamChatsOnly',
      teamChatHeight: 'cg_teamChatHeight',
      teamChatTime: 'cg_teamChatTime',
      gametype: 'g_gametype',
      fragLimit: 'fraglimit',
      timeLimit: 'timelimit',
      captureLimit: 'capturelimit',
      roundLimit: 'roundlimit',
      doWarmup: 'g_doWarmup',
      warmup: 'g_warmup',
      forceRespawn: 'g_forcerespawn',
      maxClients: 'sv_maxclients',
      svFps: 'sv_fps',
      pmoveMsec: 'pmove_msec',
      dedicated: 'dedicated',
      hostname: 'sv_hostname',
      master1: 'sv_master1',
      master2: 'sv_master2',
      netPort: 'net_port',
      runMaster: 'sv_runMaster',
      allowGrapple: 'g_allowGrapple',
      spawnWeapons: 'pcq_spawnWeapons',
      spawnArmor: 'pcq_spawnArmor',
      unlagged: 'xp_unlagged',
      uiFfaFragLimit: 'ui_ffa_fraglimit',
      uiFfaTimeLimit: 'ui_ffa_timelimit',
      uiTourneyFragLimit: 'ui_tourney_fraglimit',
      uiTourneyTimeLimit: 'ui_tourney_timelimit',
      uiTeamFragLimit: 'ui_team_fraglimit',
      uiTeamTimeLimit: 'ui_team_timelimit',
      uiTeamFriendly: 'ui_team_friendly',
      uiCtfCaptureLimit: 'ui_ctf_capturelimit',
      uiCtfTimeLimit: 'ui_ctf_timelimit',
      uiCtfFriendly: 'ui_ctf_friendly',
      uiCaRoundLimit: 'ui_ca_roundlimit',
      uiCaTimeLimit: 'ui_ca_timelimit',
      uiBrowserMaster: 'ui_browserMaster',
      uiBrowserGameType: 'ui_browserGameType',
      uiBrowserSortKey: 'ui_browserSortKey',
      uiBrowserShowFull: 'ui_browserShowFull',
      uiBrowserShowEmpty: 'ui_browserShowEmpty',
      god: 'pcq_god',
      thirdPerson: 'cg_thirdPerson',
      drawCollision: 'pcq_drawCollision',
      drawBBox: 'cg_drawBBox',
      debugDelag: 'cg_debugDelag',
      drawStatusLine: 'pcq_drawStatusLine',
      flyCamera: 'pcq_flyCamera',
      botPause: 'bot_pause',
      packetDelay: 'cl_packetdelay',
      serverPacketDelay: 'sv_packetdelay',
      drawEntities: 'r_drawentities',
      fullbright: 'r_fullbright',
      mapOverBrightBits: 'r_mapOverBrightBits',
      subdivisions: 'r_subdivisions',
      multitexture: 'r_ext_multitexture',
      textureEnvAdd: 'r_ext_texture_env_add',
      detailTextures: 'r_detailtextures',
      lodCurveError: 'r_lodCurveError',
      fastSky: 'r_fastsky',
      noVis: 'r_novis',
      noCull: 'r_nocull',
      lockPvs: 'r_lockpvs',
      showCluster: 'r_showcluster',
      zNear: 'r_znear',
      offsetFactor: 'r_offsetFactor',
      offsetUnits: 'r_offsetUnits',
      ambientScale: 'r_ambientScale',
      directedScale: 'r_directedScale',
      facePlaneCull: 'r_facePlaneCull',
      preview: 'pcq_preview',
      previewTime: 'pcq_previewTime',
      noAreas: 'cm_noAreas',
      noCurves: 'cm_noCurves',
      playerCurveClip: 'cm_playerCurveClip',
      gibs: 'cg_gibs',
      footsteps: 'cg_footsteps',
      gsplatColorAngle: 'pcq_gsplatColorAngle'
    });
  });

  it('finds a setting by its cvar in any case', () => {
    expect(settingForCvar('CG_FOV')).toBe('fov');
    expect(settingForCvar('r_overbrightbits')).toBe('overBrightBits');
    expect(settingForCvar('cg_nothing')).toBeUndefined();
  });

  it('puts each in its menu section, and cg_gibs in none, as in Q3', () => {
    const sections: Record<string, string[]> = {};
    for (const key of SETTING_KEYS) (sections[SETTINGS[key].section ?? 'none'] ??= []).push(key);
    expect(sections).toEqual({
      player: ['name', 'handicap', 'color1', 'model', 'headModel', 'teamModel', 'teamHeadModel'],
      controls: ['sensitivity', 'mPitch', 'mYaw'],
      graphics: [
        'glDriver',
        'renderer',
        'overBrightBits',
        'normalMapping',
        'specularMapping',
        'picmip'
      ],
      display: ['fov', 'swapInterval', 'maxFps'],
      sound: ['volume', 'musicVolume'],
      network: ['rate', 'snaps'],
      game: [
        'draw3dIcons',
        'speedometer',
        'drawCrosshair',
        'crosshairSize',
        'marks',
        'dynamicLight',
        'drawFPS',
        'draw2D',
        'fastSky'
      ],
      server: [
        'gametype',
        'fragLimit',
        'timeLimit',
        'captureLimit',
        'roundLimit',
        'doWarmup',
        'warmup',
        'forceRespawn',
        'maxClients',
        'svFps',
        'pmoveMsec',
        'allowGrapple',
        'spawnWeapons',
        'spawnArmor',
        'unlagged'
      ],
      debug: [
        'god',
        'thirdPerson',
        'drawCollision',
        'drawBBox',
        'debugDelag',
        'drawStatusLine',
        'flyCamera',
        'botPause'
      ],
      // `cg_autoswitch` sits in Q3's Controls menu, which the port's is not: binds alone, and
      // `cg_centertime` is a cheat there, so no menu shows either. No page of q3_ui's has
      // `cg_lagometer`, `cg_drawRewards`, `cg_drawFriend`, `cg_scorePlums`, `cg_deferPlayers` or
      // the prediction's switches, and Server Options keeps the `ui_*` limits without a row of
      // their own. Nor has ioq3 a page for `com_maxfpsUnfocused`, `s_doppler`, `cg_shadows` or
      // `r_marksOnTriangleMeshes`.
      none: [
        'maxFpsUnfocused',
        'doppler',
        'autoswitch',
        'centerTime',
        'shadows',
        'marksOnTriangleMeshes',
        'lagometer',
        'drawRewards',
        'drawFriend',
        'scorePlums',
        'deferPlayers',
        'predictItems',
        'noPredict',
        'errorDecay',
        'showMiss',
        'delagWeapons',
        'projectileNudge',
        'noPrint',
        'notifyTime',
        'notifyLines',
        'conXOffset',
        'conSpeed',
        'conScale',
        'conAutoclear',
        'conAutochat',
        'teamChatsOnly',
        'teamChatHeight',
        'teamChatTime',
        'dedicated',
        'hostname',
        'master1',
        'master2',
        'netPort',
        'runMaster',
        'uiFfaFragLimit',
        'uiFfaTimeLimit',
        'uiTourneyFragLimit',
        'uiTourneyTimeLimit',
        'uiTeamFragLimit',
        'uiTeamTimeLimit',
        'uiTeamFriendly',
        'uiCtfCaptureLimit',
        'uiCtfTimeLimit',
        'uiCtfFriendly',
        'uiCaRoundLimit',
        'uiCaTimeLimit',
        'uiBrowserMaster',
        'uiBrowserGameType',
        'uiBrowserSortKey',
        'uiBrowserShowFull',
        'uiBrowserShowEmpty',
        'packetDelay',
        'serverPacketDelay',
        'drawEntities',
        'fullbright',
        'mapOverBrightBits',
        'subdivisions',
        'multitexture',
        'textureEnvAdd',
        'detailTextures',
        'lodCurveError',
        'noVis',
        'noCull',
        'lockPvs',
        'showCluster',
        'zNear',
        'offsetFactor',
        'offsetUnits',
        'ambientScale',
        'directedScale',
        'facePlaneCull',
        'preview',
        'previewTime',
        'noAreas',
        'noCurves',
        'playerCurveClip',
        'gibs',
        'footsteps',
        'gsplatColorAngle'
      ]
    });
  });

  it('archives every setting but the match pair, the server switches and those Q3 does not', () => {
    expect(SETTING_KEYS.filter((key) => SETTINGS[key].archive === false)).toEqual([
      'noPredict',
      'errorDecay',
      'showMiss',
      'noPrint',
      'conXOffset',
      'gametype',
      'maxClients',
      // The server's frame and the move's step, which no Q3 cvar table archives.
      'svFps',
      'pmoveMsec',
      'dedicated',
      // Q3's first master slot is not archived, and its later ones are (`sv_init.c:675–678`).
      'master1',
      'netPort',
      // The port's own, a Node dedicated server's to set on its command line.
      'runMaster',
      // Q3's packet delays are `CVAR_CHEAT` and nothing else (`common.c:2775–2776`), and so is
      // `r_drawentities` (`tr_init.c:1126`).
      'packetDelay',
      'serverPacketDelay',
      'drawEntities',
      // A latched cheat, and latched alone (`tr_init.c:1063-1064`).
      'fullbright',
      'mapOverBrightBits',
      // The visible set's cheats (`tr_init.c:1074, 1128-1130, 1143`).
      'noVis',
      'noCull',
      'lockPvs',
      'showCluster',
      'zNear',
      // The polygon offset's (`tr_init.c:1140-1141`).
      'offsetFactor',
      'offsetUnits',
      // The light grid's scales (`tr_init.c:1097-1098`).
      'ambientScale',
      'directedScale',
      // The port's own cheats, for a capture to set.
      'preview',
      'previewTime',
      // Collision's, but `cm_playerCurveClip` (`cm_load.c:584-585`).
      'noAreas',
      'noCurves',
      // `cg_footsteps` is a cheat and nothing else (`cg_main.c:258`).
      'footsteps'
    ]);
  });

  it('latches Graphics, the match pair for a map load, the server flags and the map world', () => {
    expect(SETTING_KEYS.filter((key) => SETTINGS[key].latched)).toEqual([
      'glDriver',
      'renderer',
      'overBrightBits',
      'normalMapping',
      'specularMapping',
      'picmip',
      'gametype',
      'maxClients',
      'dedicated',
      'netPort',
      'fullbright',
      'mapOverBrightBits',
      // Archived, unlike the two before it (`tr_init.c:1052`), as are the three after it
      // (`tr_init.c:1022, 1024, 1034`).
      'subdivisions',
      'multitexture',
      'textureEnvAdd',
      'detailTextures'
    ]);
  });

  it("flags the debug switches, packet delays, the cheats of the renderer and collision, and the preview's", () => {
    expect(SETTING_KEYS.filter((key) => SETTINGS[key].cheat)).toEqual([
      'god',
      'thirdPerson',
      'drawCollision',
      'drawBBox',
      'debugDelag',
      'drawStatusLine',
      'flyCamera',
      'botPause',
      'packetDelay',
      'serverPacketDelay',
      'drawEntities',
      'fullbright',
      // Archived, unlike the two before it (`tr_init.c:1071`).
      'lodCurveError',
      'noVis',
      'noCull',
      'lockPvs',
      'showCluster',
      'zNear',
      'offsetFactor',
      'offsetUnits',
      'ambientScale',
      'directedScale',
      'preview',
      'previewTime',
      // Collision's three (`cm_load.c:584-586`).
      'noAreas',
      'noCurves',
      'playerCurveClip',
      'footsteps'
    ]);
  });
});

describe('reading a setting from a string', () => {
  it('takes any whole number where Q3 reads the integer', () => {
    expect(read('drawCrosshair', '7')).toEqual({ value: 7 });
    // Q3 counts crosshairs round by ten, so any whole number will do.
    expect(read('drawCrosshair', '-3')).toEqual({ value: -3 });
    expect(read('drawCrosshair', '1.5')).toEqual({ problem: 'is not a whole number' });
    expect(read('handicap', '')).toEqual({ problem: 'is not a whole number' });
  });

  it("takes the frame's pace whole, and any vertical sync but 0 as on", () => {
    expect(read('maxFps', '333')).toEqual({ value: 333 });
    // Any whole number, as `com_maxfps->integer` is read: 0 or less is no cap.
    expect(read('maxFps', '-1')).toEqual({ value: -1 });
    expect(read('maxFps', '62.5')).toEqual({ problem: 'is not a whole number' });
    expect(read('maxFpsUnfocused', '30')).toEqual({ value: 30 });
    expect(read('swapInterval', '0')).toEqual({ value: false });
    expect(read('swapInterval', '2')).toEqual({ value: true });
  });

  it('takes r_mapOverBrightBits whole and unclamped, as Q3 reads it', () => {
    expect(read('mapOverBrightBits', '-1')).toEqual({ value: -1 });
    expect(read('mapOverBrightBits', '5')).toEqual({ value: 5 });
  });

  it('takes r_subdivisions as any number, unclamped, as Q3 reads it', () => {
    expect(read('subdivisions', '2.5')).toEqual({ value: 2.5 });
    expect(read('subdivisions', '-1')).toEqual({ value: -1 });
    expect(read('subdivisions', '100')).toEqual({ value: 100 });
  });

  it('takes r_lodCurveError as any number, unclamped, as Q3 reads it', () => {
    expect(read('lodCurveError', '62.5')).toEqual({ value: 62.5 });
    expect(read('lodCurveError', '-1')).toEqual({ value: -1 });
    expect(read('lodCurveError', '10000')).toEqual({ value: 10000 });
  });

  it('holds r_znear to 0.001 to 200, as Q3 holds it', () => {
    expect(read('zNear', '0.5')).toEqual({ value: 0.5 });
    expect(read('zNear', '0')).toEqual({ value: 0.001 });
    expect(read('zNear', '500')).toEqual({ value: 200 });
  });

  it('takes r_ambientScale and r_directedScale as any number, as Q3 reads them', () => {
    expect(read('ambientScale', '1.25')).toEqual({ value: 1.25 });
    expect(read('directedScale', '0')).toEqual({ value: 0 });
    expect(read('directedScale', 'x')).toEqual({ problem: 'is not a number' });
  });

  it('takes r_offsetFactor and r_offsetUnits as any number, as Q3 reads them', () => {
    expect(read('offsetFactor', '-1.5')).toEqual({ value: -1.5 });
    expect(read('offsetUnits', '4')).toEqual({ value: 4 });
    expect(read('offsetUnits', 'x')).toEqual({ problem: 'is not a number' });
  });

  it('takes r_fastsky through its integer, as Q3 reads it', () => {
    expect(read('fastSky', '1')).toEqual({ value: true });
    expect(read('fastSky', '-2')).toEqual({ value: true });
    expect(read('fastSky', '0')).toEqual({ value: false });
  });

  it('takes pcq_previewTime in whole milliseconds, 0 or more', () => {
    expect(read('previewTime', '12345')).toEqual({ value: 12345 });
    expect(read('previewTime', '-1')).toEqual({ problem: 'is not 0 or more' });
    expect(read('previewTime', '0.5')).toEqual({ problem: 'is not a whole number' });
  });

  it('takes any whole number but 0 as on, for a switch', () => {
    expect(read('thirdPerson', '2')).toEqual({ value: true });
    expect(read('gibs', '0')).toEqual({ value: false });
    expect(read('marks', '0')).toEqual({ value: false });
    expect(read('marksOnTriangleMeshes', '-1')).toEqual({ value: true });
    expect(read('drawFPS', 'yes')).toEqual({ problem: 'is not a whole number' });
  });

  it("takes cg_shadows whole, as cgame reads its integer: 2 and 3 Q3's other shadows", () => {
    expect(read('shadows', '3')).toEqual({ value: 3 });
    expect(read('shadows', '0')).toEqual({ value: 0 });
    expect(read('shadows', '1.5')).toEqual({ problem: 'is not a whole number' });
  });

  it('takes any number where Q3 reads the value', () => {
    expect(read('crosshairSize', '32.5')).toEqual({ value: 32.5 });
    expect(read('mPitch', '-0.022')).toEqual({ value: -0.022 });
    expect(read('volume', 'loud')).toEqual({ problem: 'is not a number' });
  });

  it('takes the renderer in any case', () => {
    expect(read('renderer', 'OpenGL2')).toEqual({ value: 'opengl2' });
    expect(read('renderer', 'vulkan')).toEqual({ problem: 'is neither opengl1 nor opengl2' });
  });

  it('takes webgl2 as the backend in any case, and anything else as WebGPU', () => {
    expect(read('glDriver', 'WebGL2')).toEqual({ value: 'webgl2' });
    expect(read('glDriver', 'webgpu')).toEqual({ value: 'webgpu' });
    // What Q3's config holds.
    expect(read('glDriver', 'opengl32')).toEqual({ value: 'webgpu' });
    expect(read('glDriver', '')).toEqual({ value: 'webgpu' });
  });

  it('clamps the overbright bits and the fov, as Q3 does', () => {
    expect(read('overBrightBits', '5')).toEqual({ value: 2 });
    expect(read('overBrightBits', '-1')).toEqual({ value: 0 });
    expect(read('fov', '200')).toEqual({ value: 160 });
    expect(read('fov', '0')).toEqual({ value: 1 });
  });

  it('clamps con_notifylines to 1–16, as Cvar_CheckRange does', () => {
    expect(read('notifyLines', '0')).toEqual({ value: 1 });
    expect(read('notifyLines', '1')).toEqual({ value: 1 });
    expect(read('notifyLines', '16')).toEqual({ value: 16 });
    expect(read('notifyLines', '17')).toEqual({ value: 16 });
  });

  it('takes con_notifytime as any number of seconds', () => {
    expect(read('notifyTime', '0.5')).toEqual({ value: 0.5 });
  });

  it('clamps con_scale to 1–4, as Cvar_CheckRange does, and takes a fraction', () => {
    expect(read('conScale', '0.5')).toEqual({ value: 1 });
    expect(read('conScale', '1.5')).toEqual({ value: 1.5 });
    expect(read('conScale', '5')).toEqual({ value: 4 });
  });

  it('refuses a grapple type or speedometer that does not exist, and armor below 0', () => {
    expect(read('allowGrapple', '4')).toEqual({ problem: 'is not 0, 1, 2 or 3' });
    expect(read('speedometer', '4')).toEqual({ problem: 'is not 0, 1, 2 or 3' });
    expect(read('spawnArmor', '-5')).toEqual({ problem: 'is not 0 or more' });
  });

  it('refuses a negative weapon mask for the lag compensation, on either side', () => {
    expect(read('unlagged', '-1')).toEqual({ problem: 'is not 0 or more' });
    expect(read('delagWeapons', '-1')).toEqual({ problem: 'is not 0 or more' });
    expect(read('unlagged', '0')).toEqual({ value: 0 });
    expect(read('delagWeapons', '0')).toEqual({ value: 0 });
  });

  it('takes an sv_fps under 1 as it is, for the host to correct where it reads it', () => {
    expect(read('svFps', '0')).toEqual({ value: 0 });
    expect(read('svFps', '-5')).toEqual({ value: -5 });
  });

  it('takes any name at all', () => {
    expect(read('name', ' ^1Sarge ')).toEqual({ value: ' ^1Sarge ' });
  });
});
