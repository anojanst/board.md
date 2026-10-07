// Renders a task's markdown body. Raw HTML is escaped, so a task file can't inject scripts, and
// links are limited to safe schemes.
import { Marked } from 'marked';

/** Maps a relative link or image path to where it should point, or null to drop it. */
export type LinkResolver = (href: string, kind: 'link' | 'image') => string | null;

export function renderMarkdown(source: string, resolve?: LinkResolver): string {
  const marked = new Marked({
    gfm: true,
    async: false,
    renderer: { html: ({ text }) => escapeHtml(text) },
    walkTokens(token) {
      if (token.type === 'link' || token.type === 'image')
        token.href = safeHref(token.href, token.type, resolve);
    },
  });
  return marked.parse(source, { async: false });
}

function safeHref(href: string, kind: 'link' | 'image', resolve?: LinkResolver): string {
  const clean = href.replace(/[\u0000- \u007f]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(clean)?.[1]?.toLowerCase();
  if (scheme) return ['http', 'https', 'mailto'].includes(scheme) ? href : '#';
  // Fragments and protocol-relative links (another site) stay as they are.
  if (clean.startsWith('#') || clean.startsWith('//')) return href;
  return resolve?.(href, kind) ?? '#';
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
