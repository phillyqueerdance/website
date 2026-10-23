import '../event-metadata.js';

export const SHARE_WIDTH = 900;
export const SHARE_HEIGHT = 1067;
export const SHARE_REPOSITORY = 'phillyqueerdance/website';

// The website and background generator derive the same filename without
// publishing a second event database or trusting a caller-supplied image URL.
export async function shareArtifact(event) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit' }).formatToParts(new Date(event.start));
  const month = ['year', 'month'].map(type => parts.find(part => part.type === type).value).join('-');
  const bytes = new TextEncoder().encode(globalThis.QDPEventMetadata.shareContent(event));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const name = `event-${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}.png`;
  const tag = `qdp-share-images-${month}`;
  return { tag, name, url: `https://github.com/${SHARE_REPOSITORY}/releases/download/${tag}/${name}` };
}
