/**
 * The numeric value of `vscode.ExtensionMode.Test`. Kept here so the decision below stays free of the `vscode`
 * module (and unit-testable); the integration tests assert it equals the real enum member.
 */
export const EXTENSION_MODE_TEST = 3;

/**
 * The API returned from activate() is for the integration tests only: any other installed extension could reach it
 * through `getExtension(...).exports` and reset the timer or start breaks. So it is exposed only when the extension
 * runs in Test mode, and activate() returns `undefined` in every other mode (Production, Development).
 */
export function exportsForMode<T>(extensionMode: number, api: T): T | undefined {
  return extensionMode === EXTENSION_MODE_TEST ? api : undefined;
}
