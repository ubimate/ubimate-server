import { Router, Request, Response } from 'express';
import dns from 'dns';
import net from 'net';
import { requireAuth } from '../middleware/auth';

export const unfurlRouter = Router();
unfurlRouter.use(requireAuth);

// ── SSRF protection ──────────────────────────────────────────────────────────

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) // link-local
    );
  }
  if (net.isIPv6(ip)) {
    const norm = ip.toLowerCase().replace(/^\[|\]$/g, '');
    return (
      norm === '::1' ||
      norm.startsWith('fc') ||
      norm.startsWith('fd') ||
      norm.startsWith('fe80')
    );
  }
  return false;
}

async function isSsrfRisk(hostname: string): Promise<boolean> {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;

  // If the hostname is already an IP literal, check it directly.
  if (net.isIPv4(h) || net.isIPv6(h)) return isPrivateIp(h);

  // Resolve DNS and check every returned address.
  // NOTE: redirect targets are not re-checked; this protects against direct
  // private-IP references but not against DNS-rebinding or redirect chains.
  try {
    const v4 = await dns.promises.resolve4(h);
    if (v4.some(isPrivateIp)) return true;
  } catch { /* no IPv4 record */ }

  try {
    const v6 = await dns.promises.resolve6(h);
    if (v6.some(isPrivateIp)) return true;
  } catch { /* no IPv6 record */ }

  return false;
}

// ── HTML parsing ─────────────────────────────────────────────────────────────

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function resolveHref(href: string, base: string): string {
  try { return new URL(href, base).href; } catch { return href; }
}

/**
 * Extract the content attribute of a <meta> tag by its property or name.
 * Handles both attribute orderings:
 *   <meta property="og:title" content="…">
 *   <meta content="…" property="og:title">
 */
function metaContent(html: string, prop: string): string {
  const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re1 = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*?)["']`,
    'i',
  );
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']*?)["'][^>]+(?:property|name)=["']${escaped}["']`,
    'i',
  );
  return (re1.exec(html)?.[1] ?? re2.exec(html)?.[1] ?? '').trim();
}

interface OgData {
  title: string;
  description: string;
  image: string;
  favicon: string;
}

function parseOgData(html: string, baseUrl: string): OgData {
  const title =
    decodeHtmlEntities(metaContent(html, 'og:title')) ||
    decodeHtmlEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '');

  const description =
    decodeHtmlEntities(metaContent(html, 'og:description')) ||
    decodeHtmlEntities(metaContent(html, 'description'));

  const rawImage = metaContent(html, 'og:image');
  const image = rawImage ? resolveHref(rawImage, baseUrl) : '';

  // Favicon: try <link rel="icon"> or <link rel="shortcut icon">
  const iconMatch =
    /<link[^>]+rel=["'][^"']*(?:shortcut )?icon[^"']*["'][^>]+href=["']([^"']+)["']/i.exec(html) ??
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*(?:shortcut )?icon[^"']*["']/i.exec(html);
  const favicon = iconMatch
    ? resolveHref(iconMatch[1], baseUrl)
    : `${new URL(baseUrl).origin}/favicon.ico`;

  return { title, description, image, favicon };
}

// ── Route ────────────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 512 * 1024; // 512 KB
const FETCH_TIMEOUT_MS = 8_000;

unfurlRouter.get('/', async (req: Request, res: Response) => {
  const raw = (req.query.url as string | undefined)?.trim();
  if (!raw) {
    res.status(400).json({ error: 'Missing url parameter' });
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    res.status(400).json({ error: 'Invalid URL' });
    return;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    res.status(400).json({ error: 'Only http and https URLs are supported' });
    return;
  }

  if (await isSsrfRisk(parsed.hostname)) {
    res.status(400).json({ error: 'URL not allowed' });
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(parsed.href, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Notefinity/1.0 (link preview; +https://notefinity.app)',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      // Non-HTML resource — return URL-only card with empty metadata.
      res.json({ title: '', description: '', image: '', favicon: '', url: raw });
      return;
    }

    // Stream up to MAX_BODY_BYTES so we never load a full multi-MB page into memory.
    const reader = response.body?.getReader();
    if (!reader) {
      res.status(502).json({ error: 'Empty response body' });
      return;
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      totalBytes += value.byteLength;
      if (totalBytes >= MAX_BODY_BYTES) break;
    }
    reader.cancel().catch(() => { /* ignore */ });

    // Merge chunks into a single buffer and decode as UTF-8 (best-effort).
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk.subarray(0, Math.min(chunk.length, totalBytes - offset)), offset);
      offset += chunk.length;
    }
    const html = new TextDecoder('utf-8', { fatal: false }).decode(merged);

    const og = parseOgData(html, response.url || raw);
    res.json({ ...og, url: raw });
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'AbortError') {
      res.status(504).json({ error: 'Request timed out' });
    } else {
      res.status(502).json({ error: 'Failed to fetch URL' });
    }
  }
});
