/**
 * EXIT GAME, once confirmed (`ui_ingame.c:126–127`): `quit`, whose `Com_Quit_f` shuts the game
 * down before the program goes (`common.c:376–392`). The shell's window closes, and the app quits
 * with it. A browser lets a script close only some tabs, such as one a script opened, so a tab it
 * keeps open stops the game and says it can be closed.
 */

/** How long a closing window is given before the page takes it as kept open. */
export const EXIT_WAIT_MS = 500;

/** The browser's parts, which a test stands in for. */
export interface ExitOptions {
  /** `window.close`. */
  close?: () => void;
  /** `setTimeout`. */
  later?: (then: () => void, ms: number) => void;
}

/**
 * Quit the game, then close the window, or where it stays open, stop the game and say so.
 *
 * @param host - What the screen that says so covers: the page's root.
 * @param quit - Shuts the game down: its server's clients are told, or its server is left.
 * @param stop - Stops the game.
 */
export function exitGame(
  host: HTMLElement,
  quit: () => void,
  stop: () => void,
  options: ExitOptions = {}
): void {
  const { close = () => window.close(), later = (then, ms) => void setTimeout(then, ms) } = options;
  cleanly('quit', quit);
  close();
  later(() => {
    cleanly('stop', stop);
    const screen = document.createElement('div');
    screen.className = 'end-screen';
    screen.innerHTML = `
      <div class="end-panel">
        <h1 class="end-title">EXIT GAME</h1>
        <p class="end-text">The game has stopped. You can close this tab.</p>
      </div>
    `;
    host.appendChild(screen);
  }, EXIT_WAIT_MS);
}

/** One step of the way out, which goes on whether the step throws or not. */
function cleanly(step: string, run: () => void): void {
  try {
    run();
  } catch (err) {
    console.warn(`The game did not ${step} cleanly:`, err);
  }
}
