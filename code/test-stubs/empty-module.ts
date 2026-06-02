// Empty stub aliased for the `server-only` / `client-only` marker packages
// in vitest (see vitest.config.ts resolve.alias).
//
// Those packages are build-time-only no-op markers: their whole purpose is
// to make a bundler ERROR if server code is pulled into a client bundle (or
// vice-versa). The real `server-only` resolves its `default` export to a
// module that THROWS unless the resolver sets the `react-server` condition
// — which the Next.js build does, but plain node/vitest does not. So when a
// test imports server-component code that does `import 'server-only'`, it
// would throw "cannot be imported from a Client Component".
//
// Resolving them to this empty module in the test env makes the marker a
// genuine no-op (its runtime semantics), so unit/adversarial tests can
// import the real server modules under test. The production build is
// unaffected — Next.js supplies its own internal alias for these.
export {};
