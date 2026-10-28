/** Shortest secret worth scanning for. Shorter values would match ordinary text. */
export const MIN_SECRET_LENGTH = 8;

/**
 * Base64 text that appears whenever `value` is encoded inside any longer byte string, for each of
 * the three ways it can line up with base64's 3-byte groups. The edges that mix with neighbouring
 * bytes are cut off.
 * @param {Buffer} value
 * @param {"base64" | "base64url"} encoding
 */
function base64Cores(value, encoding) {
  const cores = [];
  for (let offset = 0; offset < 3; offset++) {
    const encoded = Buffer.concat([Buffer.alloc(offset), value])
      .toString(encoding)
      .replace(/=+$/, "");
    const start = offset === 0 ? 0 : 4;
    const end = (offset + value.length) % 3 === 0 ? encoded.length : encoded.length - 4;
    const core = encoded.slice(start, Math.max(start, end));
    if (core.length >= MIN_SECRET_LENGTH) cores.push(core);
  }
  return cores;
}

/**
 * The forms a secret can take in plan output, state or logs: as is, JSON-escaped, URL-encoded,
 * and base64 or base64url encoded.
 * @param {string} value
 * @returns {{ form: string, text: string }[]}
 */
export function secretForms(value) {
  const bytes = Buffer.from(value, "utf8");
  const forms = [
    { form: "plain", text: value },
    { form: "json-escaped", text: JSON.stringify(value).slice(1, -1) },
    { form: "url-encoded", text: encodeURIComponent(value) },
    ...base64Cores(bytes, "base64").map((text) => ({ form: "base64", text })),
    ...base64Cores(bytes, "base64url").map((text) => ({ form: "base64url", text })),
  ];
  const seen = new Set();
  return forms.filter(
    ({ text }) => text.length >= MIN_SECRET_LENGTH && !seen.has(text) && seen.add(text),
  );
}

/**
 * Find which texts contain any form of the given secret values (ADR 0110).
 * Returns names and forms only. Callers must never print the values themselves.
 * @param {{ name: string, text: string }[]} texts files or outputs to scan
 * @param {Record<string, string>} secrets secret name to value
 * @returns {{ text: string, secret: string, form: string }[]}
 */
export function findSecretValues(texts, secrets) {
  const hits = [];
  for (const [secret, value] of Object.entries(secrets)) {
    if (value.length < MIN_SECRET_LENGTH) continue;
    const forms = secretForms(value);
    for (const { name, text } of texts) {
      const found = forms.find((form) => text.includes(form.text));
      if (found) hits.push({ text: name, secret, form: found.form });
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
    else if (value.length < MIN_SECRET_LENGTH)
      problems.push(`${name} is shorter than ${MIN_SECRET_LENGTH} characters`);
    else secrets[name] = value;
  }
  return { secrets, problems };
}
