/** Read the released DSH title snapshot without ever coercing an object to text. */
export function titleText(value: unknown, fallback = '未命名对话'): string {
  const candidate = typeof value === 'string'
    ? value
    : value !== null && typeof value === 'object' && 'title' in value && typeof value.title === 'string'
      ? value.title
      : undefined;
  return candidate?.trim() || fallback;
}
