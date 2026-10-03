// Any accidental API or RPC call fails the offline suite immediately.
globalThis.fetch = (() => { throw new Error("Network disabled in offline tests"); }) as unknown as typeof fetch;
