import { describe, expect, it } from 'vitest';

import { ConsoleBuffer } from '../view/console-buffer';
import { CommandRouter } from './command-router';
import { addCondump, addWriteConfig, lineEndFor } from './file-commands';
import { GameConfig } from './game-config';
import type { HomeFolder } from './home-folder';
import { readCfg } from './presets';

const WRITECONFIG_USAGE = 'Usage: writeconfig <filename>\n';
const CONDUMP_USAGE = 'usage: condump <filename>\n';
const NOT_CFG = 'Com_WriteConfig_f: Only the ".cfg" extension is supported by this command!\n';
const NOT_TXT = 'Con_Dump_f: Only the ".txt" extension is supported by this command!\n';

/**
 * A console as the page has it: a config's commands, `exec` reading the home folder, and both
 * commands, everything printed going to the console's text as well. The home folder is `files`,
 * written by `write`, which takes every file unless it is given.
 */
function setup(write?: (path: string, text: string) => Promise<boolean>) {
  const files: Record<string, string> = {};
  const home: HomeFolder = {
    read: async (path) => files[path],
    list: async () => [],
    write:
      write ??
      (async (path, text) => {
        files[path] = text;
        return true;
      })
  };
  const buffer = new ConsoleBuffer();
  buffer.resize(40);
  const printed: string[] = [];
  const print = (text: string) => {
    printed.push(text);
    buffer.print(text, 1000);
  };
  const config = new GameConfig({ debugMode: true, print });
  const router = new CommandRouter({
    cvar: (argv) => config.cvarCommand(argv),
    cvarString: (name) => config.cvars.get(name),
    game: () => false,
    readCfg: (path) => readCfg(path, home),
    print
  });
  config.addCommands(router);
  addWriteConfig(router, { text: () => config.text(), home, print });
  addCondump(router, { consoleText: buffer, dumps: home, lineEnd: '\r\n', print });
  return { router, config, files, printed };
}

/** A write that waits for `finish`, which says whether it was written. */
function heldWrite() {
  let finish!: (written: boolean) => void;
  const write = () => new Promise<boolean>((resolve) => (finish = resolve));
  return { write, finish: (written: boolean) => finish(written) };
}

// Every line is what ioquake3's `Com_WriteConfig_f` and `Con_Dump_f` print, read from their C.
describe('writeconfig', () => {
  it('says how it is used, given no file or more than one', async () => {
    const { router, printed, files } = setup();
    router.execute(['writeconfig']);
    router.execute(['writeconfig', 'a', 'b']);
    await router.settled();
    expect(printed).toEqual([WRITECONFIG_USAGE, WRITECONFIG_USAGE]);
    expect(files).toEqual({});
  });

  it('adds .cfg to a name with no extension, and refuses one with another', async () => {
    const { router, printed, files } = setup();
    for (const name of ['mine', 'Upper.CFG', 'notes.txt', '.hidden', 'sub.d/cfg']) {
      router.execute(['writeconfig', name]);
    }
    await router.settled();
    expect(printed).toEqual([
      'Writing mine.cfg.\n',
      'Writing Upper.CFG.\n',
      NOT_CFG,
      NOT_CFG,
      'Writing sub.d/cfg.cfg.\n'
    ]);
    expect(Object.keys(files)).toEqual(['mine.cfg', 'Upper.CFG', 'sub.d/cfg.cfg']);
  });

  it('writes the config as q3config.cfg is written, which exec reads back', async () => {
    const { router, config, files, printed } = setup();
    router.execute(['seta', 'cg_fov', '100']);
    router.execute(['bind', 'x', 'say hi']);
    router.execute(['writeconfig', 'mine']);
    await router.settled();
    expect(files['mine.cfg']).toBe(config.text());

    router.execute(['cg_fov', '90']);
    router.execute(['unbind', 'x']);
    router.execute(['exec', 'mine']);
    await router.settled();
    expect(printed.at(-1)).toBe('execing mine.cfg\n');
    expect(config.cvars.get('cg_fov')).toBe('100');
    expect(config.text()).toBe(files['mine.cfg']);
  });

  it('holds what is queued behind it until the file is written', async () => {
    const held = heldWrite();
    const { router, printed } = setup(held.write);
    router.execute(['writeconfig', 'mine']);
    router.execute(['echo', 'after']);
    await Promise.resolve();
    expect(printed).toEqual(['Writing mine.cfg.\n']);
    held.finish(true);
    await router.settled();
    expect(printed).toEqual(['Writing mine.cfg.\n', 'after\n']);
  });

  it('writes a backslashed name below its folder, and names it as it was given', async () => {
    const { router, files, printed } = setup();
    router.execute(['writeconfig', '\\sub\\\\mine']);
    router.execute(['exec', 'sub\\mine']);
    await router.settled();
    expect(Object.keys(files)).toEqual(['sub/mine.cfg']);
    expect(printed).toEqual(['Writing \\sub\\\\mine.cfg.\n', 'execing sub\\mine.cfg\n']);
  });

  it('refuses a name that could leave the folder, as FS_CreatePath does', async () => {
    const { router, files, printed } = setup();
    for (const name of ['../up', 'sub\\..\\up.cfg', 'a..b.cfg', 'x::y']) {
      router.execute(['writeconfig', name]);
    }
    // COM_DefaultExtension looks for a `/` alone, so the dot in `..` is taken for an extension.
    router.execute(['writeconfig', 'sub\\..\\up']);
    await router.settled();
    expect(files).toEqual({});
    expect(printed).toEqual([
      'Writing ../up.cfg.\n',
      'WARNING: refusing to create relative path "../up.cfg"\n',
      "Couldn't write ../up.cfg.\n",
      'Writing sub\\..\\up.cfg.\n',
      'WARNING: refusing to create relative path "sub/../up.cfg"\n',
      "Couldn't write sub\\..\\up.cfg.\n",
      'Writing a..b.cfg.\n',
      'WARNING: refusing to create relative path "a..b.cfg"\n',
      "Couldn't write a..b.cfg.\n",
      'Writing x::y.cfg.\n',
      'WARNING: refusing to create relative path "x::y.cfg"\n',
      "Couldn't write x::y.cfg.\n",
      NOT_CFG
    ]);
  });

  it("says it couldn't write a file the home folder didn't take", async () => {
    const { router, printed } = setup(async () => false);
    router.execute(['writeconfig', 'mine']);
    await router.settled();
    expect(printed).toEqual(['Writing mine.cfg.\n', "Couldn't write mine.cfg.\n"]);
  });
});

