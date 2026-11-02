// Integration fixture for an unresponsive disposable process.
await new Promise(() => setInterval(() => {}, 1000));
