import { describe, expect, it } from 'vitest';

import { configCommands } from '../formats/q3config';
import { autoComplete } from '../view/field-complete';
import {
  CommandRouter,
  MAX_INSERT_DEPTH,
  compareExtension,
  defaultExtension,
  type CommandRouterOptions
} from './command-router';
import { GameConfig } from './game-config';
import type { HomeFolder } from './home-folder';
import { readCfg } from './presets';

const USAGE = 'exec <filename> : execute a script file\n';

/**
 * A router over a real config, its commands registered, with `connect` and `map` registered too,
 * cgame's `viewpos` and `weapon`, the game module's `addbot`, a client with no server to forward
 * to, and cfgs read from `files`. `log` has every command taken, in the order they ran.
 */
function setup(
  files: Record<string, string> = {},
  read = (path: string): Promise<string | undefined> => Promise.resolve(files[path])
) {
  const config = new GameConfig({ debugMode: true, print: () => {} });
  const log: string[] = [];
  const printed: string[] = [];
  const asked: string[] = [];
  const router = new CommandRouter({
    cvar: (argv) => {
      const taken = config.cvarCommand(argv);
      if (taken) log.push(`cvar ${argv.join(' ')}`);
      return taken;
    },
    cvarString: (name) => config.cvars.get(name),
    cgame: (argv) => {
      if (argv[0] !== 'viewpos' && argv[0] !== 'weapon') return false;
      log.push(`cgame ${argv.join(' ')}`);
      return true;
    },
    game: (line, argv) => {
      if (argv[0].toLowerCase() !== 'addbot') return false;
      log.push(`game ${line}`);
      return true;
    },
    forward: () => false,
    readCfg: (path) => {
      asked.push(path);
      return read(path);
    },
    listCfgs: () => Promise.resolve(Object.keys(files)),
    print: (text) => void printed.push(text)
  });
  config.addCommands({
    add: (name, run) =>
      router.add(name, (argv) => {
        log.push(`config ${argv.join(' ')}`);
        return run?.(argv);
      }),
    setCompletion: (name, complete) => router.setCompletion(name, complete)
  });
  for (const name of ['connect', 'map', 'kick']) {
    router.add(name, (argv) => void log.push(`${name} ${argv.slice(1).join(' ')}`));
  }
  return { router, config, log, printed, asked };
}

/** A home folder holding these files, by path. */
function home(files: Record<string, string>): HomeFolder {
  return { read: async (path) => files[path], list: async () => [], write: async () => false };
}

