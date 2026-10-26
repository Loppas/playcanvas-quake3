import { colorRuns } from '../formats/color-codes';
import type { ConsoleBuffer } from './console-buffer';

/**
 * The console's buffer as everything but the print holds it: read, resized, scrolled and cleared.
 * Text goes in only through {@link consolePrint}, so `cl_noprint` and the devtools' echo hold for
 * every print.
 */
export type ConsoleText = Omit<ConsoleBuffer, 'print'>;

/**
 * `Com_Printf` (`common.c:166–228`), the page's: the text into the console's buffer, on the real
 * clock, unless `cl_noprint` keeps it out (`cl_console.c:462`), and to the browser's devtools
 * either way, its colours and its last newline taken out, as ioquake3 echoes every print to its
 * terminal (`Sys_Print`).
 *
 * @param noPrint - `cl_noprint`, read at each print.
 * @param echo - Where each print goes as well: the devtools.
 */
export function consolePrint(
  buffer: ConsoleBuffer,
  noPrint: () => boolean,
  echo: (line: string) => void = (line) => console.log(line)
): (text: string) => void {
  return (text) => {
    if (!noPrint()) buffer.print(text, performance.now());
    echo(
      colorRuns(text)
        .map((run) => run.text)
        .join('')
        .replace(/\n$/, '')
    );
  };
}
