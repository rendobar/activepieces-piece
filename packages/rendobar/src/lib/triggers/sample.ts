/**
 * One finished job, in the exact shape both triggers emit.
 *
 * Shared so the instant and polling triggers cannot drift: the builder shows
 * this before a real event arrives, and a flow built against it must keep
 * working when the real one lands.
 */
export const FINISHED_JOB_SAMPLE = {
    id: 'job_abc123',
    type: 'compress.target',
    status: 'complete',
    succeeded: true,
    media_type: 'video',
    output_category: 'video',
    file_url: 'https://cdn.rendobar.com/jobs/job_abc123/output.mp4',
    file_name: 'output.mp4',
    file_type: 'video',
    file_size_bytes: 443351,
    file_format: 'mp4',
    file_width: 1280,
    file_height: 720,
    file_duration_ms: 10000,
    file_count: 1,
    error_code: null,
    error_message: null,
    cost_formatted: '$0.0031',
    cost_nanodollars: 3100000,
    created_at: 1758000000000,
    started_at: 1758000001000,
    completed_at: 1758000004000,
    duration_ms: 3000,
    expires_at: 1758604800000,
    region: 'us-east-1',
    source: 'api',
    retry_count: 0,
    logs_available: true,
    data: null,
    files: [],
  };