describe('condump', () => {
  it('says how it is used, given no file or more than one, and refuses another extension', async () => {
    const { router, printed, files } = setup();
    router.execute(['condump']);
    router.execute(['condump', 'a', 'b']);
    router.execute(['condump', 'mine.cfg']);
    await router.settled();
    expect(printed).toEqual([CONDUMP_USAGE, CONDUMP_USAGE, NOT_TXT]);
    expect(files).toEqual({});
  });

  it('writes the console from its first line to the one being written, its own line in it', async () => {
    const { router, files, printed } = setup();
    router.execute(['echo', 'one']);
    router.execute(['echo', '^1two']);
    router.execute(['condump', 'Mine.TXT']);
    await router.settled();
    expect(printed.at(-1)).toBe('Dumped console text to Mine.TXT.\n');
    expect(files['Mine.TXT']).toBe('one\r\ntwo\r\nDumped console text to Mine.TXT.\r\n\r\n');
  });

  it('holds what is queued behind it until the file is written', async () => {
    const held = heldWrite();
    const { router, printed } = setup(held.write);
    router.execute(['condump', 'mine']);
    router.execute(['echo', 'after']);
    await Promise.resolve();
    expect(printed).toEqual(['Dumped console text to mine.txt.\n']);
    held.finish(true);
    await router.settled();
    expect(printed.at(-1)).toBe('after\n');
  });

  it('refuses a name that could leave the folder before it dumps anything', async () => {
    const { router, files, printed } = setup();
    router.execute(['condump', '../up']);
    await router.settled();
    expect(files).toEqual({});
    expect(printed).toEqual([
      'WARNING: refusing to create relative path "../up.txt"\n',
      "ERROR: couldn't open ../up.txt.\n"
    ]);
  });

  it("says it couldn't open a file the home folder didn't take, once it has said it dumped it", async () => {
    const { router, printed } = setup(async () => false);
    router.execute(['condump', 'mine']);
    await router.settled();
    expect(printed).toEqual(['Dumped console text to mine.txt.\n', "ERROR: couldn't open mine.txt.\n"]);
  });
});

describe('lineEndFor', () => {
  it("ends a line CRLF on Windows, as ioquake3's build for it does, and LF elsewhere", () => {
    expect(lineEndFor('Win32')).toBe('\r\n');
    for (const platform of ['MacIntel', 'Linux x86_64', 'iPhone', '']) {
      expect(lineEndFor(platform), platform).toBe('\n');
    }
  });
});
