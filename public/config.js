// Личный кабинет работает на одном домене с API. GitHub Pages остаётся
// гостевой точкой входа и отправляет загрузки в облачный API.
const cloudApi = 'https://marakase12-montage-upload-1827.twc1.net';
window.MONTAGE_UPLOAD_CONFIG = {
  apiBase: window.location.hostname.endsWith('.github.io') ? cloudApi : '',
  allowManualToken: false,
};
