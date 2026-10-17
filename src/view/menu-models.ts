import { K } from '../formats/q3-keys';
import { playerModelDir, type PlayerModelSkin } from '../formats/asset-manifest';
import type { GameConfig } from '../settings/game-config';
import type { Menu, MenuItem, MenuPage, MenuSound } from './menu';
import { playerLook, readModel } from './player-model';

/** `PLAYERGRID_COLS` and `MAX_MODELSPERPAGE` (`ui_playermodel.c:53–55`). */
export const GRID_COLUMNS = 4;
export const MODELS_PER_PAGE = 16;

/** The Model page, and the way into it. */
export interface ModelPage {
  page: MenuPage;
  /** Open it at the model `model` wears, as `PlayerModel_SetMenuItems` finds it (`ui_playermodel.c:457–513`). */
  open(): void;
}

const isLeft = (key: number) => key === K.LEFTARROW || key === K.KP_LEFTARROW;
const isRight = (key: number) => key === K.RIGHTARROW || key === K.KP_RIGHTARROW;

/** A model and skin as the page writes them: `model/skin`. */
const modelSkin = ({ model, skin }: PlayerModelSkin) => `${model}/${skin}`;

/**
 * Player model: q3_ui's page (`ui_playermodel.c`). A grid of every model and
 * skin's icon, sixteen to a page and four across, turned by the page's arrows, with the pick shown
 * beside it and named under it.
 * - It opens at the model `model` wears, in the skin "default" if it names none.
 * - Picking an icon shows its model in the preview.
 * - Left and right step through the icons, turning the page at its ends, and buzz at the first and
 *   the last (`PlayerModel_MenuKey`, `ui_playermodel.c:241–302`). Up and down step as Q3's do, one
 *   icon at a time.
 * - Leaving writes the pick to all four of `model`, `headmodel`, `team_model` and
 *   `team_headmodel`, as `PlayerModel_SaveChanges` does (`ui_playermodel.c:193–199`). The page
 *   sets one look and q3_ui gives it to both games; a player who wants a different one for team
 *   play sets the two cvars by hand, as they do in Quake 3.
 *
 * @param models - The models and skins the paks offer, read when the page opens, since the
 *   assets come after the menu.
 */
export function modelPage(menu: Menu, config: GameConfig, models: () => readonly PlayerModelSkin[]): ModelPage {
  const state = {
    list: [] as readonly PlayerModelSkin[],
    page: 0,
    /** The pick, by its place in the list; −1 for a model the list lacks. */
    selected: -1,
    /** `modelskin`: what leaving writes. */
    modelSkin: ''
  };
  const at = (cell: number) => state.page * MODELS_PER_PAGE + cell;
  const pages = () => Math.ceil(state.list.length / MODELS_PER_PAGE);
  const save = () => {
    config.cvars.set('model', state.modelSkin);
    config.cvars.set('headmodel', state.modelSkin);
    config.cvars.set('team_model', state.modelSkin);
    config.cvars.set('team_headmodel', state.modelSkin);
  };

  const cells: MenuItem[] = Array.from({ length: MODELS_PER_PAGE }, (_, cell) => ({
    cell: true,
    get label() {
      return state.list[at(cell)]?.model ?? '';
    },
    get icon() {
      const entry = state.list[at(cell)];
      return entry && `${playerModelDir(entry.model)}icon_${entry.skin}`;
    },
    // A slot past the last model is dead (`PlayerModel_UpdateGrid`, `ui_playermodel.c:126–131`).
    get hidden() {
      return at(cell) >= state.list.length;
    },
    get selected() {
      return at(cell) === state.selected;
    },
    get status() {
      const entry = state.list[at(cell)];
      return entry && `${entry.model} / ${entry.skin}`;
    },
    // `PlayerModel_PicEvent` (`ui_playermodel.c:309–362`).
    activate: () => {
      const entry = state.list[at(cell)];
      if (!entry) return;
      state.selected = at(cell);
      state.modelSkin = modelSkin(entry);
    }
  }));

  // The arrows turn the page, and do nothing at its ends (`PlayerModel_MenuEvent`, `ui_playermodel.c:213–227`).
  const previous: MenuItem = {
    label: 'PREVIOUS PAGE',
    role: 'previous',
    get hidden() {
      return state.page === 0;
    },
    activate: () => {
      if (state.page > 0) state.page--;
    }
  };
  const next: MenuItem = {
    label: 'NEXT PAGE',
    role: 'next',
    get hidden() {
      return state.page >= pages() - 1;
    },
    activate: () => {
      if (state.page < pages() - 1) state.page++;
    }
  };
  const back: MenuItem = {
    label: 'BACK',
    role: 'back',
    activate: () => {
      save();
      menu.pop();
    }
  };

  const page: MenuPage = {
    id: 'model',
    title: 'PLAYER MODEL',
    layout: 'grid',
    items: [...cells, previous, next, back],
    preview: () => playerLook(state.modelSkin, state.modelSkin),
    // The pick's model and skin, in capitals, as the page names them (`ui_playermodel.c:346–354`).
    get caption() {
      return state.modelSkin.toUpperCase().replace('/', ' / ');
    },
    key: (key): number | MenuSound => {
      if (key === K.ESCAPE || key === K.MOUSE2) {
        save();
        return key;
      }
      const cell = menu.cursor;
      if (cell < 0 || cell >= MODELS_PER_PAGE || (!isLeft(key) && !isRight(key))) return key;
      if (isLeft(key)) {
        if (cell > 0) menu.select(cell - 1);
        else if (state.page > 0) {
          state.page--;
          menu.select(cell + MODELS_PER_PAGE - 1);
        } else return 'buzz';
        return 'move';
      }
      if (cell < MODELS_PER_PAGE - 1 && at(cell) + 1 < state.list.length) menu.select(cell + 1);
      else if (cell === MODELS_PER_PAGE - 1 && state.page < pages() - 1) {
        state.page++;
        menu.select(cell - (MODELS_PER_PAGE - 1));
      } else return 'buzz';
      return 'move';
    }
  };

  return {
    page,
    open: () => {
      state.list = models();
      const current = readModel(config.cvars.settings.model);
      state.modelSkin = modelSkin(current);
      // Found without regard to case, as `Q_stricmp` finds it.
      const wanted = state.modelSkin.toLowerCase();
      state.selected = state.list.findIndex((entry) => modelSkin(entry).toLowerCase() === wanted);
      state.page = state.selected < 0 ? 0 : Math.floor(state.selected / MODELS_PER_PAGE);
      menu.push(page);
    }
  };
}
