import type { Ecosystem } from '../types.js';
import { maxSatisfying } from '../versions/index.js';
import type { ForwardGraph, GraphNode } from './types.js';

export interface GraphReference {
  name: string;
  version?: string;
  constraint?: string;
  source?: string;
  id?: string;
}
export interface GraphRecord extends Omit<GraphNode, 'children'> {
  source?: string;
  dependencies: GraphReference[];
}

export function resolutionId(
  name: string,
  version?: string,
  source?: string,
): string {
  return JSON.stringify([name, version ?? null, source ?? null]);
}

/** Ambiguous edges remain partial leaves instead of merging unrelated resolutions. */
export function buildResolutionGraph(
  records: GraphRecord[],
  ecosystem: Ecosystem,
): ForwardGraph {
  const counts = new Map<string, number>();
  for (const record of records)
    counts.set(record.id, (counts.get(record.id) ?? 0) + 1);
  records = records.map((record, index) =>
    counts.get(record.id)! > 1
      ? { ...record, id: `${record.id}:instance:${index}` }
      : record,
  );
  const graph: ForwardGraph = new Map();
  const byName = new Map<string, GraphRecord[]>();
  for (const record of records) {
    graph.set(record.id, {
      ...record,
      truncated:
        record.truncated || (!record.root && record.version === undefined),
      children: [],
    });
    const siblings = byName.get(record.name) ?? [];
    siblings.push(record);
    byName.set(record.name, siblings);
  }
  for (const record of records) {
    const parent = graph.get(record.id)!;
    record.dependencies.forEach((ref, index) => {
      let child: string | undefined;
      if (ref.id !== undefined) {
        if (graph.has(ref.id)) child = ref.id;
      } else {
        const candidates = (byName.get(ref.name) ?? []).filter(
          (node) =>
            (ref.version === undefined || node.version === ref.version) &&
            (ref.source === undefined || node.source === ref.source) &&
            (ref.constraint === undefined ||
              !node.version ||
              maxSatisfying(ecosystem, [node.version], ref.constraint) ===
                node.version),
        );
        if (candidates.length === 1) child = candidates[0].id;
      }
      if (child === undefined) {
        child = ref.id ?? `unresolved:${record.id}:${index}`;
        graph.set(child, {
          id: child,
          name: ref.name,
          version: ref.version,
          children: [],
          truncated: true,
        });
      }
      if (!parent.children.includes(child)) parent.children.push(child);
    });
  }
  return graph;
}
