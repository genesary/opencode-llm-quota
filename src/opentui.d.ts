/**
 * The `@opentui/solid` functions the TUI part uses (signatures from 0.5.16).
 * The host provides the module at runtime; its full types are not a dependency.
 */
declare module "@opentui/solid" {
  export function createElement(tag: string): unknown;
  export function setProp<T>(node: unknown, name: string, value: T, prev?: T): T;
  export function insert<T>(
    parent: unknown,
    accessor: T | (() => T),
    marker?: unknown,
    initial?: unknown,
  ): unknown;
}
