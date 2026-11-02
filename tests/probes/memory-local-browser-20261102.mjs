process.env.NORTHSTAR_MEMORY_CHAIN='1';
process.env.NORTHSTAR_MEMORY_BROWSER='1';
await import('../regression/source-http-sdk-integration-test.mjs');
