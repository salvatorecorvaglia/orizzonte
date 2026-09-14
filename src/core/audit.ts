/**
 * Vulnerability data from OSV.dev.
 *
 * OSV is the right source here because one API covers every ecosystem Orizzonte
 * supports, and `querybatch` lets a whole project be checked in a couple of
 * round-trips: the batch call returns only IDs, and we fetch full records for
 * the small subset that actually matched.
 */

import type { ProviderContext } from '../providers/provider.js';
import { providerFor } from '../providers/registry.js';
import { cacheKey, TTL } from './cache.js';
import type { ProjectGroup, Severity, Vulnerability } from './types.js';
import { sortBySeverity } from './vocabulary.js';

const OSV_API = 'https://api.osv.dev';
const MAX_BATCH = 500;

interface OsvBatchResponse {
  results: Array<{
    vulns?: Array<{ id: string }>;
    /**
     * Present when this query has more advisories than one page carried.
     * Re-issuing the query with it as `page_token` returns the next page.
     */
    next_page_token?: string;
  }>;
}

/**
 * Pages to follow for one query before giving up on the rest.
 *
 * A package with more advisories than this has bigger problems than a
 * truncated list, and an unbounded follow loop against a paging bug would keep
 * a scan running indefinitely.
 */
const MAX_PAGES = 5;

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  severity?: Array<{ type: string; score: string }>;
  database_specific?: { severity?: string };
  affected?: Array<{
    package?: { name?: string; ecosystem?: string };
    ranges?: Array<{
      type: string;
      events: Array<{ introduced?: string; fixed?: string }>;
    }>;
  }>;
}

/**
 * Decorates every dependency in `groups` with its known advisories, in place.
 *
 * Failures are swallowed on purpose: a missing audit should grey out a badge,
 * not break the dependency table.
 */
export async function auditDependencies(
  groups: ProjectGroup[],
  ctx: ProviderContext,
  signal?: AbortSignal,
): Promise<void> {
  // Build the query set, remembering which dependencies each query maps back to.
  interface Query {
    package: { name: string; ecosystem: string };
    version: string;
  }
  const queries: Query[] = [];
  const owners: Array<Array<{ group: ProjectGroup; index: number }>> = [];
  const seen = new Map<string, number>();

  for (const group of groups) {
    const provider = providerFor(group.ecosystem);
    const osvEcosystem = provider.osvEcosystem;
    if (!osvEcosystem) continue;

    group.dependencies.forEach((dep, index) => {
      // OSV matches on a concrete version; a range tells it nothing.
      const version = dep.installed;
      if (!version) return;

      const identity = `${osvEcosystem}|${dep.name}|${version}`;
      const existing = seen.get(identity);
      if (existing !== undefined) {
        owners[existing].push({ group, index });
        return;
      }

      seen.set(identity, queries.length);
      queries.push({
        package: { name: dep.name, ecosystem: osvEcosystem },
        version,
      });
      owners.push([{ group, index }]);
    });
  }

  if (queries.length === 0) return;

  // Batch, then fetch details only for the IDs that came back.
  const idsPerQuery: Array<string[]> = new Array(queries.length)
    .fill(null)
    .map(() => []);

  /*
   * `pageTokens` carries the batch forward: on the first pass every query is
   * asked plainly, and on each pass after it only the queries OSV said had
   * more results are re-asked, with the token it handed back.
   *
   * Following those tokens is what makes the list complete. Without it a
   * package with more advisories than fit in one page silently lost the
   * remainder — and a truncated advisory list reads exactly like a full one.
   */
  let pageTokens = new Map<number, string | undefined>(
    queries.map((_query, index) => [index, undefined]),
  );

  for (let page = 0; page < MAX_PAGES && pageTokens.size > 0; page++) {
    const pending = [...pageTokens.entries()];
    const nextTokens = new Map<number, string | undefined>();
    let failed = false;

    for (let offset = 0; offset < pending.length; offset += MAX_BATCH) {
      const slice = pending.slice(offset, offset + MAX_BATCH);
      try {
        const response = await ctx.http.postJson<OsvBatchResponse>(
          `${OSV_API}/v1/querybatch`,
          {
            queries: slice.map(([index, token]) =>
              token === undefined
                ? queries[index]
                : { ...queries[index], page_token: token },
            ),
          },
          { signal },
        );
        response.results.forEach((result, i) => {
          const queryIndex = slice[i]?.[0];
          if (queryIndex === undefined) return;
          for (const vuln of result.vulns ?? []) {
            idsPerQuery[queryIndex].push(vuln.id);
          }
          if (result.next_page_token) {
            nextTokens.set(queryIndex, result.next_page_token);
          }
        });
      } catch (error) {
        // An unreachable OSV greys out a badge; it does not break the table,
        // and it is not evidence that the registry data alongside it is stale.
        // An abort is different — that is the caller withdrawing the question.
        if (signal?.aborted) throw error;
        /*
         * Stop asking, but keep what earlier batches already answered. This
         * used to `return`, throwing away every advisory collected so far — so
         * one failing batch in the middle of a large workspace turned a
         * partial answer into no answer at all, with nothing to distinguish it
         * from "nothing is vulnerable".
         */
        failed = true;
        break;
      }
    }

    if (failed) break;
    pageTokens = nextTokens;
  }

  const uniqueIds = [...new Set(idsPerQuery.flat())];
  if (uniqueIds.length === 0) return;

  const details = await fetchVulnerabilities(uniqueIds, ctx, signal);

  idsPerQuery.forEach((ids, queryIndex) => {
    if (ids.length === 0) return;
    // Sorted at the source, so the drawer, the tree tooltip and anything added
    // later all present the worst advisory first without each deciding for
    // itself.
    const resolved = sortBySeverity(
      [...new Set(ids)]
        .map((id) => details.get(id))
        .filter((vuln): vuln is Vulnerability => vuln !== undefined),
    );
    if (resolved.length === 0) return;

    for (const owner of owners[queryIndex]) {
      owner.group.dependencies[owner.index].vulnerabilities = resolved;
    }
  });
}

