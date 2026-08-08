# node-wallet

A working Orbinum wallet in Node: unlock, scan, read the balance.

```bash
pnpm install
pnpm start
```

It imports only `@orbinum/sdk` and `@orbinum/sdk/worker` — no deep import into
`dist/`. That is the point: it runs in the SDK's CI, so a broken exports map or
an accidental browser dependency fails the build rather than reaching a user.

The commitment feed is a fixture, so the example runs offline. A real host
implements the same `ScanHintSource` and `NullifierSource` interfaces over its
own backend.