describe('the router', () => {
  it("runs a command at once while no file is being read, where a bind's would go", () => {
    const { router, config, log, printed } = setup();
    router.execute(['viewpos']);
    router.execute(['cg_fov', '100']);
    expect(config.cvars.settings.fov).toBe(100);
    router.execute(['map', 'q3dm17']);
    router.execute(['addbot', 'sarge', '2']);
    expect(log).toEqual([
      'cgame viewpos',
      'cvar cg_fov 100',
      'map q3dm17',
      'game "addbot" "sarge" "2"'
    ]);
    expect(printed).toEqual([]);
  });

  it("tries the registered commands, then a cvar, cgame and the game module, as Cmd_ExecuteString does (cmd.c:762–815)", () => {
    const { router, config, log } = setup();
    // A registered command before a cvar of its name.
    router.execute(['set', 'connect', '1']);
    router.execute(['connect', 'example.com']);
    expect(config.cvars.get('connect')).toBe('1');
    // A cvar before cgame's command and the game module's.
    router.execute(['set', 'weapon', '1']);
    router.execute(['weapon', '3']);
    router.execute(['set', 'addbot', '1']);
    router.execute(['addbot', 'sarge']);
    expect(config.cvars.get('weapon')).toBe('3');
    expect(config.cvars.get('addbot')).toBe('sarge');
    expect(log).toEqual([
      'config set connect 1',
      'connect example.com',
      'config set weapon 1',
      'cvar weapon 3',
      'config set addbot 1',
      'cvar addbot sarge'
    ]);
  });

  it('tries cgame before the game module, and the game module before the server', () => {
    const order: string[] = [];
    const router = new CommandRouter({
      cvar: () => false,
      cvarString: () => '',
      cgame: (argv) => {
        order.push('cgame');
        return argv[0] === 'both';
      },
      game: (_line, argv) => {
        order.push('game');
        return argv[0] !== 'neither';
      },
      forward: () => {
        order.push('server');
        return true;
      },
      readCfg: () => Promise.resolve(undefined),
      listCfgs: () => Promise.resolve([]),
      print: () => {}
    });
    router.execute(['both']);
    router.execute(['game']);
    router.execute(['neither']);
    expect(order).toEqual(['cgame', 'cgame', 'game', 'cgame', 'game', 'server']);
  });

  it('matches a command without regard to case', () => {
    const { router, config, log } = setup();
    router.execute(['MAP', 'q3dm17']);
    router.execute(['Set', 'cg_fov', '90']);
    router.execute(['AddBot', 'sarge']);
    expect(config.cvars.settings.fov).toBe(90);
    expect(log).toEqual(['map q3dm17', 'config Set cg_fov 90', 'game "AddBot" "sarge"']);
  });

  it("keeps a name's first command, and says so of another, as Cmd_AddCommand does", () => {
    const { router, log, printed } = setup();
    router.add('Map', () => void log.push('second map'));
    router.execute(['map', 'q3dm17']);
    expect(log).toEqual(['map q3dm17']);
    expect(printed).toEqual(['Cmd_AddCommand: Map already defined\n']);
  });

  it('passes over a command with no words', () => {
    const { router, log, printed } = setup();
    router.execute([]);
    expect(log).toEqual([]);
    expect(printed).toEqual([]);
  });
});

