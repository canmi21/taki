import { GITHUB_OWNER, URLS } from '@canmi/urls';
import { describe, expect, it } from 'vitest';
import { isGitHubHost, isReleaseName, releaseLife, releaseUpstream } from './github';

describe('releaseUpstream', () => {
	it('fetches from the one account, and nowhere in the URL says which', () => {
		const upstream = releaseUpstream('rdm', 'nightly', 'rdm-nightly-macos-arm64.dmg');
		expect(upstream.origin).toBe(URLS.external.github.web);
		expect(upstream.pathname).toBe(
			`/${GITHUB_OWNER}/rdm/releases/download/nightly/rdm-nightly-macos-arm64.dmg`,
		);
	});

	it('spells latest the way GitHub does', () => {
		expect(releaseUpstream('age', 'latest', 'age').pathname).toBe(
			`/${GITHUB_OWNER}/age/releases/latest/download/age`,
		);
	});
});

describe('releaseLife', () => {
	it('holds a version for an hour and a failure for five minutes', () => {
		expect(releaseLife('v1.1.5')).toEqual({
			hit: 'public, max-age=3600',
			miss: 'public, max-age=300',
		});
	});

	it('holds a moving tag for five minutes and a failure for one', () => {
		for (const tag of ['nightly', 'weekly', 'monthly', 'stable', 'beta', 'dev', 'canary', 'latest']) {
			expect(releaseLife(tag)).toEqual({
				hit: 'public, max-age=300',
				miss: 'public, max-age=60',
			});
		}
	});

	it('reads the tag exactly: a capitalised Nightly is a version as far as this is concerned', () => {
		expect(releaseLife('Nightly').hit).toBe('public, max-age=3600');
	});
});

describe('isReleaseName', () => {
	it('accepts what GitHub accepts', () => {
		expect(isReleaseName('rdm')).toBe(true);
		expect(isReleaseName('v2026.03.16')).toBe(true);
		expect(isReleaseName('C2DB-2026-03-16.zip')).toBe(true);
	});

	it('rejects anything that could reach past the account', () => {
		expect(isReleaseName('..')).toBe(false);
		expect(isReleaseName('a..b')).toBe(false);
		expect(isReleaseName('a/b')).toBe(false);
		expect(isReleaseName('')).toBe(false);
		expect(isReleaseName('.hidden')).toBe(false);
	});
});

describe('isGitHubHost', () => {
	it('follows the redirect only onto GitHub', () => {
		expect(isGitHubHost('github.com')).toBe(true);
		expect(isGitHubHost('release-assets.githubusercontent.com')).toBe(true);
		expect(isGitHubHost('objects.githubusercontent.com')).toBe(true);
		expect(isGitHubHost('evil.example')).toBe(false);
		expect(isGitHubHost('githubusercontent.com.evil.example')).toBe(false);
	});
});
