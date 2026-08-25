/**
 * Lets the entry point release daemon-side resources without naming them.
 *
 * Paseo deletes `*.server` imports from the client bundle but keeps the
 * surrounding statements, so a server identifier in `contribute()`'s shared
 * body becomes a ReferenceError that aborts every registration. A shared
 * module is safe in both bundles: `engine.server` fills this in on the daemon,
 * and it stays null in the client, where there is nothing to release.
 */
export type Teardown = () => void | Promise<void>;

export const lifecycle: { teardown: Teardown | null } = { teardown: null };
