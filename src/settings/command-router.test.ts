import { describe, expect, it, vi } from 'vitest';

import { configCommands } from '../formats/q3config';
import { CommandRouter, MAX_EXEC_DEPTH, defaultExtension } from './command-router';
import { GameConfig } from './game-config';
import type { HomeFolder } from './home-folder';
import { readCfg } from './presets';

const USAGE = 'exec <filename> : execute a script file\n';

/**
 * A router over a real config, with the client's `viewpos`, a host that keeps the lines it is
 * sent, and cfgs read from `files`. `log` has every command taken, in the order they ran.
 */
function setup(
  files: Record<string, string> = {},
  read = (path: string): Promise<string | undefined> => Promise.resolve(files[path])
) {
  const config = new GameConfig({ debugMode: true, warn: () => {} });
  const log: string[] = [];
  const printed: string[] = [];
  const asked: string[] = [];
  const warn = vi.fn();
  const router = new CommandRouter({
    client: (argv) => {
      if (argv[0] !== 'viewpos') return false;
      log.push('client viewpos');
      return true;
    },
    host: (line) => {
      log.push(`host ${line}`);
      return true;
    },
    config: (argv) => {
      const taken = config.command(argv);
      if (taken) log.push(`config ${argv.join(' ')}`);
      return taken;
    },
    readCfg: (path) => {
      asked.push(path);
      return read(path);
    },
    print: (text) => void printed.push(text),
    warn
  });
  return { router, config, log, printed, asked, warn };
}

/** A home folder holding these files, by path. */
function home(files: Record<string, string>): HomeFolder {
  return { read: async (path) => files[path], list: async () => [] };
}

