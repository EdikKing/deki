// Pure helpers for the image preview viewer. Kept dependency-free so they can be
// unit-tested in the Node test environment without React or DOM APIs.

export type ImagePreviewDirection = "prev" | "next";

export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  // NaN carries no usable position; fall back to the first index.
  // ±Infinity represent extreme positions, so let them flow through
  // the regular clamp branches instead of being treated as missing.
  if (Number.isNaN(index)) return 0;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return Math.trunc(index);
}

export function nextIndex(
  index: number,
  length: number,
  direction: ImagePreviewDirection,
): number {
  if (length <= 1) return clampIndex(index, length);
  const current = clampIndex(index, length);
  const delta = direction === "next" ? 1 : -1;
  return (current + delta + length) % length;
}

export function findStartIndex<T>(
  items: readonly T[],
  predicate: (item: T | undefined, index: number) => boolean,
  fallback = 0,
): number {
  for (let i = 0; i < items.length; i += 1) {
    if (predicate(items[i], i)) return i;
  }
  return clampIndex(fallback, items.length);
}
