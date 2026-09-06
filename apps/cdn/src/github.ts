import { GITHUB_OWNER, URLS } from '@canmi/urls';
import { Hono } from 'hono';
import { BRIEFLY } from './cache';

/**
 * Proxying GitHub: avatars, and the release assets of one account.
 *
 * Unlike favicons both stay live fetches, because neither has a bounded set to prepare in
 * advance. Nothing here writes, so the mirror stays one-directional: the rule is that the cloud
 * never authors bytes in `data/public`, not that it never makes a request. See
 * spec/architecture/data.md and, for the release proxy, spec/architecture/delivery.md.
 */
const github = new Hono();

github.get('/avatar/:idOrName', async (c) => {
	const value = c.req.param('idOrName');
	const width = c.req.query('width');
	const isNumeric = /^\d+$/.test(value);

	// Numeric ids resolve against the avatar host and take `s`; usernames go through
	// github.com and take `size`. Two spellings for one idea, both upstream's.
	const upstream = isNumeric
		? new URL(`${URLS.external.github.avatars}/u/${value}`)
		: new URL(`${URLS.external.github.web}/${value}.png`);
	if (width) upstream.searchParams.set(isNumeric ? 's' : 'size', width);

	const response = await fetch(upstream);
	return new Response(response.body, {
		status: response.status,
		headers: { 'Content-Type': response.headers.get('content-type') ?? 'image/png' },
	});
});

// ---- Release assets -----------------------------------------------------------------------------

/**
 * Tags that name a moving target rather than a version.
 *
 * A release under one of these is rewritten in place -- a nightly is republished every night
 * under the same tag -- so what its asset held an hour ago is a different file. Those are held
 * for minutes; a version tag names bytes that will not change and is held for an hour. `latest`
 * is GitHub's own alias for the newest non-prerelease and moves for the same reason.
 */
export const ROLLING_TAGS: ReadonlySet<string> = new Set([
	'nightly',
	'weekly',
	'monthly',
	'stable',
	'beta',
	'dev',
	'canary',
	'latest',
]);

/** How long a fetched asset is kept, and how long a failure to fetch one is. */
export type Life = { readonly hit: string; readonly miss: string };

const HOUR = 3_600;
const FIVE_MINUTES = 300;
const MINUTE = 60;

export function releaseLife(tag: string): Life {
	if (ROLLING_TAGS.has(tag)) {
		return {
			hit: `public, max-age=${FIVE_MINUTES}`,
			miss: `public, max-age=${MINUTE}`,
		};
	}
	return { hit: `public, max-age=${HOUR}`, miss: BRIEFLY };
}

/**
 * What GitHub itself allows in a repository name, a tag and an asset filename, and nothing that
 * could be a path: no slash, no `..`. A name failing this is a 404 rather than an upstream
 * request built from it.
 */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isReleaseName(value: string): boolean {
	return NAME.test(value) && !value.includes('..');
}

/**
 * The download address GitHub publishes for an asset, which needs no API call and no token.
 *
 * The account is fixed: there is no segment in the CDN's URL to name another one, which is how
 * "proxies only my repositories" is enforced rather than checked. `latest` takes GitHub's own
 * alias path; any other tag is spelled as given.
 */
export function releaseUpstream(repo: string, tag: string, asset: string): URL {
	const base = `${URLS.external.github.web}/${GITHUB_OWNER}/${repo}/releases`;
	return new URL(
		tag === 'latest' ? `${base}/latest/download/${asset}` : `${base}/download/${tag}/${asset}`,
	);
}

/**
 * Where a release download may end up after its redirects.
 *
 * The published address answers with a 302 to a signed object URL, and following it is the
 * whole mechanism. Following it anywhere would make this an open proxy the day GitHub's redirect
 * changed, so the final host is checked against GitHub's own.
 */
export function isGitHubHost(hostname: string): boolean {
	return hostname === 'github.com' || hostname.endsWith('.githubusercontent.com');
}

/** Headers carried through from the object store; the rest describe its connection, not the file. */
const CARRIED = ['Content-Type', 'Content-Length', 'Content-Disposition', 'ETag', 'Last-Modified'];

/** The most the edge cache will hold as one object. */
const CACHE_LIMIT = 512 * 1024 * 1024;

github.get('/release/:repo/:tag/:asset', async (c) => {
	const repo = c.req.param('repo');
	const tag = c.req.param('tag');
	const asset = c.req.param('asset');
	const life = releaseLife(tag);

	if (![repo, tag, asset].every(isReleaseName)) {
		c.header('Cache-Control', life.miss);
		return c.json({ error: 'not found' }, 404);
	}

	// The edge holds the whole file under the plain URL, and `match` answers a Range request
	// out of it with a 206 -- so a multi-connection download is served from one upstream fetch.
	const cache = typeof caches === 'undefined' ? null : caches.default;
	const key = new Request(c.req.url, { method: 'GET' });
	const cached = await cache?.match(c.req.raw);
	if (cached) return cached;

	const upstream = releaseUpstream(repo, tag, asset);
	const range = c.req.header('Range');
	const response = await fetch(upstream, {
		redirect: 'follow',
		headers: range ? { Range: range } : {},
	}).catch(() => null);

	if (response === null || !isGitHubHost(new URL(response.url).hostname)) {
		c.header('Cache-Control', life.miss);
		return c.json({ error: 'upstream unavailable' }, 502);
	}
	if (!response.ok && response.status !== 206) {
		// A repository not under the account, a tag that was never cut, an asset not attached:
		// GitHub says 404 to all three, and so does this.
		c.header('Cache-Control', life.miss);
		return c.json({ error: 'not found' }, response.status === 404 ? 404 : 502);
	}

	const headers = new Headers();
	for (const name of CARRIED) {
		const value = response.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	headers.set('Accept-Ranges', 'bytes');
	headers.set('Cache-Control', life.hit);
	if (response.status === 206) {
		const contentRange = response.headers.get('Content-Range');
		if (contentRange !== null) headers.set('Content-Range', contentRange);
	}

	const size = Number(response.headers.get('Content-Length') ?? Number.POSITIVE_INFINITY);
	const out = new Response(response.body, { status: response.status, headers });

	if (cache !== null && size <= CACHE_LIMIT) {
		if (response.status === 200) {
			c.executionCtx.waitUntil(cache.put(key, out.clone()));
		} else {
			// A ranged miss is answered from upstream as asked, and the whole file is fetched
			// once behind it so the connections that follow find it at the edge.
			c.executionCtx.waitUntil(
				fetch(upstream, { redirect: 'follow' }).then((whole) => {
					if (!whole.ok || !isGitHubHost(new URL(whole.url).hostname)) return;
					const stored = new Headers();
					for (const name of CARRIED) {
						const value = whole.headers.get(name);
						if (value !== null) stored.set(name, value);
					}
					stored.set('Accept-Ranges', 'bytes');
					stored.set('Cache-Control', life.hit);
					return cache.put(key, new Response(whole.body, { headers: stored }));
				}),
			);
		}
	}
	return out;
});

export default github;