async function fetchVulnerabilities(
  ids: string[],
  ctx: ProviderContext,
  signal?: AbortSignal,
): Promise<Map<string, Vulnerability>> {
  const result = new Map<string, Vulnerability>();

  // Bounded concurrency: advisory records are small but there can be many.
  const CONCURRENCY = 8;
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, ids.length) }, async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        const key = cacheKey('osv', 'vuln', id);

        const cached = ctx.cache.get<Vulnerability>(key);
        if (cached) {
          result.set(id, cached);
          continue;
        }

        try {
          const raw = await ctx.http.getJson<OsvVuln>(
            `${OSV_API}/v1/vulns/${id}`,
            { signal },
          );
          const vuln = toVulnerability(raw);
          result.set(id, vuln);
          await ctx.cache.set(key, vuln, TTL.audit);
        } catch {
          // A single missing advisory should not abort the audit.
        }
      }
    }),
  );

  return result;
}

function toVulnerability(raw: OsvVuln): Vulnerability {
  // Prefer the first fixed version any range reports — that is what the user
  // needs to upgrade to.
  let fixedVersion: string | undefined;
  for (const affected of raw.affected ?? []) {
    for (const range of affected.ranges ?? []) {
      for (const event of range.events) {
        if (event.fixed) {
          fixedVersion ??= event.fixed;
        }
      }
    }
  }

  return {
    id: raw.id,
    summary: raw.summary ?? raw.details?.slice(0, 200) ?? 'No summary provided',
    severity: deriveSeverity(raw),
    aliases: raw.aliases ?? [],
    fixedVersion,
    url: `https://osv.dev/vulnerability/${raw.id}`,
  };
}

/**
 * OSV reports severity two ways: a database-specific label, or a CVSS vector.
 * We prefer the label and fall back to computing the CVSS base score.
 */
function deriveSeverity(raw: OsvVuln): Severity {
  const label = raw.database_specific?.severity?.toLowerCase();
  if (
    label === 'critical' ||
    label === 'high' ||
    label === 'moderate' ||
    label === 'low'
  ) {
    return label;
  }
  if (label === 'medium') return 'moderate';

  const cvss = raw.severity?.find((entry) => entry.type.startsWith('CVSS'));
  if (cvss) {
    const score = parseCvssBaseScore(cvss.score);
    if (score !== undefined) {
      if (score >= 9) return 'critical';
      if (score >= 7) return 'high';
      if (score >= 4) return 'moderate';
      return 'low';
    }
  }

  // Nothing usable was reported. `moderate` is the honest middle: it does not
  // manufacture alarm, and it does not bury something that may be critical.
  return 'moderate';
}

/**
 * CVSS v3.x/v4.0 base score from OSV's `score` field.
 *
 * The field is nearly always a vector string, not a number, so reading it with
 * `Number()` alone meant every CVSS-only advisory silently landed on the
 * `moderate` default — including the critical ones.
 *
 * The full v3.1 base-score equation is implemented here (it is short, closed
 * form, and stable). v4.0 vectors have a different, much larger scoring table,
 * so those fall back to the qualitative severity their vector implies.
 */
export function parseCvssBaseScore(score: string): number | undefined {
  const numeric = Number(score);
  if (Number.isFinite(numeric)) return numeric;

  const metrics = new Map<string, string>();
  for (const part of score.split('/')) {
    const [key, value] = part.split(':');
    if (key && value) metrics.set(key, value);
  }

  const version = metrics.get('CVSS');
  if (!version) return undefined;
  // v2 vectors are unlabelled and long obsolete; v4 needs a different table.
  if (!version.startsWith('3')) return undefined;

  const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
  const AC: Record<string, number> = { L: 0.77, H: 0.44 };
  const UI: Record<string, number> = { N: 0.85, R: 0.62 };
  const CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };
  const scopeChanged = metrics.get('S') === 'C';
  // Privileges Required is scored differently when scope changes.
  const PR: Record<string, number> = scopeChanged
    ? { N: 0.85, L: 0.68, H: 0.5 }
    : { N: 0.85, L: 0.62, H: 0.27 };

  const av = AV[metrics.get('AV') ?? ''];
  const ac = AC[metrics.get('AC') ?? ''];
  const pr = PR[metrics.get('PR') ?? ''];
  const ui = UI[metrics.get('UI') ?? ''];
  const c = CIA[metrics.get('C') ?? ''];
  const i = CIA[metrics.get('I') ?? ''];
  const a = CIA[metrics.get('A') ?? ''];
  if ([av, ac, pr, ui, c, i, a].some((value) => value === undefined)) {
    return undefined;
  }

  const impactBase = 1 - (1 - c) * (1 - i) * (1 - a);
  if (impactBase <= 0) return 0;

  const impact = scopeChanged
    ? 7.52 * (impactBase - 0.029) - 3.25 * (impactBase - 0.02) ** 15
    : 6.42 * impactBase;
  const exploitability = 8.22 * av * ac * pr * ui;

  const raw = scopeChanged
    ? Math.min(1.08 * (impact + exploitability), 10)
    : Math.min(impact + exploitability, 10);

  // CVSS rounds up to one decimal place.
  return Math.ceil(raw * 10) / 10;
}
