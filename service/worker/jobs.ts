import crypto from 'node:crypto';
import { runOrchestrator } from '../orchestrator/run.js';

type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

export type ResearchJob = {
  id: string;
  tenantId: string;
  model: string;
  query: string;
  createdAt: number;
  updatedAt: number;
  status: JobStatus;
  result?: string;
  error?: string;
};

const jobs = new Map<string, ResearchJob>();

export function enqueueResearchJob(params: {
  tenantId: string;
  model: string;
  query: string;
  openRouterApiKey?: string;
}): ResearchJob {
  const id = `job_${crypto.randomUUID().replace(/-/g, '')}`;

  const job: ResearchJob = {
    id,
    tenantId: params.tenantId,
    model: params.model,
    query: params.query,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'queued'
  };

  jobs.set(id, job);

  queueMicrotask(async () => {
    const current = jobs.get(id);
    if (!current) return;

    try {
      current.status = 'running';
      current.updatedAt = Date.now();

      const out = await runOrchestrator({
        tenantId: params.tenantId,
        model: params.model,
        openRouterApiKey: params.openRouterApiKey,
        messages: [{ role: 'user', content: params.query }]
      });

      current.status = 'completed';
      current.result = out.text;
      current.updatedAt = Date.now();
    } catch (error) {
      current.status = 'failed';
      current.error = error instanceof Error ? error.message : String(error);
      current.updatedAt = Date.now();
    }
  });

  return job;
}

export function getResearchJob(jobId: string): ResearchJob | null {
  return jobs.get(jobId) ?? null;
}
