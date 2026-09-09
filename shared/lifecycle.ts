/**
 * Lets the server entry release daemon-side resources without coupling its
 * cleanup function to the scheduler module's private timer.
 */
export type Teardown = () => void | Promise<void>;

export const lifecycle: { teardown: Teardown | null } = { teardown: null };