describe('the command table', () => {
  /** A router of its own commands, with `a`, then `b`, then `c` added after them. */
  function table() {
    const printed: string[] = [];
    const ran: string[] = [];
    const router = new CommandRouter({
      cvar: () => false,
      cvarString: () => '',
      cgame: (argv) => {
        ran.push(`cgame ${argv[0]}`);
        return argv[0] === 'weapon';
      },
      game: () => false,
      forward: (line) => {
        ran.push(`server ${line}`);
        return true;
      },
      readCfg: () => Promise.resolve(undefined),
      listCfgs: () => Promise.resolve([]),
      print: (text) => void printed.push(text)
    });
    for (const name of ['a', 'b', 'c']) router.add(name, () => void ran.push(name));
    return { router, printed, ran };
  }

  it("lists every name newest first, cmd.c's own among them, then counts them (Cmd_List_f, cmd.c:822–842)", () => {
    const { router, printed } = table();
    router.execute(['cmdlist']);
    expect(printed).toEqual([
      // `cmdlist` ran, so it is at the front.
      'cmdlist\n',
      'c\n',
      'b\n',
      'a\n',
      'wait\n',
      'echo\n',
      'vstr\n',
      'execq\n',
      'exec\n',
      '9 commands\n'
    ]);
  });

  it('moves a command to the front as it runs, as Cmd_ExecuteString does (cmd.c:777–779)', () => {
    const { router, printed } = table();
    router.execute(['A']);
    router.execute(['echo']);
    printed.length = 0;
    router.execute(['cmdlist']);
    expect(printed.slice(0, 5)).toEqual(['cmdlist\n', 'echo\n', 'a\n', 'c\n', 'b\n']);
  });

  it('gives the names as they were added, in the order Cmd_CommandCompletion walks them', () => {
    const { router } = table();
    router.add('Weapon');
    router.add('weapon', () => {});
    router.execute(['B']);
    expect(router.names()).toEqual([
      'b',
      'Weapon',
      'c',
      'a',
      'wait',
      'echo',
      'vstr',
      'execq',
      'exec',
      'cmdlist'
    ]);
  });

  it("lists the names Com_Filter's wildcards match, without regard to case, and counts those", () => {
    const { router, printed } = table();
    router.execute(['cmdlist', 'E*']);
    expect(printed).toEqual(['echo\n', 'execq\n', 'exec\n', '3 commands\n']);
    printed.length = 0;
    router.execute(['cmdlist', 'nothing']);
    expect(printed).toEqual(['0 commands\n']);
  });

  it('keeps a name for completion alone, which goes on to cgame and the server, and is listed', () => {
    const { router, printed, ran } = table();
    router.add('weapon');
    router.add('kill');
    // Added again, as every gamestate's cgame adds them, without a word.
    router.add('Weapon');
    router.add('kill');
    router.execute(['weapon', '3']);
    router.execute(['KILL']);
    expect(ran).toEqual(['cgame weapon', 'cgame KILL', 'server "KILL"']);
    router.execute(['cmdlist', '?i*']);
    expect(printed).toEqual(['kill\n', '1 commands\n']);
  });

  it('keeps a name for completion alone over a command added after it, and says so', () => {
    const { router, printed, ran } = table();
    router.add('kill');
    router.add('KILL', () => void ran.push('mine'));
    router.add('a');
    router.execute(['kill']);
    expect(ran).toEqual(['cgame kill', 'server "kill"']);
    expect(printed).toEqual(['Cmd_AddCommand: KILL already defined\n']);
  });

  it('gives a command its completer, found without regard to case (cmd.c:664–673)', () => {
    const { router } = table();
    const complete = () => {};
    router.add('weapon');
    router.setCompletion('WEAPON', complete);
    // A name not added takes none.
    router.setCompletion('nothing', complete);
    expect(router.completer('Weapon')).toBe(complete);
    expect(router.completer('a')).toBeUndefined();
    expect(router.completer('nothing')).toBeUndefined();
    // Finding it moves nothing.
    expect(router.names().slice(0, 3)).toEqual(['weapon', 'c', 'b']);
  });

  it("completes exec's and execq's cfgs and vstr's cvar, as Cmd_Init has it", async () => {
    const { router } = setup({ 'autoexec.cfg': '', 'presets/vq3.cfg': '' });
    const names = {
      commands: router.names(),
      cvars: [{ name: 'cg_fov', value: '90' }],
      completer: (name: string) => router.completer(name)
    };
    const tab = async (text: string) =>
      (await autoComplete({ text, cursor: text.length, scroll: 0 }, names, false, () => {})).text;
    expect(await tab('exec au')).toBe('exec autoexec.cfg ');
    expect(await tab('EXECQ pre')).toBe('EXECQ presets/vq3.cfg ');
    expect(await tab('vstr cg_f')).toBe('vstr cg_fov ');
  });
});

describe('echo', () => {
  it("prints the rest of the line, its words joined by a space (Cmd_Echo_f, cmd.c:326–329)", () => {
    const { router, printed } = setup();
    router.execute(['echo', 'hello', 'big  world', '^1red']);
    router.execute(['ECHO']);
    expect(printed).toEqual(['hello big  world ^1red\n', '\n']);
  });
});

