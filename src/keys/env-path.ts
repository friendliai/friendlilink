import { join } from "node:path";

/**
 * The hermes home directory: `$HERMES_HOME` when hermes itself will use one
 * (profiles, sandboxes, desktop gateways set it; hermes' own get_hermes_home()
 * resolves env override → platform default), else `~/.hermes` under `home`.
 *
 * frlink must write to the same home hermes READS from — resolve the
 * same way or an HERMES_HOME-scoped hermes never sees the key/config we wrote
 * (and the user's real ~/.hermes gets mutated from inside a sandbox).
 */
export function hermesHome(home: string): string {
  return process.env.HERMES_HOME?.trim() || join(home, ".hermes");
}

/** Hermes' dotenv file — the plugin reads FRIENDLIAI_API_KEY from here. */
export function getDotenvPath(home: string): string {
  return join(hermesHome(home), ".env");
}
