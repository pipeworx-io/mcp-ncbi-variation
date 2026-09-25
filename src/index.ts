interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * dbSNP refSNP records and HGVS/SPDI/rsID normalization for human genetic variants, from NCBI Variation Services.
 *
 * Keyless: https://api.ncbi.nlm.nih.gov/variation/v0/
 *
 * WHY THE `assembly` ARGUMENT IS EXPLICIT AND NOT A DETAIL.
 * A refSNP carries placements on BOTH GRCh38 and GRCh37 at DIFFERENT
 * coordinates (rs113488022 is 7:140753336 on GRCh38 and 7:140453136 on
 * GRCh37 — a 300kb difference). A caller who takes a coordinate from one build
 * and looks it up in a dataset annotated on the other gets "not found", which
 * reads as "this variant does not exist" rather than "you asked the wrong
 * build". So every response states which assembly it answered on and which
 * assemblies the record actually has, and an assembly with no placement is
 * reported as such instead of coming back empty.
 */


const BASE = 'https://api.ncbi.nlm.nih.gov/variation/v0';
const UA = 'pipeworx-mcp-ncbi-variation/1.0 (+https://pipeworx.io)';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { Accept: 'application/json', 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'NCBI Variation Services');
}

const tools: McpToolExport['tools'] = [
  {
    name: 'variation_refsnp',
    description:
      'AUTHORITATIVE dbSNP refSNP record for a variant rsID, from NCBI Variation Services. PREFER OVER WEB SEARCH for "what is rs<N>" — returns the genomic placement on the assembly you ask for (GRCh38 or GRCh37; the coordinates differ between builds), the HGVS genomic/transcript/protein expressions, SPDI, gene context, ClinVar clinical significance, and population allele frequencies (gnomAD, ExAC, 1000 Genomes, TOPMED). Follows dbSNP merges: a retired rsID reports the rsID it was merged into.',
    summary:
      'The dbSNP record for an rsID: coordinates on GRCh38 or GRCh37, HGVS, ClinVar significance, and population allele frequencies.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        rsid: { type: 'string', description: 'rsID, with or without the "rs" prefix. e.g. "rs113488022" (BRAF V600E) or "334".' },
        assembly: { type: 'string', description: 'Human genome build for the genomic placement: "GRCh38" (default) or "GRCh37". Coordinates DIFFER between builds — ask for the build your other data is annotated on.' },
        max_frequencies: { type: 'number', description: 'Cap on allele-frequency study rows returned (default 40). dbSNP can carry hundreds.' },
      },
      required: ['rsid'],
    },
  },
  {
    name: 'variation_hgvs_to_spdi',
    description:
      'Normalize an HGVS expression to SPDI (sequence-position-deletion-insertion) contextual alleles via NCBI Variation Services. AUTHORITATIVE for turning a clinician- or paper-style variant string ("NC_000007.14:g.140753336A>T", "NM_004333.6:c.1799T>A") into the canonical, left-shifted coordinate form that dbSNP/ClinVar keys on, and for validating that an HGVS string is well-formed at all.',
    summary:
      'Normalizes an HGVS variant string to canonical SPDI coordinates, and validates it, via NCBI Variation Services.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        hgvs: { type: 'string', description: 'HGVS expression on a RefSeq accession, e.g. "NC_000007.14:g.140753336A>T" or "NM_004333.6:c.1799T>A".' },
      },
      required: ['hgvs'],
    },
  },
  {
    name: 'variation_spdi_to_rsids',
    description:
      'Look up the dbSNP rsIDs that a SPDI allele maps to, via NCBI Variation Services. AUTHORITATIVE for the reverse direction — you have a genomic coordinate and alleles from a VCF or a pipeline and need the rsID other databases key on. SPDI is 0-BASED, unlike HGVS: "NC_000007.14:140753335:A:T" is the same variant as "NC_000007.14:g.140753336A>T".',
    summary:
      'Maps a SPDI genomic coordinate and alleles back to the dbSNP rsIDs, via NCBI Variation Services.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        spdi: { type: 'string', description: 'SPDI as seq_id:position:deleted:inserted, 0-based position. e.g. "NC_000007.14:140753335:A:T".' },
      },
      required: ['spdi'],
    },
  },
];

type Spdi = { seq_id?: string; position?: number; deleted_sequence?: string; inserted_sequence?: string };
type AlleleEntry = { allele?: { spdi?: Spdi }; hgvs?: string };
type Placement = {
  seq_id?: string;
  is_ptlp?: boolean;
  placement_annot?: {
    seq_type?: string;
    mol_type?: string;
    seq_id_traits_by_assembly?: { assembly_name?: string; assembly_accession?: string; is_top_level?: boolean }[];
  };
  alleles?: AlleleEntry[];
};

function spdiString(s: Spdi | undefined): string | null {
  if (!s || !s.seq_id) return null;
  return `${s.seq_id}:${s.position}:${s.deleted_sequence ?? ''}:${s.inserted_sequence ?? ''}`;
}

