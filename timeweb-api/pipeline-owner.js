/** Server-owned processing identity, never a display name supplied by a client. */
export class PipelineOwnerError extends Error {
  constructor() {
    super('Не удалось подтвердить владельца обработки');
    this.status = 409;
  }
}

const JOB_ID = /^[A-Za-z0-9_-]{8,100}$/;
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function checkJobId(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw new PipelineOwnerError();
}

export function normalizePipelineOwner(owner, jobId) {
  checkJobId(jobId);
  // Pre-isolation records remain project-scoped. Never infer a personal profile
  // or promote an old guest task when someone later attaches it to an account.
  if (owner === undefined) return { kind: 'guest', id: jobId };
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) throw new PipelineOwnerError();
  if (owner.kind === 'account' && typeof owner.id === 'string' && ACCOUNT_ID.test(owner.id)) {
    return { kind: 'account', id: owner.id };
  }
  if (owner.kind === 'guest' && owner.id === jobId) return { kind: 'guest', id: jobId };
  throw new PipelineOwnerError();
}

/** Input must be a successfully verified server-signed job capability. */
export function ownerFromJobAccess(job) {
  checkJobId(job?.jobId);
  return normalizePipelineOwner(job.source === 'account'
    ? { kind: 'account', id: job.userId }
    : undefined, job.jobId);
}

/** Input must come from the persisted queue, not from an action request body. */
export function ownerFromTask(task, jobId, taskId) {
  if (!task || task.jobId !== jobId || task.taskId !== taskId) throw new PipelineOwnerError();
  return normalizePipelineOwner(task.owner, jobId);
}

/**
 * Account access may adopt pre-isolation guest work after an explicit claim.
 * Guest access is never allowed to move in the opposite direction.
 */
export function assertPipelineOwnerAccess(requestOwner, resourceOwner, jobId) {
  const caller = normalizePipelineOwner(requestOwner, jobId);
  const resource = normalizePipelineOwner(resourceOwner, jobId);
  if (resource.kind === 'guest') {
    if (caller.kind === 'account' || caller.id === resource.id) return resource;
  } else if (caller.kind === 'account' && caller.id === resource.id) {
    return resource;
  }
  throw new PipelineOwnerError();
}
