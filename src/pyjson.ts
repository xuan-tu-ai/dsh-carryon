/**
 * Python's `json.dumps(value, indent=2)`, which carrycode uses to put records into the runtime roles' prompts.
 *
 * `JSON.stringify(value, null, 2)` already uses the same layout and separators; Python additionally escapes every
 * character outside printable ASCII (`ensure_ascii=True`), as `\uXXXX` per UTF-16 unit.
 *
 * @module dsh-carryon/pyjson
 */

/**
 * Serialize like Python's `json.dumps(value, indent=indent)`. Keys keep their insertion order.
 * @param value - JSON-ready value (no floats with fractional ambiguity, no `undefined`).
 * @param indent - spaces per level.
 * @returns the JSON text.
 */
export function pyJsonDumps(value: unknown, indent = 2): string {
  return JSON.stringify(value, null, indent).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}
