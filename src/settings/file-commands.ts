import type { ConsoleBuffer } from '../view/console-buffer';
import { type CommandTable, compareExtension, defaultExtension } from './command-router';
import { type HomeFolder, homePath } from './home-folder';

/**
 * The console's commands that write a file to the home folder, as ioquake3's write one to
 * `fs_homepath`: the console's text, and the config.
 */

/** Where a file is written, by its path below the home folder. */
export type FileWriter = Pick<HomeFolder, 'write'>;

/**
 * The file a line names, as `Con_Dump_f` and `Com_WriteConfig_f` take it: its one argument, with
 * `extension` added where it has none (`COM_DefaultExtension`). Any other count prints `usage`, and
 * a name that ends in anything else prints `refusal`.
 *
 * @returns The name, or `undefined` once it has printed why there is none.
 */
function fileArgument(
  argv: readonly string[],
  extension: string,
  usage: string,
  refusal: string,
  print: (text: string) => void
): string | undefined {
  if (argv.length !== 2) {
    print(usage);
    return undefined;
  }
  const name = defaultExtension(argv[1], extension);
  if (!compareExtension(name, extension)) {
    print(refusal);
    return undefined;
  }
  return name;
}

/**
 * The path below the home folder a name is written to, as `FS_OSPath_FOpenFileWrite` builds it
 * (`files.c:680–709`). One that holds `..` or `::` anywhere could leave the folder, so it is
 * refused with `FS_CreatePath`'s warning (`:551–553`), naming the path below the folder where Q3
 * names the whole of it.
 *
 * @returns The path, or `undefined` once the warning is printed.
 */
function writablePath(name: string, print: (text: string) => void): string | undefined {
  const path = homePath(name);
  if (path.includes('..') || path.includes('::')) {
    print(`WARNING: refusing to create relative path "${path}"\n`);
    return undefined;
  }
  return path;
}

/** What `writeconfig` needs. */
export interface WriteConfigOptions {
  /** The file, as `Com_WriteConfigToFile` writes it (`common.c:2927–2940`). */
  text(): string;
  /** The home folder. */
  home: FileWriter;
  print(text: string): void;
}

/**
 * `Com_WriteConfig_f` (`common.c:2987–3006`): the config to a `.cfg` in the home folder. What is
 * queued behind it waits for the write, so an `exec` of the file reads it, as Q3's write is done
 * before the next command runs.
 */
export function addWriteConfig(table: CommandTable, options: WriteConfigOptions): void {
  const { print } = options;
  table.add('writeconfig', (argv) => {
    const name = fileArgument(
      argv,
      '.cfg',
      'Usage: writeconfig <filename>\n',
      'Com_WriteConfig_f: Only the ".cfg" extension is supported by this command!\n',
      print
    );
    if (name === undefined) return;
    print(`Writing ${name}.\n`);
    const path = writablePath(name, print);
    if (path === undefined) {
      print(`Couldn't write ${name}.\n`);
      return;
    }
    return options.home.write(path, options.text()).then((written) => {
      if (!written) print(`Couldn't write ${name}.\n`);
    });
  });
}

/**
 * The end `condump` gives each line: CRLF where the page runs on Windows, as ioquake3's build for
 * it writes, and LF elsewhere (`cl_console.c:249–253`).
 *
 * @param platform - `navigator.platform`.
 */
export function lineEndFor(platform: string): string {
  return /^Win/.test(platform) ? '\r\n' : '\n';
}

/** What `condump` needs. */
export interface CondumpOptions {
  /** The console's text. */
  consoleText: Pick<ConsoleBuffer, 'dump'>;
  /** Where the text goes. */
  dumps: FileWriter;
  /** Each line's end ({@link lineEndFor}). */
  lineEnd: string;
  print(text: string): void;
}

/**
 * `Con_Dump_f` (`cl_console.c:183–259`): the console's text to a `.txt` in the home folder. The
 * line saying so is printed before the text is taken, so the file ends with it. Q3 opens the file
 * first, and prints only the error for one it can't; here the write can fail only after the text is
 * taken, so its error follows. What is queued behind waits for the write.
 */
export function addCondump(table: CommandTable, options: CondumpOptions): void {
  const { print } = options;
  table.add('condump', (argv) => {
    const name = fileArgument(
      argv,
      '.txt',
      'usage: condump <filename>\n',
      'Con_Dump_f: Only the ".txt" extension is supported by this command!\n',
      print
    );
    if (name === undefined) return;
    const path = writablePath(name, print);
    if (path === undefined) {
      print(`ERROR: couldn't open ${name}.\n`);
      return;
    }
    print(`Dumped console text to ${name}.\n`);
    return options.dumps.write(path, options.consoleText.dump(options.lineEnd)).then((written) => {
      if (!written) print(`ERROR: couldn't open ${name}.\n`);
    });
  });
}
