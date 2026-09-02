import { Property, DynamicPropsValue } from '@activepieces/pieces-framework';
import type { ConnectorField, ConnectorInput, JobSchema } from './client';

/**
 * The dialect adapter: Rendobar's connector-field contract rendered as
 * Activepieces properties.
 *
 * Rendobar publishes a form description at `GET /jobs/types/{type}/schema`, so
 * a new job type appears here with no release of this piece. This file is the
 * only thing that knows Activepieces' property vocabulary.
 */

/** A string with no declared ceiling, or a generous one, wants a textarea. */
const LONG_TEXT_THRESHOLD = 120;

/**
 * `default` arrives as `unknown` because the contract carries defaults for
 * every field type. Each branch narrows it to what that property accepts
 * rather than casting: a string default on a Number property is a real
 * mistake, and the compiler should say so.
 */
const asString = (v: unknown) => (typeof v === 'string' ? v : undefined);
const asNumber = (v: unknown) => (typeof v === 'number' ? v : undefined);
const asBoolean = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const asObject = (v: unknown) =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;

function toProperty(field: ConnectorField) {
  const shared = {
    displayName: field.label,
    required: field.required,
    ...(field.description === undefined ? {} : { description: field.description }),
  };
  const withDefault = <T>(value: T | undefined) =>
    value === undefined ? {} : { defaultValue: value };

  switch (field.type) {
    case 'number':
      return Property.Number({ ...shared, ...withDefault(asNumber(field.default)) });
    case 'boolean':
      return Property.Checkbox({ ...shared, ...withDefault(asBoolean(field.default)) });
    case 'options':
      return Property.StaticDropdown({
        ...shared,
        ...withDefault(asString(field.default)),
        options: { options: (field.options ?? []).map((o) => ({ label: o.label, value: o.value })) },
      });
    case 'json':
      return Property.Json({ ...shared, ...withDefault(asObject(field.default)) });
    case 'string':
    default:
      return field.maxLength !== undefined && field.maxLength <= LONG_TEXT_THRESHOLD
        ? Property.ShortText({ ...shared, ...withDefault(asString(field.default)) })
        : Property.LongText({ ...shared, ...withDefault(asString(field.default)) });
  }
}

/**
 * Fields that apply given the chosen discriminator value.
 *
 * Activepieces has no per-field conditional visibility, so a gated field is
 * handled by not returning it. n8n solves the same problem with
 * `displayOptions.show`; here the property set is recomputed instead, which is
 * why the discriminator has to be a top-level property that `refreshers` can
 * name.
 */
export function visibleFields(fields: ConnectorField[], variant: string | undefined): ConnectorField[] {
  return fields.filter((f) => {
    if (f.showWhen === undefined) return true;
    return variant !== undefined && f.showWhen.equals.includes(variant);
  });
}

/**
 * Keyed by `key`, which is unique. Keying on `name` loses every gated variant.
 *
 * `discriminator` is the field NAME the schema nominates, not a guess. An
 * earlier version inferred it as "the first required options field with no
 * showWhen", which happened to be right for both job types that have one and
 * would have silently picked the wrong field for the first one that differed.
 */
export function buildProps(
  fields: ConnectorField[],
  variant: string | undefined,
  discriminator: string | undefined,
  jsonSchema?: unknown,
): DynamicPropsValue {
  // An empty field list is not always "this job type takes no parameters".
  // `compose` publishes a whole timeline document under `jsonSchema` that no
  // flat field list can express, so its projection is empty while the job very
  // much needs input. One JSON editor keeps it usable, where the
  // honest-looking empty form would submit {} and fail validation every time.
  //
  // The two cases are told apart the same way the n8n node tells them apart,
  // by asking whether the json schema describes any parameters at all. A job
  // type that genuinely takes none must not be given a required JSON box.
  if (fields.length === 0) {
    if (!describesParameters(jsonSchema)) return {};
    return {
      rawParams: Property.Json({
        displayName: 'Parameters (JSON)',
        description:
          'This job type takes a structured document rather than separate fields. See its page under https://rendobar.com/docs/jobs/ for the shape.',
        required: true,
        defaultValue: {},
      }),
    };
  }

  // A job type with a discriminator cannot show its real fields until one is
  // chosen, and `variant` cannot be marked required because it is meaningless
  // for the seven job types that have no discriminator. Saying so here costs
  // nothing: this callback already has the schema, and the form is the moment
  // the user can act on it.
  if (discriminator !== undefined && variant === undefined) {
    return {
      variantRequired: Property.MarkDown({
        value: `Choose a **Variant** above to see the settings for this job type.`,
      }),
    };
  }

  return Object.fromEntries(
    visibleFields(fields, variant)
      // The discriminator is already a top-level property, so it must not
      // appear a second time inside the dynamic set.
      .filter((f) => f.name !== discriminator)
      .map((f) => [f.key, toProperty(f)]),
  );
}

/**
 * Turn the form's keys back into the params the API expects.
 *
 * `key` is `name` or `name__<digest>`, and no param name contains `__`, both
 * guaranteed by Rendobar's contract tests. So the submit path is recoverable
 * here rather than costing a second request per run.
 */
