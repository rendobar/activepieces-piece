import {
  createAction,
  Property,
  DynamicPropsValue,
  ExecutionType,
} from '@activepieces/pieces-framework';
import { HttpMethod } from '@activepieces/pieces-common';
import { rendobarAuth } from '../auth';
import { rendobar, submitJob, JobTypeSummary, JobSchema } from '../common/client';
import { fingerprint, isPubliclyReachable, callbackStillComing } from '../common/pure';
import { buildProps, paramsFromForm, buildInputProps, inputsFromForm } from '../common/fields';
import { toJobRow, waitForJob, attachOutputFile, getJobById, JOB_OUTPUT_SCHEMA } from '../common/job';
import { jobIdFromEnvelope, raiseIfJobFailed } from '../common/pure';

const schemaFor = (token: string, type: string) =>
  rendobar<{ data: JobSchema }>(token, HttpMethod.GET, `/jobs/types/${encodeURIComponent(type)}/schema`);

export const createJob = createAction({
  auth: rendobarAuth,
  name: 'create_job',
  classification: 'WRITE',
  displayName: 'Run a Media Job',
  description: 'Submit a media processing job and wait for the finished file.',
  audience: 'both',
  aiMetadata: {
    description:
      'Run one media or AI job on Rendobar (transcode, compress, watermark, caption, probe, generate) and return the finished file URL. Pick the job type first, then fill the parameters it declares. Waiting pauses the flow until Rendobar calls back, so a job that runs for hours is fine. Each distinct call submits a new billable job; a retry of the same call settles on the job it already created rather than paying twice.',
    idempotent: true,
  },
  outputSchema: JOB_OUTPUT_SCHEMA,

  props: {
    jobType: Property.Dropdown({
      displayName: 'Job Type',
      description: 'What to do with the media. The parameters below change to match.',
      required: true,
      // Every dropdown whose callback reads auth MUST declare it, or auth
      // arrives undefined and the options never load.
      auth: rendobarAuth,
      refreshers: [],
      options: async ({ auth }) => {
        if (!auth) {
          return { disabled: true, options: [], placeholder: 'Please connect your account first' };
        }
        try {
          const { data } = await rendobar<{ data: JobTypeSummary[] }>(
            auth.secret_text,
            HttpMethod.GET,
            '/jobs/types',
          );
          return {
            disabled: false,
            options: data.map((t) => ({ label: `${t.type} — ${t.summary}`, value: t.type })),
          };
        } catch {
          return { disabled: true, options: [], placeholder: 'Failed to load job types. Check your connection.' };
        }
      },
    }),

    /**
     * The discriminator, when the chosen job type has one.
     *
     * It has to be a top-level property rather than part of the dynamic set,
     * because `refreshers` can only name top-level properties, and the field
     * list below depends on this value. Job types with no discriminator get a
     * disabled dropdown saying so, which is how Airtable presents a dependency
     * that does not apply.
     */
    variant: Property.Dropdown({
      displayName: 'Variant',
      description: 'Some job types offer several models or modes. Others do not use this.',
      required: false,
      auth: rendobarAuth,
      refreshers: ['jobType'],
      options: async ({ auth, jobType }) => {
        if (!auth || !jobType) {
          return { disabled: true, options: [], placeholder: 'Please select a job type first' };
        }
        try {
          const { data } = await schemaFor(auth.secret_text, jobType as string);
          const disc = data.fields.find((f) => f.name === data.discriminator);
          if (!disc?.options) {
            return { disabled: true, options: [], placeholder: 'Not used by this job type' };
          }
          return {
            disabled: false,
            options: disc.options.map((o) => ({ label: o.label, value: o.value })),
          };
        } catch {
          return { disabled: true, options: [], placeholder: 'Failed to load variants. Check your connection.' };
        }
      },
    }),

    inputs: Property.DynamicProperties({
      displayName: 'Input Media',
      required: false,
      auth: rendobarAuth,
      refreshers: ['jobType'],
      props: async ({ auth, jobType }): Promise<DynamicPropsValue> => {
        if (!auth || !jobType) return {};
        const { data } = await schemaFor(auth.secret_text, jobType as string);
        return buildInputProps(data.inputs);
      },
    }),

    params: Property.DynamicProperties({
      displayName: 'Parameters',
      required: false,
      auth: rendobarAuth,
      refreshers: ['jobType', 'variant'],
      props: async ({ auth, jobType, variant }): Promise<DynamicPropsValue> => {
        // Return an empty set rather than throwing while a dependency is
        // missing: the form is still being filled in.
        if (!auth || !jobType) return {};
        const { data } = await schemaFor(auth.secret_text, jobType as string);
        return buildProps(data.fields, variant as string | undefined, data.discriminator, data.jsonSchema);
      },
    }),

    waitForResult: Property.Checkbox({
      displayName: 'Wait for the Result',
      description:
        'Pause the flow until the job finishes, so the next step gets the output file. The flow sleeps rather than holding a worker, so a long render costs nothing while it waits. Turn this off to submit and move on, then pick the result up with the Finished Job trigger.',
      required: false,
      defaultValue: true,
    }),

    downloadOutput: Property.Checkbox({
      displayName: 'Download the Output File',
      description:
        'Attach the finished file to this step, so a later step can upload it somewhere without fetching the URL itself. Only for small outputs: Activepieces caps a step file at 10 MB on Cloud, which most rendered video clears. Off, only the URL is returned, which is cheaper and is what most steps accept.',
      required: false,
      defaultValue: false,
    }),

    maxWaitSeconds: Property.Number({
      displayName: 'Maximum Wait (seconds)',
      description:
        'Only used when this Activepieces cannot be reached from the internet, which is the one case the flow has to wait by polling instead of sleeping. The job keeps going on Rendobar either way. Keep it below your flow timeout, 600 seconds by default.',
      required: false,
      defaultValue: 300,
    }),

    failOnJobError: Property.Checkbox({
      displayName: 'Fail This Step if the Job Fails',
      description:
        "On, a job that fails on Rendobar fails the step too, so the flow's error path runs. Off, the step succeeds and you check `succeeded` yourself, which is what you want when a failure is an outcome to branch on rather than a fault.",
      required: false,
      defaultValue: true,
    }),

    idempotencyKey: Property.ShortText({
      displayName: 'Idempotency Key',
      description:
        'Optional. Two runs sending the same key get the same job instead of two billed jobs. Leave empty and the step derives one per run, which is what stops an automatic retry paying twice.',
      required: false,
    }),
  },

  async run(context) {
    const { jobType, variant, params, inputs, waitForResult, maxWaitSeconds, downloadOutput } =
      context.propsValue;
    const failOnJobError = context.propsValue.failOnJobError !== false;

    // Rendobar called back and the flow is being resumed. The body names the
    // job; the job itself is read fresh, because the envelope is a
    // notification and can be late, replayed or truncated, while the read is
    // always the current truth. Same reasoning, same helper, as the Finished
    // Job trigger.
    if (context.executionType === ExecutionType.RESUME) {
      const jobId = jobIdFromEnvelope(context.resumePayload.body);
      if (jobId === undefined) {
        throw new Error(
          'Rendobar resumed this step with a body that names no job. Turn off "Wait for the Result" and use the Finished Job trigger instead.',
        );
      }
      const finished = await getJobById(context.auth.secret_text, jobId);
      const resumedRow = toJobRow(finished);
      raiseIfJobFailed(resumedRow, failOnJobError);
      return downloadOutput ? attachOutputFile(resumedRow, context.files) : resumedRow;
    }

    const chosenKey = (context.propsValue.idempotencyKey ?? '').trim();
    const token = context.auth.secret_text;

    const submitted = paramsFromForm((params ?? {}) as DynamicPropsValue);
    const media = inputsFromForm((inputs ?? {}) as DynamicPropsValue);

    // Only when a variant was chosen, and only to learn the name it submits
    // under. The alternative was encoding the field name into the dropdown's
    // value, which would read fine right up until the discriminator was
    // renamed and every saved flow submitted a param that no longer exists.
    // This costs one GET against an endpoint that is edge-cached for 300s and
    // carries an ETag, on a path that is about to run a media job, and it
    // self-heals when the contract moves.
    //
    // A job type that NEEDS a variant is handled in the form, not here: the
    // property set says so while it is being filled in, which is a better place
    // to learn it than a failed run.
    if (variant) {
      const schema = await schemaFor(token, jobType as string);
      if (schema.data.discriminator) submitted[schema.data.discriminator] = variant;
    }

    const submission = { type: jobType, inputs: media, params: submitted };

    // Without a key, an automatic step retry submits the work again and bills
    // for it a second time. Run and step separate the ordinary cases (two
    // Rendobar steps in one flow, the passes of a loop); the fingerprint
    // separates two DIFFERENT submissions that share them, which matters
    // because `POST /jobs` looks a repeated key up on (org, key) alone and
    // never compares payloads, so a colliding key would silently hand back the
    // first job with this step's parameters discarded.
    //
    // Every component is stable within a run, which is the point and is also
    // why a deliberate retry rebuilds the same key: submitJob walks off a key
    // Rendobar reports as spent, but only one this step invented.
    const baseKey =
      chosenKey === ''
        ? `activepieces:${context.run.id}:${context.step.name}:${fingerprint(submission)}`
        : chosenKey;

    // Waiting by blocking is the wrong shape here and cannot serve this API.
    // An Activepieces run is capped at 10 minutes on Cloud, where a worker
    // handles ONE run at a time, while a Rendobar job may take up to an hour on
    // Free and nine on Pro. So a blocking wait holds a worker for minutes and
    // still cannot outlast the jobs people actually run.
    //
    // A PAUSED flow costs neither: pause does not count against the run timeout
    // and may last 30 days, comfortably past the longest job. So the wait is a
    // waitpoint whose resume URL is handed to Rendobar as the job's own
    // callback, and the flow sleeps until the callback arrives.
    //
    // The callback needs to reach us from the internet. A self-hosted
    // Activepieces on a private network cannot be reached, so that case keeps
    // the polling wait, bounded by the run timeout, exactly as before.
    const wants = waitForResult !== false;

    let pending: { id: string; resumeUrl: string } | undefined;
    if (wants) {
      const created = await context.run.createWaitpoint({ type: 'WEBHOOK' });
      const resumeUrl = created.buildResumeUrl({ queryParams: {} });
      if (isPubliclyReachable(resumeUrl)) pending = { id: created.id, resumeUrl };
    }

    // Deliberately NOT part of the idempotency fingerprint above. A retry mints
    // a fresh waitpoint and so a fresh URL; folding that into the key would give
    // every retry a new key, submit a second job, and bill for it — undoing the
    // very thing the key is here to prevent.
    const created = await submitJob(
      token,
      pending ? { ...submission, callback: { url: pending.resumeUrl } } : submission,
      baseKey,
      chosenKey === '' ? 3 : 1,
    );

    // Pausing when no callback is coming hangs the flow for the waitpoint's
    // full 30 days, so the two responses that mean it is not are read here.
    // Which two, and why, is documented on callbackStillComing next to its tests.
    const coming = callbackStillComing(created.data);

    if (pending && coming) {
      context.run.waitForWaitpoint(pending.id);
      // The flow pauses on this line and the RESUME branch above produces the
      // finished row, so this value is never the step's output. Returning the
      // submission rather than reading the job back keeps a request off a path
      // whose result is discarded.
      return created.data;
    }

    // Not waiting, unreachable, or already settled. POST /jobs answers with the
    // id and nothing else, so the finished shape always comes from a read.
    const waitMs = wants && coming ? Math.max(0, (maxWaitSeconds ?? 300) * 1000) : 0;
    const job = await waitForJob(token, created.data.id, waitMs);
    const row = toJobRow(job);
    raiseIfJobFailed(row, failOnJobError);

    return downloadOutput ? attachOutputFile(row, context.files) : row;
  },
});
