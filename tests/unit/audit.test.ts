/**
 * OSV advisory handling: severity derivation and the batch-to-dependency
 * mapping that decides which rows light up.
 */

import { describe, expect, it, vi } from 'vitest';
import { auditDependencies, parseCvssBaseScore } from '../../src/core/audit.js';
import type { Dependency, ProjectGroup } from '../../src/core/types.js';
import { makeContext } from './helpers.js';

describe('parseCvssBaseScore', () => {
  /*
   * These vectors and their scores are from the CVSS v3.1 specification's own
   * examples, so the arithmetic is checked against the standard rather than
   * against this implementation's output.
   */
  it('computes v3.1 base scores from a vector string', () => {
    expect(
      parseCvssBaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'),
    ).toBe(9.8);
    expect(
      parseCvssBaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N'),
    ).toBe(7.5);
    // Impact 6.42 x 0.22 = 1.4124, exploitability 8.22 x 0.55 x 0.44 x 0.27 x
    // 0.62 = 0.333; sum 1.745, rounded up to one decimal.
    expect(
      parseCvssBaseScore('CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N'),
    ).toBe(1.8);
  });

  it('applies the changed-scope formula, which is not a multiplier', () => {
    // Scope change alters both the PR weights and the final rounding path.
    expect(
      parseCvssBaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H'),
    ).toBe(10);
    expect(
      parseCvssBaseScore('CVSS:3.0/AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:L/A:N'),
    ).toBe(6.4);
  });

  it('scores a vector with no impact as zero', () => {
    expect(
      parseCvssBaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N'),
    ).toBe(0);
  });

  it('accepts a plain numeric score', () => {
    expect(parseCvssBaseScore('7.5')).toBe(7.5);
  });

  it('declines vectors it cannot score rather than guessing', () => {
    // v4.0 uses a lookup table, not this equation.
    expect(
      parseCvssBaseScore('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H'),
    ).toBeUndefined();
    expect(parseCvssBaseScore('AV:N/AC:L/Au:N/C:P/I:P/A:P')).toBeUndefined();
    expect(parseCvssBaseScore('nonsense')).toBeUndefined();
    expect(
      parseCvssBaseScore('CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'),
    ).toBeUndefined();
  });
});

/** Builds a group whose single dependency has a resolved version. */
function groupWith(deps: Array<Partial<Dependency>>): ProjectGroup {
  return {
    label: 'app',
    manifestPath: '/p/package.json',
    ecosystem: 'node',
    toolchain: 'npm',
    dependencies: deps.map((dep, index) => ({
      key: `k${index}`,
      name: `pkg${index}`,
      ecosystem: 'node' as const,
      scope: 'prod' as const,
      declared: '1.0.0',
      installed: '1.0.0',
      updateKind: 'none' as const,
      vulnerabilities: [],
      manifestPath: '/p/package.json',
      projectLabel: 'app',
      ...dep,
    })),
  };
}

/** A ProviderContext whose http returns scripted OSV responses. */
function auditContext(responses: {
  batch?: unknown;
  vulns?: Record<string, unknown>;
}) {
  const ctx = makeContext();
  const postJson = vi.fn((_url: string, _body: unknown) =>
    Promise.resolve(responses.batch ?? {}),
  );
  const getJson = vi.fn((url: string) => {
    const id = url.split('/').pop() ?? '';
    const record = responses.vulns?.[id];
    return record
      ? Promise.resolve(record)
      : Promise.reject(new Error('not found'));
  });

  return {
    ctx: {
      ...ctx,
      http: { ...ctx.http, postJson, getJson } as never,
    },
    postJson,
    getJson,
  };
}

