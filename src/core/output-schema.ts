// The output schemas of roles that answer with structured output (ADR 0107, D-228). A schema lives
// in the role's bot file (contracts/bots/, docs/bot-files.md). The task file hands it to the
// model, and the runner checks the answer against the same schema before it reads it.
//
// Only a small subset of JSON Schema is accepted, the part the runner can check exactly and the
// providers' structured outputs support: `type` (object, array, string, boolean, number,
// integer), `properties`, `required` and `additionalProperties: false` on objects, `items` on
// arrays, `enum` on strings, and `description` anywhere. Anything else is refused when the bot
// file is loaded, so no schema keyword is silently ignored. Problems name the field, never a value.

/** A schema in the accepted subset. Checked by `outputSchemaProblems` before use. */
export type OutputSchema = Record<string, unknown>;

const TYPES = ["object", "array", "string", "boolean", "number", "integer"] as const;
type SchemaType = (typeof TYPES)[number];

const KEYWORDS: Record<SchemaType, readonly string[]> = {
  object: ["type", "description", "properties", "required", "additionalProperties"],
  array: ["type", "description", "items"],
  string: ["type", "description", "enum"],
  boolean: ["type", "description"],
  number: ["type", "description"],
  integer: ["type", "description"],
};

/** Deep enough for the Council's answers; a deeper schema is refused. */
const MAX_DEPTH = 6;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every problem with a schema, each naming its path under `at`. Empty when it is usable. */
export function outputSchemaProblems(schema: unknown, at: string, depth = 0): string[] {
  if (!isObject(schema)) return [`${at} must be a mapping`];
  if (depth > MAX_DEPTH) return [`${at} is nested too deeply`];
  const type = schema.type as SchemaType;
  if (!TYPES.includes(type)) {
    return [`${at}.type must be object, array, string, boolean, number or integer`];
  }
  const problems: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS[type].includes(key)) {
      problems.push(`${at}: keyword ${key} is not supported on type ${type}`);
    }
  }
  if (schema.description !== undefined && typeof schema.description !== "string") {
    problems.push(`${at}.description must be text`);
  }
  if (type === "object") {
    if (schema.additionalProperties !== false) {
      problems.push(`${at}.additionalProperties must be false`);
    }
    const properties = schema.properties;
    if (!isObject(properties) || Object.keys(properties).length === 0) {
      problems.push(`${at}.properties must name at least one field`);
    } else {
      for (const [name, child] of Object.entries(properties)) {
        problems.push(
          ...outputSchemaProblems(child, `${at}.properties.${name}`, depth + 1),
        );
      }
      const required = schema.required;
      if (
        !Array.isArray(required) ||
        !required.every((r): r is string => typeof r === "string") ||
        new Set(required).size !== required.length ||
        !required.every((r) => Object.hasOwn(properties, r))
      ) {
        problems.push(`${at}.required must list distinct fields of its properties`);
      }
    }
  }
  if (type === "array") {
    problems.push(...outputSchemaProblems(schema.items, `${at}.items`, depth + 1));
  }
  if (type === "string" && schema.enum !== undefined) {
    const values = schema.enum;
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      !values.every((v) => typeof v === "string")
    ) {
      problems.push(`${at}.enum must be a non-empty list of text`);
    }
  }
  return problems;
}

/** The label of a field for a problem: `the answer `, `verdicts[0] `, `verdicts[0].note`. */
const child = (path: string, key: string): string =>
  path === "" ? key : `${path}.${key}`;
const prefix = (path: string): string => (path === "" ? "the answer " : `${path} `);

/**
 * The first way `value` does not fit `schema`, naming the field and never its value, or null when
 * it fits. `schema` must have passed `outputSchemaProblems`.
 */
export function outputProblem(
  schema: OutputSchema,
  value: unknown,
  path = "",
): string | null {
  const label = path === "" ? "the answer" : path;
  switch (schema.type as SchemaType) {
    case "object": {
      if (!isObject(value)) return `${label} is not an object`;
      const properties = schema.properties as Record<string, OutputSchema>;
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          return `${prefix(path)}has a field the schema does not allow`;
        }
      }
      for (const key of schema.required as string[]) {
        if (!Object.hasOwn(value, key)) return `${prefix(path)}${key} is missing`;
      }
      for (const [key, sub] of Object.entries(properties)) {
        if (!Object.hasOwn(value, key)) continue;
        const problem = outputProblem(sub, value[key], child(path, key));
        if (problem) return problem;
      }
      return null;
    }
    case "array": {
      if (!Array.isArray(value)) return `${label} must be a list`;
      for (const [i, item] of value.entries()) {
        const problem = outputProblem(
          schema.items as OutputSchema,
          item,
          `${label}[${i}]`,
        );
        if (problem) return problem;
      }
      return null;
    }
    case "string":
      if (typeof value !== "string") return `${label} must be text`;
      if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
        return `${label} must be one of the schema's values`;
      }
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : `${label} must be true or false`;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : `${label} must be a number`;
    case "integer":
      return Number.isSafeInteger(value) ? null : `${label} must be a whole number`;
    default:
      return `${label} has a schema of an unknown type`;
  }
}
