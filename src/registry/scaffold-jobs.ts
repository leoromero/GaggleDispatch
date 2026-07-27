/**
 * Scaffold job records (Section 21.6.2).
 *
 * Was `<base_folder>/scaffold_jobs.yaml`, rewritten in full on every change.
 * Now a row per job, which also removes the read-modify-write race two
 * concurrent `gaggle repo scaffold` invocations could hit.
 *
 * The pure list helpers (`upsertJob`, `removeJobBySlug`) went with the file: an
 * upsert is one statement now, so there is nothing to manipulate in memory
 * first.
 */

import type { ScaffoldJobRow, Store } from '../executor/store/types.ts';
import type { ScaffoldJob, ScaffoldJobsFile } from '../domain/types.ts';

function toJob(row: ScaffoldJobRow): ScaffoldJob {
  return {
    slug: row.slug,
    url: row.url,
    checkout_path: row.checkout_path,
    run_id: row.run_id,
    workflow_name: row.workflow_name,
    branch: row.branch,
    started_at: row.started_at,
    last_polled_at: row.last_polled_at,
    last_status: row.last_status as ScaffoldJob['last_status'],
    pr_url: row.pr_url,
    last_error: row.last_error,
  };
}

export async function loadScaffoldJobs(store: Store): Promise<ScaffoldJobsFile> {
  return { jobs: (await store.listScaffoldJobs()).map(toJob) };
}

export async function saveScaffoldJob(store: Store, job: ScaffoldJob): Promise<void> {
  await store.upsertScaffoldJob({
    slug: job.slug,
    url: job.url,
    checkout_path: job.checkout_path,
    run_id: job.run_id,
    workflow_name: job.workflow_name,
    branch: job.branch,
    started_at: job.started_at,
    last_polled_at: job.last_polled_at,
    last_status: job.last_status,
    pr_url: job.pr_url,
    last_error: job.last_error,
  });
}

export async function removeScaffoldJob(store: Store, slug: string): Promise<void> {
  await store.deleteScaffoldJob(slug);
}

export async function findScaffoldJob(store: Store, slug: string): Promise<ScaffoldJob | null> {
  const hit = (await store.listScaffoldJobs()).find((j) => j.slug === slug);
  return hit ? toJob(hit) : null;
}