describe('auditDependencies', () => {
  it('orders advisories worst-first, whatever order OSV answered in', async () => {
    /*
     * OSV returns advisories in its own order. Sorting here rather than in the
     * drawer is what also fixes the tree tooltip, which shows the first three —
     * and used to mean the first three OSV happened to list, not the worst.
     */
    const groups = [groupWith([{ name: 'lodash' }])];
    const advisory = (id: string, severity: string) => ({
      id,
      summary: `${severity} issue`,
      database_specific: { severity },
    });
    const { ctx } = auditContext({
      batch: {
        results: [
          { vulns: [{ id: 'LOW-1' }, { id: 'CRIT-1' }, { id: 'MOD-1' }] },
        ],
      },
      vulns: {
        'LOW-1': advisory('LOW-1', 'LOW'),
        'CRIT-1': advisory('CRIT-1', 'CRITICAL'),
        'MOD-1': advisory('MOD-1', 'MODERATE'),
      },
    });

    await auditDependencies(groups, ctx);

    expect(
      groups[0].dependencies[0].vulnerabilities.map((v) => v.severity),
    ).toEqual(['critical', 'moderate', 'low']);
  });

  it('decorates the dependency an advisory matches', async () => {
    const groups = [groupWith([{ name: 'lodash' }])];
    const { ctx } = auditContext({
      batch: { results: [{ vulns: [{ id: 'GHSA-1' }] }] },
      vulns: {
        'GHSA-1': {
          id: 'GHSA-1',
          summary: 'Prototype pollution',
          aliases: ['CVE-2020-1'],
          database_specific: { severity: 'HIGH' },
          affected: [
            { ranges: [{ type: 'SEMVER', events: [{ fixed: '2.0' }] }] },
          ],
        },
      },
    });

    await auditDependencies(groups, ctx);

    const [dep] = groups[0].dependencies;
    expect(dep.vulnerabilities).toHaveLength(1);
    expect(dep.vulnerabilities[0]).toMatchObject({
      id: 'GHSA-1',
      severity: 'high',
      fixedVersion: '2.0',
      aliases: ['CVE-2020-1'],
    });
  });

  it('derives severity from a CVSS vector when no label is given', async () => {
    // The case that used to collapse to "moderate" for everything.
    const groups = [groupWith([{ name: 'lodash' }])];
    const { ctx } = auditContext({
      batch: { results: [{ vulns: [{ id: 'GHSA-2' }] }] },
      vulns: {
        'GHSA-2': {
          id: 'GHSA-2',
          summary: 'Remote code execution',
          severity: [
            {
              type: 'CVSS_V3',
              score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
            },
          ],
        },
      },
    });

    await auditDependencies(groups, ctx);
    expect(groups[0].dependencies[0].vulnerabilities[0].severity).toBe(
      'critical',
    );
  });

  it('queries each name/version pair once and fans the result back out', async () => {
    // The same package in two projects is one query and two decorated rows.
    const groups = [
      groupWith([{ name: 'lodash' }]),
      { ...groupWith([{ name: 'lodash' }]), manifestPath: '/q/package.json' },
    ];
    const { ctx, postJson } = auditContext({
      batch: { results: [{ vulns: [{ id: 'GHSA-3' }] }] },
      vulns: {
        'GHSA-3': { id: 'GHSA-3', summary: 'x', database_specific: {} },
      },
    });

    await auditDependencies(groups, ctx);

    const body = postJson.mock.calls[0][1] as { queries: unknown[] };
    expect(body.queries).toHaveLength(1);
    expect(groups[0].dependencies[0].vulnerabilities).toHaveLength(1);
    expect(groups[1].dependencies[0].vulnerabilities).toHaveLength(1);
  });

  it('skips dependencies with no resolved version, which OSV cannot match', async () => {
    const groups = [groupWith([{ name: 'lodash', installed: undefined }])];
    const { ctx, postJson } = auditContext({ batch: { results: [] } });

    await auditDependencies(groups, ctx);
    expect(postJson).not.toHaveBeenCalled();
  });

  it('leaves the table intact when OSV is unreachable', async () => {
    const groups = [groupWith([{ name: 'lodash' }])];
    const ctx = makeContext();

    // A failing audit must not reject: it greys out a badge, nothing more.
    await expect(auditDependencies(groups, ctx)).resolves.toBeUndefined();
    expect(groups[0].dependencies[0].vulnerabilities).toEqual([]);
  });
});

