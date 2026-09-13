/// <reference types="vitest/globals" />
import { toJobRow, JOB_OUTPUT_SCHEMA } from '../src/lib/common/job';

describe('toJobRow deliveries', () => {
  it('carries every destination outcome', () => {
    const deliveries = [
      { storageId: 'prod-media', status: 'delivered' as const, path: 'exports/clip.mp4', url: 'https://media.example.com/exports/clip.mp4' },
      { storageId: 'archive', status: 'failed' as const, reason: 'destination_denied' },
    ];
    expect(toJobRow({ id: 'job_1', type: 'ffmpeg', status: 'complete', deliveries }).deliveries).toEqual(deliveries);
  });

  it('is an empty list for a job that named no destinations, so columns stay consistent', () => {
    expect(toJobRow({ id: 'job_1', type: 'ffmpeg', status: 'complete' }).deliveries).toEqual([]);
  });

  it('labels the list in the builder', () => {
    expect(JOB_OUTPUT_SCHEMA.fields.some((f) => f.key === 'deliveries')).toBe(true);
  });
});