export function paramsFromForm(form: DynamicPropsValue): Record<string, unknown> {
  // The raw-JSON fallback above carries the whole params object in one field,
  // so it is unwrapped rather than submitted under a `rawParams` key the API
  // has never heard of. Only ever the sole field, so nothing else is lost.
  const raw = asObject(form['rawParams']);
  if (raw !== undefined && Object.keys(form).length === 1) return raw;

  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(form)) {
    // An untouched optional text field comes back as '', not undefined, so
    // keeping it would submit an empty string for every field the user left
    // alone and fail validation on the first one that cares. Dropping it means
    // an empty string cannot be sent deliberately, which no job type wants.
    if (value === undefined || value === null || value === '') continue;
    params[/^(.+)__[0-9a-z]+$/.exec(key)?.[1] ?? key] = value;
  }
  return params;
}

/**
 * Whether a json schema describes any parameters at all.
 *
 * Mirrors the same check in the n8n node, deliberately: both connectors read
 * the same endpoint, and a job type that takes nothing must not be shown a
 * required JSON box while one that takes a document must not be shown an
 * empty form.
 */
function describesParameters(jsonSchema: unknown): boolean {
  const schema = asObject(jsonSchema);
  if (schema === undefined) return false;

  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const branch = schema[key];
    if (Array.isArray(branch) && branch.length > 0) return true;
  }

  const properties = schema['properties'];
  return (
    typeof properties === 'object' &&
    properties !== null &&
    Object.keys(properties).length > 0
  );
}


// ── Job INPUTS ──────────────────────────────────────────────────────────────

/**
 * The media a job reads, as form properties.
 *
 * Until the API published an inputs descriptor this was a raw JSON box in both
 * connectors, so a person had to know that compress.target wants a key called
 * `source` and type `{"source": "https://..."}` by hand. Now each input is its
 * own labelled field.
 *
 * A URL rather than a file picker on purpose. Activepieces resolves a
 * `Property.File` by downloading the whole thing into the engine's memory and
 * handing it over as a Buffer; for a multi-gigabyte video that is a memory
 * problem, and it is wasted work besides, because Rendobar fetches the URL
 * itself. The Upload File action covers the case where the bytes are only in
 * the flow, and its output is a URL to paste here.
 */
export function buildInputProps(inputs: JobSchema['inputs']): DynamicPropsValue {
  if (inputs === undefined) {
    // An API older than the inputs descriptor. The raw editor is the only
    // honest thing to show, since nothing here knows the key names.
    return { rawInputs: rawInputsProperty() };
  }

  if (inputs.variadic) {
    // ffmpeg and ffprobe name their inputs from the command itself, so there is
    // no fixed set to render.
    return {
      rawInputs: Property.Json({
        displayName: 'Input Files',
        description:
          'A map of filename to source, for example {"in.mp4": "https://example.com/clip.mp4"}. Each key becomes a file the command can refer to by that name.',
        required: false,
        defaultValue: {},
      }),
    };
  }

  if (inputs.fields.length === 0) return {};

  return Object.fromEntries(
    inputs.fields.map((input) => {
      const shared = {
        displayName: input.label,
        required: input.required,
        description: describeInput(input),
      };
      // A list of URLs, one per line, is the only multi-value control that
      // survives being filled in by an expression from an earlier step.
      return [
        INPUT_PREFIX + input.name,
        input.multiple
          ? Property.Array({ ...shared })
          : Property.ShortText({ ...shared }),
      ];
    }),
  );
}

function describeInput(input: ConnectorInput): string {
  const base = input.description ?? '';
  if (!input.url) return base;
  const hint =
    'A public URL, or the URL from an Upload File step. ' +
    (input.multiple ? 'Add one entry per file.' : '');
  return base ? `${base} ${hint}` : hint;
}

function rawInputsProperty() {
  return Property.Json({
    displayName: 'Input Media (JSON)',
    description:
      'The media this job reads, keyed by input name, for example {"source": "https://example.com/clip.mp4"}.',
    required: false,
    defaultValue: {},
  });
}

/**
 * Input properties share the form with the params properties, and a job type
 * is free to have a param and an input with the same name. The prefix keeps
 * them apart, and is stripped before the request is built.
 */
export const INPUT_PREFIX = 'input__';

/** Turn the input half of the form back into the API's `inputs` object. */
export function inputsFromForm(form: DynamicPropsValue): Record<string, unknown> {
  const raw = asObject(form['rawInputs']);
  if (raw !== undefined) return raw;

  const inputs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(form)) {
    if (!key.startsWith(INPUT_PREFIX)) continue;
    if (value === undefined || value === null || value === '') continue;
    // An untouched Array property comes back as [] rather than undefined, and
    // sending an empty list fails validation on a required input while looking
    // like the user filled it in.
    if (Array.isArray(value) && value.length === 0) continue;
    inputs[key.slice(INPUT_PREFIX.length)] = value;
  }
  return inputs;
}
