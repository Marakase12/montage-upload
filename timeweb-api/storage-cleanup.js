import { ListMultipartUploadsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const PAGE_SIZE = 1000;
const DEFAULT_MAX_PAGES = 5;
const MAX_PAGES = 10;
const MAX_RETENTION_HOURS = 365 * 24;
const IMPORTANT_STATE = /^\.(?:queue|status|actions|workers|briefs)\//;
const JOB_FILE = /^[A-Za-z0-9_-]{8,100}\/[^/]+$/;
const RESULT_FILE = /^\.results\/[A-Za-z0-9_-]{8,100}\/[A-Za-z0-9_-]{8,160}\.mp4$/;

export class StorageCleanupReportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageCleanupReportError';
  }
}

export function cleanupRetentionHours(value = 24) {
  const normalized = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > MAX_RETENTION_HOURS) {
    throw new StorageCleanupReportError('RETENTION_HOURS must be an integer between 1 and 8760');
  }
  return normalized;
}

function timestamp(value) {
  if (!(value instanceof Date) && (typeof value !== 'string' || !value.trim())) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// This is an age inventory, NOT a deletion plan. It deliberately has no mutation
// commands, object-key output, or flag that could enable deletion/abort.
export async function reportStorageRetention({ s3, bucket, retentionHours = 24, now = Date.now(), maxPages = DEFAULT_MAX_PAGES }) {
  const hours = cleanupRetentionHours(retentionHours);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) {
    throw new StorageCleanupReportError('Storage report page limit must be between 1 and 10');
  }
  const cutoff = now - hours * 3_600_000;
  if (!Number.isFinite(now) || !Number.isFinite(new Date(cutoff).getTime())) {
    throw new StorageCleanupReportError('Storage report clock is invalid');
  }
  if (!s3 || typeof s3.send !== 'function' || typeof bucket !== 'string' || !bucket.trim()) {
    throw new StorageCleanupReportError('Storage report is not configured');
  }
  const report = {
    dryRun: true,
    deletionEnabled: false,
    retentionHours: hours,
    cutoffAt: new Date(cutoff).toISOString(),
    objects: {
      scanned: 0,
      candidates: { count: 0, bytes: 0, unknownSizeCount: 0 },
      skippedImportantState: 0,
      skippedUnknown: 0,
      skippedInvalidMetadata: 0,
      notExpired: 0,
      duplicateRecords: 0,
    },
    multipartUploads: { retained: 0, olderThanCutoff: 0, invalidMetadata: 0, duplicateRecords: 0 },
    pagination: {
      objects: { pages: 0, truncated: false, reason: null },
      multipartUploads: { pages: 0, truncated: false, reason: null },
    },
    truncated: false,
  };
  const abortSignal = AbortSignal.timeout(15_000);
  const send = async (command) => {
    try {
      const page = await s3.send(command, { abortSignal });
      if (!page || typeof page !== 'object' || Array.isArray(page)
          || (page.IsTruncated !== undefined && typeof page.IsTruncated !== 'boolean')
          || (page.Contents !== undefined && !Array.isArray(page.Contents))
          || (page.Uploads !== undefined && !Array.isArray(page.Uploads))) {
        throw new StorageCleanupReportError('Invalid storage listing');
      }
      return page;
    }
    catch { throw new StorageCleanupReportError('Storage report could not be completed; no files or uploads were changed'); }
  };
  const stop = (pagination, reason) => {
    pagination.truncated = true;
    pagination.reason = reason;
    report.truncated = true;
  };
  const seenObjects = new Set();
  const seenObjectCursors = new Set();
  let continuationToken;
  while (report.pagination.objects.pages < maxPages) {
    const page = await send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: PAGE_SIZE, ContinuationToken: continuationToken }));
    const pagination = report.pagination.objects;
    pagination.pages++;
    const contents = Array.isArray(page.Contents) ? page.Contents : [];
    for (const object of contents.slice(0, PAGE_SIZE)) {
      const key = object?.Key;
      if (typeof key !== 'string' || !key) { report.objects.skippedInvalidMetadata++; continue; }
      if (seenObjects.has(key)) { report.objects.duplicateRecords++; continue; }
      seenObjects.add(key);
      report.objects.scanned++;
      if (IMPORTANT_STATE.test(key)) { report.objects.skippedImportantState++; continue; }
      if (!JOB_FILE.test(key) && !RESULT_FILE.test(key)) { report.objects.skippedUnknown++; continue; }
      const modified = timestamp(object.LastModified);
      if (modified === null) { report.objects.skippedInvalidMetadata++; continue; }
      if (modified >= cutoff) { report.objects.notExpired++; continue; }
      const candidates = report.objects.candidates;
      candidates.count++;
      if (!Number.isSafeInteger(object.Size) || object.Size < 0) candidates.unknownSizeCount++;
      else if (candidates.bytes !== null) {
        const total = candidates.bytes + object.Size;
        candidates.bytes = Number.isSafeInteger(total) ? total : null;
      }
    }
    if (contents.length > PAGE_SIZE) { stop(pagination, 'oversized_page'); break; }
    if (!page.IsTruncated) break;
    const next = page.NextContinuationToken;
    if (typeof next !== 'string' || !next) { stop(pagination, 'missing_cursor'); break; }
    if (seenObjectCursors.has(next)) { stop(pagination, 'repeated_cursor'); break; }
    if (pagination.pages >= maxPages) { stop(pagination, 'page_limit'); break; }
    seenObjectCursors.add(next);
    continuationToken = next;
  }

  const seenUploads = new Set();
  const seenUploadCursors = new Set();
  let keyMarker;
  let uploadIdMarker;
  while (report.pagination.multipartUploads.pages < maxPages) {
    const page = await send(new ListMultipartUploadsCommand({ Bucket: bucket, MaxUploads: PAGE_SIZE, KeyMarker: keyMarker, UploadIdMarker: uploadIdMarker }));
    const pagination = report.pagination.multipartUploads;
    pagination.pages++;
    const uploads = Array.isArray(page.Uploads) ? page.Uploads : [];
    for (const upload of uploads.slice(0, PAGE_SIZE)) {
      if (typeof upload?.Key !== 'string' || !upload.Key || typeof upload.UploadId !== 'string' || !upload.UploadId) {
        report.multipartUploads.invalidMetadata++;
        continue;
      }
      const identity = JSON.stringify([upload.Key, upload.UploadId]);
      if (seenUploads.has(identity)) { report.multipartUploads.duplicateRecords++; continue; }
      seenUploads.add(identity);
      report.multipartUploads.retained++;
      const initiated = timestamp(upload.Initiated);
      if (initiated === null) report.multipartUploads.invalidMetadata++;
      else if (initiated < cutoff) report.multipartUploads.olderThanCutoff++;
    }
    if (uploads.length > PAGE_SIZE) { stop(pagination, 'oversized_page'); break; }
    if (!page.IsTruncated) break;
    const nextKey = page.NextKeyMarker;
    const nextUpload = page.NextUploadIdMarker;
    if (typeof nextKey !== 'string' || !nextKey || (nextUpload !== undefined && typeof nextUpload !== 'string')) {
      stop(pagination, 'missing_cursor'); break;
    }
    const cursor = JSON.stringify([nextKey, nextUpload ?? null]);
    if (seenUploadCursors.has(cursor)) { stop(pagination, 'repeated_cursor'); break; }
    if (pagination.pages >= maxPages) { stop(pagination, 'page_limit'); break; }
    seenUploadCursors.add(cursor);
    keyMarker = nextKey;
    uploadIdMarker = nextUpload;
  }
  return report;
}
