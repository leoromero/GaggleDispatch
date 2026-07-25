/**
 * The bundled command library.
 *
 * Compiled into the binary rather than written to disk so a freshly registered
 * repository gets the full review phase with no setup. A repo overrides any of
 * these by creating `.gaggle/commands/<name>.md`.
 *
 * Populated in phase 7. Kept as its own module so `commands.ts` stays about
 * resolution and this stays about content.
 */

export const BUNDLED_COMMANDS: Record<string, string> = {};
