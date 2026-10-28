/**
 * Find which texts contain any of the given secret values (ADR 0110).
 * Returns names only. Callers must never print the values themselves.
 * @param {{ name: string, text: string }[]} texts files or outputs to scan
 * @param {Record<string, string>} secrets secret name to value
 * @returns {{ text: string, secret: string }[]}
 */
export function findSecretValues(texts, secrets) {
  const usable = Object.entries(secrets).filter(([, value]) => value.length >= 8);
  const hits = [];
  for (const { name, text } of texts) {
    for (const [secret, value] of usable) {
      if (text.includes(value)) hits.push({ text: name, secret });
    }
  }
  return hits;
}

/**
 * Secret values named by environment variables. A variable that is missing or too short
 * to scan for safely is reported, so a scan can never pass by checking nothing.
 * @param {string[]} names
 * @param {NodeJS.ProcessEnv} env
 */
export function secretsFromEnv(names, env) {
  const secrets = {};
  const problems = [];
  for (const name of names) {
    const value = env[name];
    if (!value) problems.push(`${name} is not set`);
    else if (value.length < 8) problems.push(`${name} is shorter than 8 characters`);
    else secrets[name] = value;
  }
  return { secrets, problems };
}