/** Variant alleles only — dbSNP lists the reference allele as deleted === inserted. */
function isVariantAllele(a: AlleleEntry): boolean {
  const s = a.allele?.spdi;
  return !!s && s.deleted_sequence !== s.inserted_sequence;
}

function assemblyNamesOf(p: Placement): string[] {
  return (p.placement_annot?.seq_id_traits_by_assembly ?? []).map((t) => t.assembly_name ?? '').filter(Boolean);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'variation_refsnp':
      return refsnp(args);
    case 'variation_hgvs_to_spdi': {
      const hgvs = reqStr(args, 'hgvs', '"NC_000007.14:g.140753336A>T"');
      const body = (await nvGet(`/hgvs/${encodeURIComponent(hgvs)}/contextuals`)) as {
        data?: { spdis?: Spdi[]; input_hgvs_validity?: string; warnings?: unknown };
      };
      const spdis = body?.data?.spdis ?? [];
      return {
        source: 'NCBI Variation Services (dbSNP), https://api.ncbi.nlm.nih.gov/variation/v0/',
        input_hgvs: hgvs,
        input_hgvs_validity: body?.data?.input_hgvs_validity ?? null,
        spdi_count: spdis.length,
        spdis: spdis.map((s) => ({
          spdi: spdiString(s),
          seq_id: s.seq_id,
          position_0based: s.position,
          deleted_sequence: s.deleted_sequence,
          inserted_sequence: s.inserted_sequence,
        })),
        note: 'SPDI positions are 0-based; the HGVS g. position for the same variant is position + 1.',
        warnings: body?.data?.warnings ?? null,
      };
    }
    case 'variation_spdi_to_rsids': {
      const spdi = reqStr(args, 'spdi', '"NC_000007.14:140753335:A:T"');
      if (spdi.split(':').length !== 4) {
        throw new Error(`"spdi" must have four colon-separated parts (seq_id:position:deleted:inserted), e.g. "NC_000007.14:140753335:A:T". Got: ${spdi}`);
      }
      const body = (await nvGet(`/spdi/${encodeURIComponent(spdi)}/rsids`)) as { data?: { rsids?: number[] } };
      const rsids = body?.data?.rsids ?? [];
      return {
        source: 'NCBI Variation Services (dbSNP), https://api.ncbi.nlm.nih.gov/variation/v0/',
        input_spdi: spdi,
        rsid_count: rsids.length,
        rsids: rsids.map((r) => `rs${r}`),
        rsid_numbers: rsids,
        note: rsids.length ? undefined : 'No rsID is assigned to this exact SPDI allele. Check the assembly of seq_id and that the position is 0-based.',
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function refsnp(args: Record<string, unknown>): Promise<unknown> {
  const raw = reqStr(args, 'rsid', '"rs113488022"').trim();
  const num = raw.replace(/^rs/i, '');
  if (!/^\d+$/.test(num)) throw new Error(`"rsid" must be a dbSNP rsID such as "rs113488022" or "113488022". Got: ${raw}`);

  const wanted = String(args.assembly ?? 'GRCh38').trim();
  if (!/^GRCh3[78]/i.test(wanted)) {
    throw new Error(`"assembly" must be "GRCh38" or "GRCh37" (human genome build). Got: ${wanted}. Coordinates differ between builds, so this is not a cosmetic choice.`);
  }
  const maxFreq = Math.max(1, Math.min(500, Number(args.max_frequencies ?? 40)));

  const doc = (await nvGet(`/refsnp/${num}`)) as Record<string, unknown>;

  const merged = doc.merged_snapshot_data as { merged_into?: string[] } | undefined;
  const ps = doc.primary_snapshot_data as
    | { placements_with_allele?: Placement[]; allele_annotations?: Record<string, unknown>[]; variant_type?: string }
    | undefined;

  if (!ps && merged) {
    const into = (merged.merged_into ?? []).map((r) => `rs${r}`);
    return {
      source: 'NCBI Variation Services (dbSNP), https://api.ncbi.nlm.nih.gov/variation/v0/',
      rsid: `rs${num}`,
      status: 'merged',
      merged_into: into,
      note: `rs${num} is a retired rsID that dbSNP merged into ${into.join(', ') || 'another rsID'}. Re-query variation_refsnp with that rsID for the variant record.`,
      create_date: doc.create_date ?? null,
      last_update_date: doc.last_update_date ?? null,
    };
  }

  const placements = ps?.placements_with_allele ?? [];
  const assembliesAvailable = [...new Set(placements.flatMap(assemblyNamesOf))];

  const genomic = placements.filter((p) => p.placement_annot?.mol_type === 'genomic' && assemblyNamesOf(p).length > 0);
  const onWanted = genomic.filter((p) => assemblyNamesOf(p).some((a) => a.toUpperCase().startsWith(wanted.toUpperCase())));

  const genomic_placements = onWanted.map((p) => {
    const variants = (p.alleles ?? []).filter(isVariantAllele);
    const ref = (p.alleles ?? []).find((a) => !isVariantAllele(a));
    return {
      assembly: assemblyNamesOf(p).join(', '),
      seq_id: p.seq_id,
      is_primary_top_level: !!p.is_ptlp,
      position_0based: variants[0]?.allele?.spdi?.position ?? ref?.allele?.spdi?.position ?? null,
      position_1based_hgvs: (variants[0]?.allele?.spdi?.position ?? ref?.allele?.spdi?.position ?? -1) + 1 || null,
      reference_allele: ref?.allele?.spdi?.deleted_sequence ?? null,
      alternate_alleles: variants.map((a) => ({
        inserted_sequence: a.allele?.spdi?.inserted_sequence ?? '',
        hgvs: a.hgvs ?? null,
        spdi: spdiString(a.allele?.spdi),
      })),
    };
  });

  const hgvsOf = (molType: string, seqPrefix?: RegExp) =>
    [
      ...new Set(
        placements
          .filter((p) => p.placement_annot?.mol_type === molType && (!seqPrefix || seqPrefix.test(p.seq_id ?? '')))
          .flatMap((p) => (p.alleles ?? []).filter(isVariantAllele).map((a) => a.hgvs ?? ''))
          .filter(Boolean),
      ),
    ].slice(0, 60);

  const annotations = ps?.allele_annotations ?? [];
  const frequencies: Record<string, unknown>[] = [];
  const clinical: Record<string, unknown>[] = [];
  const genes = new Map<string, { locus: string; name: string; gene_id: number }>();

  for (const ann of annotations) {
    for (const f of (ann.frequency ?? []) as Record<string, unknown>[]) {
      const obs = f.observation as Spdi | undefined;
      const ac = Number(f.allele_count ?? 0);
      const tc = Number(f.total_count ?? 0);
      frequencies.push({
        study: f.study_name ?? null,
        study_version: f.study_version ?? null,
        allele: obs ? `${obs.deleted_sequence ?? ''}>${obs.inserted_sequence ?? ''}` : null,
        seq_id: obs?.seq_id ?? null,
        allele_count: ac,
        total_count: tc,
        allele_frequency: tc > 0 ? Number((ac / tc).toPrecision(6)) : null,
      });
    }
    for (const c of (ann.clinical ?? []) as Record<string, unknown>[]) {
      clinical.push({
        clinvar_accession: c.accession_version ?? null,
        clinical_significances: c.clinical_significances ?? [],
        disease_names: c.disease_names ?? [],
        review_status: c.review_status ?? null,
        origins: c.origins ?? [],
        last_evaluated_date: c.last_evaluated_date ?? null,
        collection_method: c.collection_method ?? [],
        citation_pubmed_ids: ((c.citations ?? []) as number[]).slice(0, 10),
      });
    }
    for (const aa of (ann.assembly_annotation ?? []) as Record<string, unknown>[]) {
      for (const g of (aa.genes ?? []) as Record<string, unknown>[]) {
        const locus = String(g.locus ?? '');
        if (locus && !genes.has(locus)) genes.set(locus, { locus, name: String(g.name ?? ''), gene_id: Number(g.id ?? 0) });
      }
    }
  }

  frequencies.sort((a, b) => Number(b.total_count ?? 0) - Number(a.total_count ?? 0));
  const citations = (doc.citations ?? []) as number[];

  return {
    source: 'NCBI Variation Services (dbSNP), https://api.ncbi.nlm.nih.gov/variation/v0/',
    rsid: `rs${num}`,
    status: 'live',
    variant_type: ps?.variant_type ?? null,
    assembly_requested: wanted,
    assemblies_available: assembliesAvailable,
    assembly_note:
      genomic_placements.length === 0
        ? `dbSNP has no genomic placement for rs${num} on ${wanted}. Available: ${assembliesAvailable.join(', ') || 'none'}. Coordinates differ between builds — re-ask with one of those rather than reading this as "variant not found".`
        : `Coordinates below are on ${wanted}. The same variant sits at DIFFERENT coordinates on the other build.`,
    genomic_placements,
    hgvs: {
      genomic: hgvsOf('genomic'),
      transcript: hgvsOf('rna'),
      protein: hgvsOf('protein'),
    },
    genes: [...genes.values()],
    mane_select_ids: doc.mane_select_ids ?? [],
    clinical_count: clinical.length,
    clinical,
    allele_frequency_count: frequencies.length,
    allele_frequencies: frequencies.slice(0, maxFreq),
    merged_from_rsids: ((doc.dbsnp1_merges ?? []) as { merged_rsid?: string }[]).map((m) => `rs${m.merged_rsid}`),
    citation_count: citations.length,
    citation_pubmed_ids: citations.slice(0, 25),
    create_date: doc.create_date ?? null,
    last_update_date: doc.last_update_date ?? null,
    last_update_build_id: doc.last_update_build_id ?? null,
  };
}

async function nvGet(path: string): Promise<unknown> {
  const res = await pwFetch(`${BASE}${path}`);
  if (res.status === 404) {
    throw new Error(`NCBI Variation Services: not found (${path}). Check the rsID/HGVS/SPDI and that the RefSeq accession carries a version suffix (e.g. NC_000007.14, not NC_000007).`);
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`NCBI Variation Services: ${res.status} ${body}`);
  }
  return res.json();
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  return v;
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