describe('exec', () => {
  it('gives a file the .cfg it lacks, and leaves an extension it has', async () => {
    const { router, asked } = setup();
    for (const name of ['presets/cpm', 'autoexec.cfg', 'my.dir/file', 'notes.txt']) {
      router.execute(['exec', name]);
    }
    await router.settled();
    expect(asked).toEqual(['presets/cpm.cfg', 'autoexec.cfg', 'my.dir/file.cfg', 'notes.txt']);

    // ioq3's `COM_DefaultExtension`: a dot counts only after the last slash, the name's first
    // character among them, where id's walk back stopped short of it.
    expect(defaultExtension('.hidden', '.cfg')).toBe('.hidden');
    expect(defaultExtension('a.b/c', '.cfg')).toBe('a.b/c.cfg');
    expect(defaultExtension('a/.b', '.cfg')).toBe('a/.b');
  });

  it("compares a name's extension in any case, as COM_CompareExtension does", () => {
    expect(compareExtension('a.cfg', '.cfg')).toBe(true);
    expect(compareExtension('sub/A.CFG', '.cfg')).toBe(true);
    expect(compareExtension('.cfg', '.cfg')).toBe(true);
    expect(compareExtension('cfg', '.cfg')).toBe(false);
    expect(compareExtension('a.cfg.txt', '.cfg')).toBe(false);
  });

  it('says how it is used, given no file or more than one', async () => {
    const { router, printed, asked } = setup();
    router.execute(['exec']);
    router.execute(['exec', 'a', 'b']);
    await router.settled();
    expect(printed).toEqual([USAGE, USAGE]);
    expect(asked).toEqual([]);
  });

  it("says it couldn't exec a file there is none of, and that it is execing one there is, by the name it read", async () => {
    const { router, printed } = setup({ 'autoexec.cfg': '' });
    router.execute(['exec', 'missing']);
    router.execute(['EXEC', 'autoexec']);
    await router.settled();
    expect(printed).toEqual(["couldn't exec missing.cfg\n", 'execing autoexec.cfg\n']);
  });

  it("runs a file's lines in order, each where a bind's would go", async () => {
    const { router, config, log, printed } = setup({
      'a.cfg': '// the rules\nseta cg_fov 100\nmap q3dm17\nseta cg_fov "110"; kick all\nnope\n'
    });
    router.execute(['exec', 'a']);
    await router.settled();
    expect(log).toEqual([
      'config seta cg_fov 100',
      'map q3dm17',
      'config seta cg_fov 110',
      'kick all'
    ]);
    expect(config.cvars.settings.fov).toBe(110);
    expect(printed).toEqual(['execing a.cfg\n', 'Unknown command "nope^7"\n']);
  });

  it("runs a text cut as a file's lines are, what follows an exec waiting for it", async () => {
    const { router, config, log } = setup({ 'a.cfg': 'seta cg_fov 100' });
    router.executeText('cg_fov 90; map "q3dm17"\n// a note\nexec a; kick all');
    expect(log).toEqual(['cvar cg_fov 90', 'map q3dm17']);
    await router.settled();
    expect(log).toEqual(['cvar cg_fov 90', 'map q3dm17', 'config seta cg_fov 100', 'kick all']);
    expect(config.cvars.settings.fov).toBe(100);
  });

  it("runs a command that comes while a file is read after the file's lines, as Cbuf_InsertText has it", async () => {
    const { router, config, log, printed } = setup({ 'a.cfg': 'seta cg_fov 100' });
    router.execute(['exec', 'a']);
    router.execute(['seta', 'cg_fov', '120']);
    router.execute(['nope']);
    expect(config.cvars.settings.fov).not.toBe(120);
    expect(printed).toEqual([]);
    await router.settled();
    expect(log).toEqual(['config seta cg_fov 100', 'config seta cg_fov 120']);
    expect(config.cvars.settings.fov).toBe(120);
    expect(printed).toEqual(['execing a.cfg\n', 'Unknown command "nope^7"\n']);

    // With the file done, a command runs at once again.
    router.execute(['cg_fov', '90']);
    expect(config.cvars.settings.fov).toBe(90);
  });

  it('runs a nested exec before the lines after it, however long its file takes', async () => {
    const files: Record<string, string> = {
      'a.cfg': 'seta one 1\nexec b\nseta four 4',
      'b.cfg': 'seta two 2\nexec c',
      'c.cfg': 'seta three 3'
    };
    const slow = (path: string) =>
      new Promise<string | undefined>((resolve) => setTimeout(() => resolve(files[path]), 5));
    const { router, log, printed } = setup(files, slow);
    router.execute(['exec', 'a']);
    router.execute(['seta', 'five', '5']);
    await router.settled();
    expect(log).toEqual([
      'config seta one 1',
      'config seta two 2',
      'config seta three 3',
      'config seta four 4',
      'config seta five 5'
    ]);
    expect(printed).toEqual(['execing a.cfg\n', 'execing b.cfg\n', 'execing c.cfg\n']);
  });

  it("reads the home folder's copy of a preset before the port's own", async () => {
    const mine = setup({}, (path) => readCfg(path, home({ 'presets/cpm.cfg': 'seta g_gamepreset "MINE"' })));
    mine.router.execute(['exec', 'presets/cpm']);
    await mine.router.settled();
    expect(mine.config.cvars.get('g_gamepreset')).toBe('MINE');
    expect(mine.config.cvars.get('g_quadfactor')).toBe('');

    const shipped = setup({}, (path) => readCfg(path, home({})));
    shipped.router.execute(['exec', 'presets/cpm']);
    await shipped.router.settled();
    expect(shipped.config.cvars.get('g_gamepreset')).toBe('CPM');
    expect(shipped.config.cvars.get('g_quadfactor')).toBe('4');
  });

  it('runs a file without saying so as execq, and says how each is used (cmd.c:275–291)', async () => {
    const { router, config, printed } = setup({ 'a.cfg': 'seta quiet 1' });
    router.execute(['execq', 'a']);
    router.execute(['EXECQ', 'missing']);
    router.execute(['execq']);
    router.execute(['exec', 'a', 'b']);
    await router.settled();
    expect(config.cvars.get('quiet')).toBe('1');
    expect(printed).toEqual([
      "couldn't exec missing.cfg\n",
      'execq <filename> : execute a script file without notification\n',
      USAGE
    ]);
  });

  it('stops a file that execs itself, and runs on after it', async () => {
    const { router, config, printed } = setup({ 'loop.cfg': 'seta n 1\nexec loop' });
    router.execute(['exec', 'loop']);
    router.execute(['seta', 'after', '1']);
    await router.settled();
    expect(printed.filter((line) => line === 'execing loop.cfg\n')).toHaveLength(MAX_INSERT_DEPTH);
    expect(printed.at(-1)).toBe("couldn't exec loop.cfg: nested too deeply\n");
    expect(config.cvars.get('after')).toBe('1');
  });
});

