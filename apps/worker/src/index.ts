/**
 * The worker's real entrypoint.
 *
 * It exists to set two environment variables *before* anything else is loaded.
 * ESM hoists `import` statements above all other statements in a module, so
 * assigning them at the top of `main.ts` would still run too late — pino fixes
 * its base fields when the logger module is first evaluated, and
 * `assertWorkerProcess` reads the role at import time.
 *
 * A dynamic `import()` after the assignments is the only ordering that
 * actually works. The Dockerfile and the npm scripts set both as well; this is
 * the belt to their braces, and what makes `node apps/worker/dist/index.js`
 * behave identically to the container.
 */

// Distinguishes the worker's log lines from the web app's in CloudWatch.
process.env.ORBIT_SERVICE ??= 'worker';

// Read by `assertWorkerProcess`. Only this process may consume jobs.
process.env.ORBIT_ROLE ??= 'worker';

const { start } = await import('./main.js');

await start();
