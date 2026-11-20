export const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export const priorities = { low: '🟢 Низький', medium: '🟡 Середній', high: '🔴 Високий' };
export class UserError extends Error {}