/**
 * A router whose `map` holds until {@link loaded} is called, whose game module takes `addbot`,
 * whose cvars are `cvars`, and whose server, where there is one, hears what is forwarded. `log`
 * has every command taken, in the order they ran, and `printed` what it printed.
 */
function buffer(
  options: { server?: boolean; client?: boolean; cvars?: Record<string, string> } = {}
) {
  const log: string[] = [];
  const printed: string[] = [];
  let loaded: (ok: boolean) => void = () => {};
  const routes: CommandRouterOptions = {
    cvar: () => false,
    cvarString: (name) => options.cvars?.[name] ?? '',
    game: (_line, argv) => {
      if (argv[0] !== 'addbot') return false;
      log.push(`game ${argv.join(' ')}`);
      return true;
    },
    forward: (line) => {
      if (!options.server) return false;
      log.push(`server ${line}`);
      return true;
    },
    readCfg: () => Promise.resolve(undefined),
    listCfgs: () => Promise.resolve([]),
    print: (text) => void printed.push(text)
  };
  // A program with no client half has nothing to forward to.
  if (options.client === false) delete routes.forward;
  const router = new CommandRouter(routes);
  router.add('map', (argv) => {
    log.push(`map ${argv[1]}`);
    return new Promise<void>((resolve, reject) => {
      loaded = (ok) => (ok ? resolve() : reject(new Error('no map')));
    });
  });
  router.add('seta', (argv) => void log.push(`config ${argv.join(' ')}`));
  /** Let the map in, or fail it. */
  const finish = async (ok = true) => {
    loaded(ok);
    await settle();
  };
  /**
   * Run this many frames, as the page does: each once whatever is under way has gone as far as it
   * can, and each one's commands run before the next.
   */
  const frames = async (count: number) => {
    for (let i = 0; i < count; i++) {
      await settle();
      router.frame();
      await settle();
    }
  };
  return { router, log, printed, finish, frames };
}

