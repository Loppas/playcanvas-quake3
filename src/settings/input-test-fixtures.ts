import { ClientInput } from './client-input';
import { CommandRouter } from './command-router';
import { GameConfig } from './game-config';

/**
 * Input as the page wires it: a config's binds, the default ones or those given, each bound
 * command run through a console that has the settings' commands and the buttons, cgame's weapon
 * commands, and no server to forward to. `cgame` takes cgame's other commands; `printed` has what
 * the console printed.
 */
export function routedInput(
  binds?: Iterable<readonly [number, string]>,
  cgame: (argv: readonly string[]) => boolean = () => false
) {
  const config = new GameConfig({ debugMode: true, warn: () => {} });
  if (binds) {
    config.binds.clear();
    for (const [key, command] of binds) config.binds.set(key, command);
  }
  const printed: string[] = [];
  const router = new CommandRouter({
    cvar: (argv) => config.cvarCommand(argv),
    cgame: (argv) => input.cgameCommand(argv) || cgame(argv),
    game: () => false,
    forward: () => false,
    readCfg: () => Promise.resolve(undefined),
    print: (text) => void printed.push(text)
  });
  const input = new ClientInput(config.binds, {
    command: (argv) => router.execute(argv),
    warn: (message) => void printed.push(`${message}\n`)
  });
  config.addCommands(router);
  input.addCommands(router);
  return { input, config, router, printed };
}
