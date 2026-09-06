# Reaching a reader

## Formats are produced here, not at the edge

Cloudflare's image transformations cannot read AVIF below an Enterprise plan, and even there
the source is capped at 1200px while these variants go to 1920. The format chosen for storage
is the one format that pipeline cannot open. Measured: an AVIF source returns
`ERROR 9520: Original image has unsupported format` where the identical request against a PNG
source succeeds.

So the CDN decodes and re-encodes in the worker, using WASM codecs. That removes the plan
tier, the monthly quota and the dimension ceiling together, and the cost is bounded because
the extension is the entire request -- there is no size parameter to vary, so a caller cannot
invent work. Results are held in the edge cache, so the decode is paid once per colo rather
than once per reader.

Only the decoders for what is stored and the encoders for what is asked for. The AVIF
_encoder_ is deliberately absent: 1.1MB compressed against 332KB for the decoder, and
`cms image` already produces AVIF locally where the time costs nothing.

## The extension asks for a format

Only AVIF is stored. `/image/{cid}.avif` is served straight from the bucket; any other
extension is a request to convert that same object, which the worker satisfies through
Cloudflare's image transformations.

Cloudflare counts a conversion once per image regardless of how many formats it ends up
serving, so the whole fallback chain costs one transformation rather than a second and third
copy of the library. Storage would be nearly free either way -- what a stored fallback really
costs is the sync, the derive time, and a second thing to keep consistent.

No `?format=` parameter, because the extension already says which format is wanted and two
spellings of one request fragment the cache key.

**And for the same reason there is no `.jpg`.** It is not a second format, it is JPEG written
for an eight-character filename limit that outlived the system that imposed it -- the history
that leaves `yml` beside `yaml`. Carried as one, it would fragment exactly what the paragraph
above refuses to fragment: two validators, two edge entries and two conversions over identical
bytes. A request for it is answered with a permanent redirect to `.jpeg`, so a reader pays one
extra hop once and their browser never asks again.

The id is checked before that redirect is issued, and a missing one is answered `404` directly.
Redirecting first would make a client spend two round trips to learn that nothing is there.

**Nothing here generates the short spelling**, which is what keeps that lookup off the ordinary
path: `cms image` names a published file `.jpeg` and writes that name into the article, and the
site's asset resolver builds the same one. Both spelled it `jpg` until the redirect existed to
catch them, which would have made every JPEG this repository serves pay a hop meant for somebody
else's typo -- invisible from either side alone, since the CDN and the article each looked right.
A test on each side now holds the two spellings together.

The extension also caps the exposure: only a size that was derived exists as an object, so nobody
can burn the monthly transformation quota by asking for arbitrary dimensions.

The failure mode to remember is that exceeding the quota does not degrade -- new conversions
return an error while already-cached ones keep serving. That is why the request path a browser
takes by default is the stored AVIF, and conversion is only ever the fallback.

## Caching is the worker's job now

The old CDN served these files through a static-assets binding and set their cache policy in
a `_headers` file: `/fonts/*` for one year, `immutable`. That file has no equivalent once a
worker reads from R2, so the policy has to be reasserted in worker code or it is silently lost
-- the assets keep working while being re-fetched on every visit.

The trap inside the old policy is worth keeping in view. Latin font filenames carry no content
hash: `IoskeleyMono-Regular-latin.woff2` is a stable name. Declaring it `immutable` for a year
promises that the bytes at that name never change, so re-subsetting the font requires a new
filename. CJK chunks already carry content hashes and need no such promise. Whatever replaces
`_headers` has to preserve both cases rather than pretending all font names have one shape.

## Release assets are proxied, for one account

`/github/release/{repo}/{tag}/{asset}` serves a file attached to a GitHub release, fetched live
from `github.com/{owner}/{repo}/releases/download/{tag}/{asset}` and held at the edge. `latest`
as the tag takes GitHub's own alias for the newest non-prerelease. jsDelivr already serves a
repository's files at a tag, a branch or a commit, so those are not proxied here; a release
asset is the one thing it does not carry.

**The account is not in the URL.** It is `GITHUB_OWNER` in `libs/urls`, and there is no segment
in the CDN's path to name another, which is how "only my repositories" is enforced rather than
checked. A repository the account does not have, a tag that was never cut and an asset that was
never attached are all one answer from GitHub, 404, and the proxy says the same.

**A moving tag is held for minutes; a version for an hour.** `nightly`, `weekly`, `monthly`,
`stable`, `beta`, `dev`, `canary` and `latest`, in lowercase, name a release that is rewritten in
place, so what their assets held an hour ago is a different file: a hit is kept five minutes and
a miss one. Any other tag is read as a version, whose bytes will not change: an hour, and five
minutes for a miss, which is the CDN's usual life for an error. The list is exact -- `Nightly`
is a version as far as this is concerned -- because guessing at case would be guessing at
intent.

**A ranged download is answered from one upstream fetch.** The whole file is stored at the edge
under its plain URL, and the cache answers a `Range` request out of it with a 206, so a client
opening eight connections costs GitHub one transfer per colo rather than eight. A ranged request
that misses is answered from upstream as asked, and the whole file is fetched once behind it so
the connections that follow find it. Files past the edge cache's limit of 512 MB are passed
through unstored, ranges and all.

**The redirect is followed only onto GitHub.** The published address answers with a 302 to a
signed object URL, and following it is the whole mechanism; following it anywhere would make
this an open proxy the day that redirect changed, so the final host is checked. The headers that
describe the file -- type, length, disposition, `ETag`, `Last-Modified` -- are carried through;
the ones that described the upstream connection are not.