/** Let everything already under way run as far as it can. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Run a line as a bind or the menu would hand it over, one command at a time. */
function run(router: CommandRouter, line: string): void {
  for (const argv of configCommands(line)) router.execute(argv);
}

describe('wait', () => {
  it("holds what comes after it for a frame, or for as many as it says (id's Cmd_Wait_f)", async () => {
    const { router, log, printed, frames } = buffer();
    run(router, 'seta a 1; wait; seta b 1; WAIT 3; seta c 1; wait 0; seta d 1');
    await settle();
    expect(log).toEqual(['config seta a 1']);
    await frames(1);
    expect(log).toEqual(['config seta a 1', 'config seta b 1']);
    await frames(2);
    expect(log).toHaveLength(2);
    await frames(1);
    // `wait 0` holds nothing.
    expect(log).toEqual(['config seta a 1', 'config seta b 1', 'config seta c 1', 'config seta d 1']);
    expect(printed).toEqual([]);

    // With the buffer empty, a command runs at once again.
    router.execute(['seta', 'e', '1']);
    expect(log.at(-1)).toBe('config seta e 1');
  });

  it('counts a negative wait as one frame, where id\'s buffer would hold for ever', async () => {
    const { router, log, frames } = buffer();
    run(router, 'wait -5; seta a 1');
    await settle();
    expect(log).toEqual([]);
    await frames(1);
    expect(log).toEqual(['config seta a 1']);
  });
});

describe('a map holding the buffer', () => {
  it('runs nothing behind a map until the map is in, as the load holds Q3', async () => {
    const { router, log, finish, frames } = buffer();
    run(router, 'map q3dm17; seta a 1');
    router.execute(['seta', 'b', '1']);
    expect(log).toEqual(['map q3dm17']);
    await frames(3);
    expect(log).toEqual(['map q3dm17']);
    await finish();
    expect(log).toEqual(['map q3dm17', 'config seta a 1', 'config seta b 1']);
  });

  it("runs FIGHT's lines in q3_ui's order (ui_startserver.c:793–819)", async () => {
    const { router, log, finish, frames } = buffer({ server: true });
    run(router, 'wait ; wait ; map q3dm17');
    run(router, 'wait 3');
    run(router, 'addbot sarge 3 red 0');
    run(router, 'wait 5; team red');
    await frames(2);
    expect(log).toEqual(['map q3dm17']);
    // The frames the load takes count for nothing behind it.
    await frames(5);
    expect(log).toEqual(['map q3dm17']);
    await finish();
    await frames(2);
    expect(log).toEqual(['map q3dm17']);
    await frames(1);
    expect(log).toEqual(['map q3dm17', 'game addbot sarge 3 red 0']);
    await frames(5);
    expect(log).toEqual(['map q3dm17', 'game addbot sarge 3 red 0', 'server "team" "red"']);
  });

  it('drops what was behind a map that fails, and runs what comes after at once', async () => {
    const { router, log, finish } = buffer();
    run(router, 'map nowhere; seta a 1');
    await finish(false);
    await router.settled();
    expect(log).toEqual(['map nowhere']);
    router.execute(['seta', 'b', '1']);
    expect(log.at(-1)).toBe('config seta b 1');
  });
});

