/** npm args for Bootstrap nodrift install (no lifecycle scripts). */
export const BOOTSTRAP_NPM_CI_ARGS = ["ci", "--ignore-scripts"];

/**
 * Git argv for `git push` (no credentials in argv).
 *
 * @param {string} repository `owner/name`
 * @returns {string[]}
 */
export function gitPushArgs(repository) {
  return ["push", `https://github.com/${repository}.git`, "HEAD"];
}

/**
 * Process env for one `git push` using basic x-access-token auth via GIT_CONFIG_* (token not in argv or on disk).
 *
 * @param {string} token
 * @returns {NodeJS.ProcessEnv}
 */
export function gitPushAuthProcessEnv(token) {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}
