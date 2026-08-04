/**
 * Test stub for the `server-only` package.
 *
 * `server-only` resolves to an empty module under the `react-server` export
 * condition and to a module that throws everywhere else — that throw is what
 * stops a Client Component from importing server code. Vitest runs under
 * neither condition, so importing a guarded module would fail for the wrong
 * reason.
 *
 * Aliasing to this empty module reproduces exactly what the real server runtime
 * does. It does not weaken the guarantee: `tests/unit/secret-hygiene.test.ts`
 * still asserts that every privileged module carries `import 'server-only'`,
 * and the production build resolves the real package.
 */
export {};
