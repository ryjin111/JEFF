import { JOB_ID } from './client.js';

export function parseReviewed(value) {
  try {
    const ids = JSON.parse(value);
    if (!Array.isArray(ids) || ids.length > 5000 || ids.some(id => typeof id !== 'string' || !JOB_ID.test(id))) return new Set();
    return new Set(ids);
  } catch { return new Set(); }
}

export function unseenOutcomes(jobs, reviewed) {
  return jobs.filter(job => !reviewed.has(job.id) && JOB_ID.test(job.id)
    && ((job.status === 'completed' && job.saved === true) || ['failed', 'interrupted'].includes(job.status)))
    .sort((a, b) => (Date.parse(b.finishedAt || b.startedAt) || 0) - (Date.parse(a.finishedAt || a.startedAt) || 0));
}
