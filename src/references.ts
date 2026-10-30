/** Collect immutable object ids, including references embedded in old string tool results. */
export function objectReferences(value: unknown, result = new Set<string>(), seen = new Set<object>()): Set<string> {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/sha256:([a-f0-9]{64})(?![a-f0-9])/g)) result.add(match[1]);
  } else if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    if (value instanceof Map) for (const [k,v] of value) { objectReferences(k,result,seen); objectReferences(v,result,seen); }
    else if (value instanceof Set) for (const item of value) objectReferences(item,result,seen);
    else if (!ArrayBuffer.isView(value)) for (const item of Object.values(value)) objectReferences(item,result,seen);
  }
  return result;
}
