import { parseCollectsPersonalDataEnv } from "../../.github/scripts/bootstrap-plan.mjs";

// Bootstrap reads the same variable in its protected decide step (D-358 lock 1, O-113), so the
// parser lives there and init-project uses it from there.
export { parseCollectsPersonalDataEnv };

export const NON_INTERACTIVE_COLLECTS_PERSONAL_DATA_MESSAGE =
  "Personal data collection must be specified non-interactively: use --personal-data or --no-personal-data, or set LAUNCHPAD_COLLECTS_PERSONAL_DATA.";

/**
 * Resolve whether init-project should run @didi-build/nodrift init.
 *
 * @param {{
 *   argv: string[];
 *   env: NodeJS.ProcessEnv;
 *   isInteractive?: boolean;
 *   ask?: () => Promise<boolean>;
 * }} input
 * @returns {Promise<{ collects: boolean; argv: string[] }>}
 */
export async function resolveCollectsPersonalData({
  argv,
  env,
  isInteractive = false,
  ask,
}) {
  const { flags, positional } = parsePersonalDataFlags(argv);
  if (flags.conflict) {
    throw new Error("Use only one of --personal-data and --no-personal-data.");
  }
  if (flags.collects !== undefined) {
    return { collects: flags.collects, argv: positional };
  }

  const fromEnv = parseCollectsPersonalDataEnv(env.LAUNCHPAD_COLLECTS_PERSONAL_DATA);
  if (fromEnv !== undefined) {
    return { collects: fromEnv, argv: positional };
  }

  if (isInteractive && ask) {
    const collects = await ask();
    return { collects, argv: positional };
  }

  throw new Error(NON_INTERACTIVE_COLLECTS_PERSONAL_DATA_MESSAGE);
}

/**
 * @param {string[]} argv
 * @returns {{ flags: { collects?: boolean; conflict?: boolean }; positional: string[] }}
 */
export function parsePersonalDataFlags(argv) {
  let collects;
  let sawPersonal = false;
  let sawNoPersonal = false;
  const positional = [];

  for (const arg of argv) {
    if (arg === "--personal-data") {
      sawPersonal = true;
      collects = true;
      continue;
    }
    if (arg === "--no-personal-data") {
      sawNoPersonal = true;
      collects = false;
      continue;
    }
    positional.push(arg);
  }

  return {
    flags: {
      collects: sawPersonal || sawNoPersonal ? collects : undefined,
      conflict: sawPersonal && sawNoPersonal,
    },
    positional,
  };
}

/**
 * @param {string} answer
 * @returns {boolean}
 */
export function parseInteractivePersonalDataAnswer(answer) {
  const value = String(answer).trim().toLowerCase();
  if (value === "" || value === "y" || value === "yes") {
    return true;
  }
  if (value === "n" || value === "no") {
    return false;
  }
  throw new Error('Answer with "y" or "n" (default is yes).');
}