describe('auditDependencies batching', () => {
  /** A context whose batch endpoint answers differently on each call. */
  function scriptedBatches(
    batches: Array<unknown | (() => never)>,
    vulns: Record<string, unknown> = {},
  ) {
    const ctx = makeContext();
    const bodies: unknown[] = [];
    let call = 0;
    const postJson = vi.fn((_url: string, body: unknown) => {
      bodies.push(body);
      const next = batches[call++];
      if (typeof next === 'function') {
        return Promise.reject(new Error('OSV unreachable'));
      }
      return Promise.resolve(next ?? { results: [] });
    });
    const getJson = vi.fn((url: string) => {
      const id = url.split('/').pop() ?? '';
      const record = vulns[id];
      return record
        ? Promise.resolve(record)
        : Promise.reject(new Error('not found'));
    });
    return {
      ctx: { ...ctx, http: { ...ctx.http, postJson, getJson } as never },
      bodies,
      postJson,
    };
  }

  const advisory = (id: string) => ({
    id,
    summary: `${id} issue`,
    database_specific: { severity: 'high' },
  });

  it('follows next_page_token so a long advisory list is not truncated', async () => {
    /*
     * OSV pages `querybatch` per query. The token used to be ignored entirely,
     * so a package with more advisories than one page carried silently lost the
     * rest — and a short list of advisories reads exactly like a complete one.
     */
    const groups = [groupWith([{ name: 'lodash' }])];
    const { ctx, bodies } = scriptedBatches(
      [
        { results: [{ vulns: [{ id: 'A-1' }], next_page_token: 'page-2' }] },
        { results: [{ vulns: [{ id: 'A-2' }] }] },
      ],
      { 'A-1': advisory('A-1'), 'A-2': advisory('A-2') },
    );

    await auditDependencies(groups, ctx, undefined);

    // The second call re-asks only the query that had more, carrying its token.
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual({
      queries: [
        {
          package: { name: 'lodash', ecosystem: 'npm' },
          version: '1.0.0',
          page_token: 'page-2',
        },
      ],
    });
    expect(
      groups[0].dependencies[0].vulnerabilities.map((vuln) => vuln.id),
    ).toEqual(['A-1', 'A-2']);
  });

  it('keeps advisories already collected when a later page fails', async () => {
    /*
     * This used to `return`, discarding everything gathered so far. One failing
     * request in the middle of a large workspace turned a partial answer into
     * no answer, indistinguishable from "nothing is vulnerable".
     */
    const groups = [groupWith([{ name: 'lodash' }])];
    const { ctx } = scriptedBatches(
      [
        { results: [{ vulns: [{ id: 'A-1' }], next_page_token: 'page-2' }] },
        () => {
          throw new Error('unreachable');
        },
      ],
      { 'A-1': advisory('A-1') },
    );

    await auditDependencies(groups, ctx, undefined);

    expect(
      groups[0].dependencies[0].vulnerabilities.map((vuln) => vuln.id),
    ).toEqual(['A-1']);
  });

  it('stops following pages rather than looping forever', async () => {
    // A server that always claims there is more must not keep a scan running.
    const groups = [groupWith([{ name: 'lodash' }])];
    const { ctx, postJson } = scriptedBatches(
      Array.from({ length: 20 }, () => ({
        results: [{ vulns: [], next_page_token: 'always-more' }],
      })),
    );

    await auditDependencies(groups, ctx, undefined);

    expect(postJson.mock.calls.length).toBeLessThanOrEqual(5);
  });
});

describe('advisories with no readable severity', () => {
  /** Audits one package against one advisory and returns the decorated entry. */
  async function auditOne(vuln: Record<string, unknown>) {
    const groups = [groupWith([{ name: 'lodash' }])];
    const { ctx } = auditContext({
      batch: { results: [{ vulns: [{ id: vuln.id as string }] }] },
      vulns: { [vuln.id as string]: vuln },
    });

    await auditDependencies(groups, ctx);
    return groups[0].dependencies[0].vulnerabilities[0];
  }

  it('marks a CVSS v4-only advisory as unreported rather than plain moderate', async () => {
    // v4 has no closed-form base score, so it lands on the conservative
    // default. Presenting that as an ordinary "moderate" is how a critical
    // advisory reads as routine.
    const vuln = await auditOne({
      id: 'GHSA-v4',
      summary: 'Something serious',
      severity: [
        {
          type: 'CVSS_V4',
          score: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H',
        },
      ],
    });

    expect(vuln?.severity).toBe('moderate');
    expect(vuln?.severityUnknown).toBe(true);
  });

  it('does not mark a severity the advisory actually stated', async () => {
    const vuln = await auditOne({
      id: 'GHSA-v3',
      summary: 'Scored',
      severity: [
        {
          type: 'CVSS_V3',
          score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
        },
      ],
    });

    expect(vuln?.severity).toBe('critical');
    expect(vuln?.severityUnknown).toBeUndefined();
  });

  it('does not mark a database-specific label either', async () => {
    const vuln = await auditOne({
      id: 'GHSA-label',
      summary: 'Labelled',
      database_specific: { severity: 'HIGH' },
    });

    expect(vuln?.severity).toBe('high');
    expect(vuln?.severityUnknown).toBeUndefined();
  });
});
