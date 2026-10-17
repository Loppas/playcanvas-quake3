import { configCommands } from '../formats/q3config';
import { PRESET_DIR, shippedCfg } from '../settings/presets';
import { RuleCvars, type Rules } from './rules';

/** The rules a shipped preset sets, read as the game reads them. */
export function presetRules(name: string): Rules {
  const values = new Map<string, string>();
  for (const [, cvar, ...value] of configCommands(shippedCfg(`${PRESET_DIR}/${name}.cfg`)!)) {
    values.set(cvar.toLowerCase(), value.join(' '));
  }
  const reader = new RuleCvars({
    get: (cvar) => values.get(cvar.toLowerCase()) ?? '',
    set: () => {},
    setServer: () => false,
    modificationCount: () => 0,
    totalModifications: () => 0
  });
  reader.update();
  return reader.rules;
}
