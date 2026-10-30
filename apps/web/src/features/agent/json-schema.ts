import { z } from 'zod';

/**
 * zod → JSON Schema, for advertising tool inputs over MCP (D-109).
 *
 * Covers the subset the API contracts use. The schema is only a description
 * for the model: the zod schema itself is what parses every call, so anything
 * this renders loosely is still enforced exactly.
 */
export type JsonSchema = Record<string, unknown>;

export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const described = (json: JsonSchema): JsonSchema =>
    schema.description ? { ...json, description: schema.description } : json;

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = toJsonSchema(value);
      if (!value.isOptional()) required.push(key);
    }
    return described({
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    });
  }

  if (schema instanceof z.ZodString) {
    const json: JsonSchema = { type: 'string' };
    for (const check of schema._def.checks) {
      if (check.kind === 'min') json.minLength = check.value;
      if (check.kind === 'max') json.maxLength = check.value;
      if (check.kind === 'uuid') json.format = 'uuid';
      if (check.kind === 'datetime') json.format = 'date-time';
      if (check.kind === 'url') json.format = 'uri';
      if (check.kind === 'email') json.format = 'email';
      if (check.kind === 'regex') json.pattern = check.regex.source;
    }
    return described(json);
  }

  if (schema instanceof z.ZodNumber) {
    const json: JsonSchema = { type: 'number' };
    for (const check of schema._def.checks) {
      if (check.kind === 'int') json.type = 'integer';
      if (check.kind === 'min') json.minimum = check.value;
      if (check.kind === 'max') json.maximum = check.value;
    }
    return described(json);
  }

  if (schema instanceof z.ZodBoolean) return described({ type: 'boolean' });
  if (schema instanceof z.ZodDate) return described({ type: 'string', format: 'date-time' });
  if (schema instanceof z.ZodEnum) return described({ type: 'string', enum: [...schema.options] });
  if (schema instanceof z.ZodNativeEnum) {
    return described({ enum: Object.values(schema.enum as Record<string, unknown>) });
  }
  if (schema instanceof z.ZodLiteral) return described({ const: schema.value });

  if (schema instanceof z.ZodArray) {
    const json: JsonSchema = { type: 'array', items: toJsonSchema(schema.element) };
    if (schema._def.minLength) json.minItems = schema._def.minLength.value;
    if (schema._def.maxLength) json.maxItems = schema._def.maxLength.value;
    return described(json);
  }

  if (schema instanceof z.ZodUnion) {
    return described({ anyOf: (schema.options as z.ZodTypeAny[]).map(toJsonSchema) });
  }
  if (schema instanceof z.ZodRecord) {
    return described({ type: 'object', additionalProperties: toJsonSchema(schema.valueSchema) });
  }

  if (schema instanceof z.ZodOptional) return described(toJsonSchema(schema.unwrap()));
  if (schema instanceof z.ZodNullable) {
    return described({ anyOf: [toJsonSchema(schema.unwrap()), { type: 'null' }] });
  }
  if (schema instanceof z.ZodDefault) {
    return described({
      ...toJsonSchema(schema.removeDefault()),
      default: schema._def.defaultValue(),
    });
  }
  if (schema instanceof z.ZodEffects) return described(toJsonSchema(schema.innerType()));

  return described({});
}
