// sync-social: pulls public metrics (followers, last post date, likes, comments)
// straight from each client's public profile link and writes them into
// social_clients.metrics. Runs server-side to dodge browser CORS limits.
//
// POST body: { "clientId"?: string }
//   - clientId set   -> syncs only that client (used by the "Sincronizar agora" button)
//   - clientId absent -> syncs every client (used by the daily 9am cron job)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

const digits = (s?: string | null) => (s ? s.replace(/[.,](?=\d{3}\b)/g, '') : null);
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function extractInstagram(html: string) {
  const out: Record<string, string> = {};
  const followers =
    html.match(/"edge_followed_by":\{"count":(\d+)\}/)?.[1] ??
    digits(html.match(/content="([\d.,]+)\s+Followers/i)?.[1]);
  if (followers) out.followers = String(followers);

  const ts = html.match(/"taken_at_timestamp":(\d+)/)?.[1];
  const dt = html.match(/datetime="(20\d{2}-\d{2}-\d{2})/)?.[1];
  const og = html.match(/og:updated_time[^>]*content="([^"]+)"/)?.[1];
  if (ts) out.lastPost = isoDate(parseInt(ts) * 1000);
  else if (dt) out.lastPost = dt;
  else if (og) out.lastPost = og.slice(0, 10);

  const likes = html.match(/"edge_media_preview_like":\{"count":(\d+)\}/)?.[1] ?? html.match(/"edge_liked_by":\{"count":(\d+)\}/)?.[1];
  if (likes) out.likes = likes;
  const comments = html.match(/"edge_media_to_comment":\{"count":(\d+)\}/)?.[1];
  if (comments) out.comments = comments;
  return out;
}

function extractLinkedIn(html: string) {
  const out: Record<string, string> = {};
  const followers = digits(html.match(/([\d.,]+)\s+followers/i)?.[1]);
  if (followers) out.followers = followers;
  const dt = html.match(/(20\d{2}-\d{2}-\d{2})T\d{2}:\d{2}/)?.[1];
  if (dt) out.lastPost = dt;
  return out;
}

function extractFacebook(html: string) {
  const out: Record<string, string> = {};
  const followers =
    digits(html.match(/([\d.,]+)\s+(?:people follow this|seguidores)/i)?.[1]) ??
    digits(html.match(/([\d.,]+)\s+(?:likes|curtidas)/i)?.[1]);
  if (followers) out.followers = followers;
  const utime = html.match(/data-utime="(\d+)"/)?.[1];
  const created = html.match(/"date_created":(\d+)/)?.[1];
  if (utime) out.lastPost = isoDate(parseInt(utime) * 1000);
  else if (created) out.lastPost = isoDate(parseInt(created) * 1000);
  return out;
}

function extractTikTok(html: string) {
  const out: Record<string, string> = {};
  const followers = html.match(/"followerCount":(\d+)/)?.[1];
  if (followers) out.followers = followers;
  const created = html.match(/"createTime":"?(\d+)"?/)?.[1];
  if (created) out.lastPost = isoDate(parseInt(created) * 1000);
  const likes = html.match(/"diggCount":(\d+)/)?.[1];
  if (likes) out.likes = likes;
  const comments = html.match(/"commentCount":(\d+)/)?.[1];
  if (comments) out.comments = comments;
  return out;
}

const EXTRACTORS: Record<string, (html: string) => Record<string, string>> = {
  instagram: extractInstagram,
  linkedin: extractLinkedIn,
  facebook: extractFacebook,
  tiktok: extractTikTok,
};

async function syncClientPlatforms(db: ReturnType<typeof createClient>, client: any) {
  const links = client.links || {};
  const metrics = { ...(client.metrics || {}) };
  const results: any[] = [];
  const platforms: string[] = client.platforms || [];

  for (const platform of platforms) {
    const url = links[platform];
    const prev = metrics[platform] || {};
    if (!url) {
      results.push({ clientId: client.id, platform, status: 'no-link' });
      continue;
    }
    const html = await fetchHtml(url);
    const extracted = html ? EXTRACTORS[platform]?.(html) ?? {} : {};
    const gotSomething = Object.keys(extracted).length > 0;
    metrics[platform] = {
      ...prev,
      ...extracted, // only overwrite fields we actually collected; manual values persist otherwise
      updatedAt: new Date().toISOString(),
      syncStatus: gotSomething ? 'auto' : 'blocked',
    };
    results.push({ clientId: client.id, platform, status: gotSomething ? 'ok' : 'blocked', data: extracted });
  }

  await db.from('social_clients').update({ metrics }).eq('id', client.id);
  return results;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const db = createClient(SUPABASE_URL, SERVICE_KEY);
  let clientId: string | undefined;
  try {
    const body = await req.json();
    clientId = body?.clientId;
  } catch {
    // no body -> sync-all (cron) mode
  }

  const query = db.from('social_clients').select('*');
  const { data: clients, error } = clientId ? await query.eq('id', clientId) : await query;

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const allResults = [];
  for (const client of clients ?? []) {
    const results = await syncClientPlatforms(db, client);
    allResults.push(...results);
  }

  return new Response(JSON.stringify({ ok: true, syncedAt: new Date().toISOString(), results: allResults }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
});
