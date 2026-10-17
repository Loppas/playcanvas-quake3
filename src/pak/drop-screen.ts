/**
 * The pak drop screen.
 *
 * In a production build this is where the game data comes from the first time: no Q3 data ships
 * with the game, so the player points at their own. It is also where a visitor first meets the
 * terms: whose the game is, the licence, and the source. Where the browser has a folder picker, the
 * player can pick the install folder and play from it where it sits; otherwise, or from a folder
 * the browser won't open, they drop `pak0.pk3` and its point releases. Locally the dev server's
 * `baseq3` mount satisfies the boot first and this never appears.
 *
 * DOM only — no PlayCanvas — so it runs under jsdom in tests.
 */

/** A mounted drop screen; call {@link PakDropScreen.destroy} once files have been taken. */
export interface PakDropScreen {
  /** The overlay element, for tests and for callers that want to reposition it. */
  element: HTMLElement;
  /** Replace the prompt text, e.g. to report that a dropped file was not a pk3. */
  setMessage(message: string): void;
  /** Remove the overlay and detach its listeners. */
  destroy(): void;
}

/** What the drop screen offers besides dropped files. */
export interface PakDropOptions {
  /** Pick the install folder: offered where the browser has a folder picker. */
  onPickFolder?: () => void;
  /** A kept install folder to offer again, by name, whose permission wants the player's click. */
  keptFolder?: { name: string; onUse: () => void };
}

/**
 * The links under the terms: the source the build was made from, and the notices it publishes
 * beside the page, each in a tab of its own so the screen stays as it is.
 */
function termsLinks(): string {
  const link = (href: string, text: string) =>
    `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
  const notices = __PRODUCT_NOTICES__.map((name) => link(import.meta.env.BASE_URL + name, name));
  return [link(__PRODUCT_SOURCE__, 'the source'), ...notices].join(', ');
}

/**
 * Render the drop screen and call `onFiles` each time the user supplies files, by drag-drop
 * or through the file picker. The caller decides whether the files were usable and either
 * destroys the screen or leaves it up with a new message.
 */
export function createPakDropScreen(
  host: HTMLElement,
  onFiles: (files: File[]) => void,
  options: PakDropOptions = {}
): PakDropScreen {
  const overlay = document.createElement('div');
  overlay.className = 'pak-drop';
  const prompt = options.onPickFolder
    ? 'Choose your Quake 3 folder, the one that holds <code>baseq3</code>, to play from it where it is. Or drop <code>pak0.pk3</code> here.'
    : 'Drop <code>pak0.pk3</code> here, or choose it below.';
  const folderNote = options.onPickFolder
    ? `<p class="pak-drop-note">
        A folder is read where it is. Your browser won't open some, such as
        <code>Program Files</code>: drop the paks from one of those instead.
      </p>`
    : '';
  overlay.innerHTML = `
    <div class="pak-drop-panel">
      <h1>Quake 3 assets required</h1>
      <p class="pak-drop-message">${prompt}</p>
      <div class="pak-drop-actions">
        <label class="pak-drop-button">
          Choose pk3 files
          <input type="file" accept=".pk3" multiple hidden />
        </label>
      </div>
      ${folderNote}
      <p class="pak-drop-note">
        Files stay in your browser — nothing is uploaded, and no Quake assets ship with this
        game. Any point-release paks you add (<code>pak1</code>&hellip;<code>pak8</code>)
        override earlier ones, as Quake 3 does.
      </p>
      <p class="pak-drop-note pak-drop-terms">
        A fan project, not affiliated with or endorsed by id Software, ZeniMax Media, Bethesda,
        Microsoft, PlayCanvas or Snap. Quake and Quake III Arena are trademarks of id Software
        LLC. To play, you need your own copy of Quake III Arena.
      </p>
      <p class="pak-drop-note pak-drop-terms">
        Free software under the GNU GPL, version 2 or later: ${termsLinks()}.
      </p>
    </div>
  `;
  host.appendChild(overlay);

  const message = overlay.querySelector<HTMLElement>('.pak-drop-message')!;
  const actions = overlay.querySelector<HTMLElement>('.pak-drop-actions')!;
  const input = overlay.querySelector<HTMLInputElement>('input[type=file]')!;

  // The folder's buttons come before the file picker, a kept folder first. A folder's name is
  // the player's, so it goes in as text.
  const buttons: [HTMLButtonElement, () => void][] = [];
  const button = (className: string, label: string, onClick: () => void) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = `pak-drop-button ${className}`;
    element.textContent = label;
    element.addEventListener('click', onClick);
    buttons.push([element, onClick]);
    return element;
  };
  const offered: HTMLButtonElement[] = [];
  if (options.keptFolder) {
    const { name, onUse } = options.keptFolder;
    offered.push(button('pak-drop-kept', `Use ${name}`, onUse));
  }
  if (options.onPickFolder) {
    offered.push(button('pak-drop-folder', 'Choose your Quake 3 folder', options.onPickFolder));
  }
  actions.prepend(...offered);

  const onInputChange = () => {
    if (input.files) onFiles([...input.files]);
  };

  // Both dragover and dragenter must be prevented, or the browser navigates to the file.
  const onDragOver = (event: DragEvent) => {
    event.preventDefault();
    overlay.classList.add('pak-drop-active');
  };
  const onDragLeave = () => overlay.classList.remove('pak-drop-active');
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    overlay.classList.remove('pak-drop-active');
    onFiles([...(event.dataTransfer?.files ?? [])]);
  };

  input.addEventListener('change', onInputChange);
  overlay.addEventListener('dragenter', onDragOver);
  overlay.addEventListener('dragover', onDragOver);
  overlay.addEventListener('dragleave', onDragLeave);
  overlay.addEventListener('drop', onDrop);

  return {
    element: overlay,
    setMessage(text: string) {
      message.textContent = text;
    },
    destroy() {
      input.removeEventListener('change', onInputChange);
      overlay.removeEventListener('dragenter', onDragOver);
      overlay.removeEventListener('dragover', onDragOver);
      overlay.removeEventListener('dragleave', onDragLeave);
      overlay.removeEventListener('drop', onDrop);
      for (const [element, onClick] of buttons) element.removeEventListener('click', onClick);
      overlay.remove();
    }
  };
}
