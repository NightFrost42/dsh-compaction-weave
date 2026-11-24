// Shared collection and plain-object helpers (zero internal dependencies).

/**
 * Return `true` when `value` is a non-null, non-array object.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Insert or refresh `key -> value` in `map`, evicting the oldest entry if `map.size > maxSize`.
 *
 * @param {Map<any, any> | null | undefined} map
 * @param {any} key
 * @param {any} value
 * @param {number} [maxSize=512]
 */
export function setBoundedMap(map, key, value, maxSize = 512) {
  if (!map) return;
  map.delete(key);
  map.set(key, value);
  while (map.size > maxSize) {
    map.delete(map.keys().next().value);
  }
}

/**
 * Insert or refresh `key` in `set`, evicting the oldest entry if `set.size > maxSize`.
 *
 * @param {Set<any> | null | undefined} set
 * @param {any} key
 * @param {number} [maxSize=512]
 */
export function addBoundedSet(set, key, maxSize = 512) {
  if (!set) return;
  set.delete(key);
  set.add(key);
  while (set.size > maxSize) {
    set.delete(set.values().next().value);
  }
}