describe('the router', () => {
  it("runs a command at once while no file is being read, where a bind's would go", () => {
    const { router, config, log } = setup();
    expect(router.execute(['viewpos'])).toBe(true);
    expect(router.execute(['cg_fov', '100'])).toBe(true);
    expect(config.cvars.settings.fov).toBe(100);
    expect(router.execute(['map', 'q3dm17'])).toBe(true);
    expect(router.execute(['addbot', 'sarge', '2'])).toBe(true);
    expect(log).toEqual([
      'client viewpos',
      'config cg_fov 100',
      'host "map" "q3dm17"',
      'host "addbot" "sarge" "2"'
    ]);
    // Nothing takes it, which the bind that ran it reports.
    expect(router.execute(['nope'])).toBe(false);
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

    // id's `COM_DefaultExtension`: a dot counts only after the last slash, and not as the name's
    // first character.
    expect(defaultExtension('.hidden', '.cfg')).toBe('.hidden.cfg');
    expect(defaultExtension('a.b/c', '.cfg')).toBe('a.b/c.cfg');
    expect(defaultExtension('a/.b', '.cfg')).toBe('a/.b');
  });

  it('says how it is used, given no file or more than one', async () => {
    const { router, printed, asked } = setup();
    router.execute(['exec']);
    router.execute(['exec', 'a', 'b']);
    await router.settled();
    expect(printed).toEqual([USAGE, USAGE]);
    expect(asked).toEqual([]);
  });

  it("says it couldn't exec a file there is none of, and that it is execing one there is, as typed", async () => {
    const { router, printed } = setup({ 'autoexec.cfg': '' });
    router.execute(['exec', 'missing']);
    router.execute(['EXEC', 'autoexec']);
    await router.settled();
    expect(printed).toEqual(["couldn't exec missing\n", 'execing autoexec\n']);
  });

  it("runs a file's lines in order, each where a bind's would go", async () => {
    const { router, config, log, warn } = setup({
      'a.cfg': '// the rules\nseta cg_fov 100\nmap q3dm17\nseta cg_fov "110"; kick all\nnope\n'
    });
    router.execute(['exec', 'a']);
    await router.settled();
    expect(log).toEqual([
      'config seta cg_fov 100',
      'host "map" "q3dm17"',
      'config seta cg_fov 110',
      'host "kick" "all"'
    ]);
    expect(config.cvars.settings.fov).toBe(110);
    expect(warn).toHaveBeenCalledWith('Unknown command "nope"');
  });

  it("runs a command that comes while a file is read after the file's lines, as Cbuf_InsertText has it", async () => {
    const { router, config, log, warn } = setup({ 'a.cfg': 'seta cg_fov 100' });
    router.execute(['exec', 'a']);
    expect(router.execute(['seta', 'cg_fov', '120'])).toBe(true);
    expect(router.execute(['nope'])).toBe(true);
    expect(config.cvars.settings.fov).not.toBe(120);
    await router.settled();
    expect(log).toEqual(['config seta cg_fov 100', 'config seta cg_fov 120']);
    expect(config.cvars.settings.fov).toBe(120);
    expect(warn).toHaveBeenCalledWith('Unknown command "nope"');

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
    expect(printed).toEqual(['execing a\n', 'execing b\n', 'execing c\n']);
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

  it('stops a file that execs itself, and runs on after it', async () => {
    const { router, config, printed } = setup({ 'loop.cfg': 'seta n 1\nexec loop' });
    router.execute(['exec', 'loop']);
    router.execute(['seta', 'after', '1']);
    await router.settled();
    expect(printed.filter((line) => line === 'execing loop\n')).toHaveLength(MAX_EXEC_DEPTH);
    expect(printed.at(-1)).toBe("couldn't exec loop: nested too deeply\n");
    expect(config.cvars.get('after')).toBe('1');
  });
});

/**
 * A router whose host holds for `map` until {@link loaded} is called, and whose server hears what
 * is forwarded. `log` has every command taken, in the order they ran.
 */
function buffer(options: { server?: boolean } = {}) {
  const log: string[] = [];
  const warn = vi.fn();
  let loaded: (ok: boolean) => void = () => {};
  const router = new CommandRouter({
    client: () => false,
    host: (_line, argv) => {
      log.push(`host ${argv.join(' ')}`);
      if (argv[0] !== 'map') return true;
      return new Promise<void>((resolve, reject) => {
        loaded = (ok) => (ok ? resolve() : reject(new Error('no map')));
      });
    },
    config: (argv) => {
      if (argv[0] !== 'seta') return false;
      log.push(`config ${argv.join(' ')}`);
      return true;
    },
    forward: (line) => {
      if (!options.server) return false;
      log.push(`server ${line}`);
      return true;
    },
    readCfg: () => Promise.resolve(undefined),
    print: () => {},
    warn
  });
  /** Let the host's map in, or fail it. */
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
  return { router, log, warn, finish, frames };
}

/** Let everything already under way run as far as it can. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Run a line as a bind or the menu would hand it over, one command at a time. */
function run(router: CommandRouter, line: string): void {
  for (const argv of configCommands(line)) router.execute(argv);
}

describe('wait', () => {
  it("holds what comes after it for a frame, or for as many as it says (id's Cmd_Wait_f)", async () => {
    const { router, log, warn, frames } = buffer();
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
    expect(warn).not.toHaveBeenCalled();

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
    expect(log).toEqual(['host map q3dm17']);
    await frames(3);
    expect(log).toEqual(['host map q3dm17']);
    await finish();
    expect(log).toEqual(['host map q3dm17', 'config seta a 1', 'config seta b 1']);
  });

  it("runs FIGHT's lines in q3_ui's order (ui_startserver.c:793–819)", async () => {
    const { router, log, finish, frames } = buffer({ server: true });
    run(router, 'wait ; wait ; map q3dm17');
    run(router, 'wait 3');
    run(router, 'addbot sarge 3 red 0');
    run(router, 'wait 5; team red');
    await frames(2);
    expect(log).toEqual(['host map q3dm17']);
    // The frames the load takes count for nothing behind it.
    await frames(5);
    expect(log).toEqual(['host map q3dm17']);
    await finish();
    await frames(2);
    expect(log).toEqual(['host map q3dm17']);
    await frames(1);
    expect(log).toEqual(['host map q3dm17', 'host addbot sarge 3 red 0']);
    await frames(5);
    expect(log).toEqual(['host map q3dm17', 'host addbot sarge 3 red 0', 'server "team" "red"']);
  });

  it('drops what was behind a map that fails, and runs what comes after at once', async () => {
    const { router, log, finish } = buffer();
    run(router, 'map nowhere; seta a 1');
    await finish(false);
    await router.settled();
    expect(log).toEqual(['host map nowhere']);
    router.execute(['seta', 'b', '1']);
    expect(log.at(-1)).toBe('config seta b 1');
  });
});

describe("a command nothing here knows (id's CL_ForwardCommandToServer)", () => {
  it('goes to the server as a client command, with its arguments', () => {
    const { router, log, warn } = buffer({ server: true });
    expect(router.execute(['team', 'red'])).toBe(true);
    expect(router.execute(['follow'])).toBe(true);
    expect(log).toEqual(['server "team" "red"', 'server "follow"']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops a key release without a word, and calls a press unknown, server or none', () => {
    const { router, log } = buffer({ server: true });
    expect(router.execute(['-scores'])).toBe(true);
    expect(router.execute(['+scores'])).toBe(false);
    expect(log).toEqual([]);
  });

  it('is unknown with no server to hear it', async () => {
    const { router, warn } = buffer();
    expect(router.execute(['team', 'red'])).toBe(false);
    run(router, 'wait; team red');
    router.frame();
    await router.settled();
    expect(warn).toHaveBeenCalledWith('Unknown command "team"');
  });
});