describe('a command nothing here takes (CL_ForwardCommandToServer, cl_main.c:1491–1511)', () => {
  it('goes to the server as a client command, with its arguments', () => {
    const { router, log, printed } = buffer({ server: true });
    router.execute(['team', 'red']);
    router.execute(['follow']);
    expect(log).toEqual(['server "team" "red"', 'server "follow"']);
    expect(printed).toEqual([]);
  });

  it("drops a key's release without a word, and calls a press unknown, server or none", () => {
    for (const server of [true, false]) {
      const { router, log, printed } = buffer({ server });
      router.execute(['-scores', '15']);
      router.execute(['+scores', '15']);
      expect(log).toEqual([]);
      expect(printed).toEqual(['Unknown command "+scores^7"\n']);
    }
  });

  it('is unknown with no server to hear it, at once or behind a wait', async () => {
    const { router, printed } = buffer();
    router.execute(['team', 'red']);
    expect(printed).toEqual(['Unknown command "team^7"\n']);
    run(router, 'wait; team red');
    router.frame();
    await router.settled();
    expect(printed).toEqual(['Unknown command "team^7"\n', 'Unknown command "team^7"\n']);
  });

  it('is said nothing of where the program has no client half, as a dedicated server says nothing', async () => {
    const { router, printed } = buffer({ client: false });
    run(router, 'team red; +scores; -scores; wait; nope');
    router.frame();
    await router.settled();
    expect(printed).toEqual([]);
  });
});

describe('vstr (Cmd_Vstr_f, cmd.c:306–316)', () => {
  it("runs a cvar's string as commands, in front of what is queued behind it", async () => {
    const { router, log, finish } = buffer({
      cvars: { rot: 'seta a 1; seta b 1', next: 'map q3dm17; seta c 1' }
    });
    run(router, 'vstr rot; seta after 1');
    expect(log).toEqual(['config seta a 1', 'config seta b 1', 'config seta after 1']);
    log.length = 0;
    run(router, 'VSTR next; seta d 1');
    expect(log).toEqual(['map q3dm17']);
    await finish();
    expect(log).toEqual(['map q3dm17', 'config seta c 1', 'config seta d 1']);
  });

  it('says how it is used, and runs nothing for a cvar there is none of', () => {
    const { router, log, printed } = buffer();
    router.execute(['vstr']);
    router.execute(['vstr', 'a', 'b']);
    router.execute(['vstr', 'nothing']);
    const usage = 'vstr <variablename> : execute a variable command\n';
    expect(printed).toEqual([usage, usage]);
    expect(log).toEqual([]);
  });

  it('stops a cvar that runs itself, and runs on after it', () => {
    const { router, log, printed } = buffer({ cvars: { loop: 'seta n 1; vstr loop' } });
    run(router, 'vstr loop; seta after 1');
    expect(log.filter((line) => line === 'config seta n 1')).toHaveLength(MAX_INSERT_DEPTH);
    expect(log.at(-1)).toBe('config seta after 1');
    expect(printed).toEqual(['vstr loop: nested too deeply\n']);
  });
});

describe('a wait between nestings', () => {
  it('lets a cvar that runs itself after a wait run on, holding what comes behind it, as Q3 does', async () => {
    const { router, log, printed, frames } = buffer({
      cvars: { loop: 'seta n 1; wait; vstr loop' }
    });
    run(router, 'vstr loop');
    await settle();
    router.execute(['seta', 'behind', '1']);
    await frames(MAX_INSERT_DEPTH + 4);
    expect(log.filter((line) => line === 'config seta n 1')).toHaveLength(MAX_INSERT_DEPTH + 5);
    expect(log).not.toContain('config seta behind 1');
    expect(printed).toEqual([]);
  });

  it('lets a file that execs itself after a wait run on too', async () => {
    const { router, printed } = setup({ 'loop.cfg': 'seta n 1\nwait\nexec loop' });
    router.execute(['exec', 'loop']);
    for (let i = 0; i < MAX_INSERT_DEPTH + 4; i++) {
      await settle();
      router.frame();
    }
    await settle();
    expect(printed.filter((line) => line === 'execing loop.cfg\n')).toHaveLength(MAX_INSERT_DEPTH + 5);
    expect(printed.filter((line) => line.includes('nested too deeply'))).toEqual([]);
  });
});
