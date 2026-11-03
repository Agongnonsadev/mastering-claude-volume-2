// Structured outputs (chapter 7): a Zod schema, translated into a JSON schema that the API imposes on Claude.
//
// The API accepts only part of JSON Schema. Like transform_schema() of the Python SDK, we keep what it
// imposes (types, enum, closed objects, known text formats) and copy the rest into the field's
// description (“{minimum: 1}”): Claude reads it, and the Zod validation checks it afterwards.
//
// The TypeScript SDK has its equivalent, zodOutputFormat(). But in its version 1.1.0, it does not keep
// enum: it too sends it back into the description, and the API would no longer impose it (observed on
// October 22, 2026, compared with Python SDK 2.1.0). Hence this translation of the Python function.

import { z } from "zod";

type Schema = Record<string, unknown>;

const TEXT_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);

/** The bounds Zod adds to any integer (JavaScript's “safe” integers): nothing to tell Claude. */
const ZOD_BOUNDS = new Set([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]);

/** Translation of transform_schema() of the Python SDK: what the API imposes, and the rest in the description. */
export function transformSchema(schema: Schema): Schema {
  // Zod writes a nullable field { type: ["string", "null"] }; Pydantic, and the API's documentation, an
  // anyOf. It is rewritten as an anyOf, the description staying on the field.
  if (Array.isArray(schema.type)) {
    const { type, description, title, ...own } = schema;
    const variants = (type as string[]).map((t) => (t === "null" ? { type: t } : { ...own, type: t }));
    return transformSchema({ anyOf: variants, ...(description !== undefined && { description }), ...(title !== undefined && { title }) });
  }
  const rest: Schema = { ...schema };
  const strict: Schema = {};
  const take = (key: string): unknown => {
    const value = rest[key];
    delete rest[key];
    return value;
  };
  delete rest.$schema; // the header Zod adds; Pydantic does not put it

  const defs = take("$defs") as Record<string, Schema> | undefined;
  if (defs) strict.$defs = Object.fromEntries(Object.entries(defs).map(([name, d]) => [name, transformSchema(d)]));
  const ref = take("$ref");
  if (ref !== undefined) return { ...strict, $ref: ref };

  const type = take("type");
  const [anyOf, oneOf, allOf] = [take("anyOf"), take("oneOf"), take("allOf")];
  if (Array.isArray(anyOf)) strict.anyOf = anyOf.map(transformSchema);
  else if (Array.isArray(oneOf)) strict.anyOf = oneOf.map(transformSchema);
  else if (Array.isArray(allOf)) strict.allOf = allOf.map(transformSchema);
  else if (type === undefined) throw new Error("A schema must have a type, or anyOf, oneOf, allOf.");
  else strict.type = type;

  const values = take("enum");
  if (Array.isArray(values)) strict.enum = values;
  const description = take("description");
  if (description !== undefined) strict.description = description;
  const title = take("title");
  if (title !== undefined) strict.title = title;

  if (type === "object") {
    const properties = (take("properties") ?? {}) as Record<string, Schema>;
    strict.properties = Object.fromEntries(Object.entries(properties).map(([key, p]) => [key, transformSchema(p)]));
    take("additionalProperties");
    strict.additionalProperties = false;
    const required = take("required");
    if (required !== undefined) strict.required = required;
  } else if (type === "string") {
    const format = take("format");
    if (typeof format === "string" && TEXT_FORMATS.has(format)) strict.format = format;
    else if (format !== undefined) rest.format = format;
  } else if (type === "array") {
    const items = take("items") as Schema | undefined;
    if (items !== undefined) strict.items = transformSchema(items);
    const minimum = take("minItems");
    if (minimum === 0 || minimum === 1) strict.minItems = minimum;
    else if (minimum !== undefined) rest.minItems = minimum;
  } else if (type === "integer" || type === "number") {
    for (const bound of ["minimum", "maximum"]) if (ZOD_BOUNDS.has(rest[bound] as number)) delete rest[bound];
  }

  // What remains is not imposed by the API: in the description, Claude is likely to follow it.
  if (Object.keys(rest).length) {
    const previous = strict.description;
    strict.description =
      (previous !== undefined ? `${previous}\n\n` : "") +
      `{${Object.entries(rest).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(", ")}}`;
  }
  return strict;
}

/** The format of a structured output (output_config.format), from a Zod schema. */
export function jsonFormat(schema: z.ZodType): { type: "json_schema"; schema: Schema } {
  return { type: "json_schema", schema: transformSchema(z.toJSONSchema(schema) as Schema) };
}
