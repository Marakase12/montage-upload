// Small, dependency-free rules shared by the interface and its regression tests.
export function freshProcessingOptions() {
  return { mode: 'short', aspectRatio: '9:16', requestText: '', faceTrackingEnabled: true, subtitlesEnabled: true, hookEnabled: true };
}

export function sourceProblem(file, maxFileSize) {
  if (!file) return 'Сначала выберите видео.';
  if (!file.size) return 'Этот файл пуст. Выберите другое видео.';
  if (file.size > maxFileSize) return 'Видео превышает допустимый размер.';
  if (!/\.(mp4|mov|mkv)$/i.test(file.name || '')) {
    return 'Для автоматического монтажа выберите MP4, MOV или MKV. Другие материалы можно добавить отдельно.';
  }
  return '';
}

export function canStartCreation({ file, consent, busy, maxFileSize }) {
  return Boolean(!busy && consent && !sourceProblem(file, maxFileSize));
}

export function projectMatches(project, search, filter) {
  const name = String(project.title || project.fileName || project.name || '').toLocaleLowerCase('ru');
  if (!name.includes(String(search || '').trim().toLocaleLowerCase('ru'))) return false;
  const state = String(project.state || project.status?.state || project.pipelineState || 'UNKNOWN').toUpperCase();
  if (filter === 'ready') return ['READY_FOR_REVIEW', 'APPROVED', 'LONG_CANDIDATES_READY'].includes(state);
  if (filter === 'working') return ['UPLOADING', 'UPLOADED', 'QUEUED', 'PROCESSING'].includes(state);
  return true;
}

export function previewIdentity(task) {
  // Signed URLs may rotate on every poll. They do not identify a new video version.
  return `${task.taskId}:${task.previewVersion ?? task.updatedAt ?? ''}:${task.resultKey ?? task.previewPath ?? task.previewKey ?? ''}`;
}
