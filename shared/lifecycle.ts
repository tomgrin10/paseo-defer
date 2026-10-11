/**
 * Lets the entry point release daemon-side resources without naming them.
 *
 * The v0.8 server entry owns daemon teardown while the engine fills this slot.
 */
export type Teardown = () => void | Promise<void>;

export const lifecycle: { teardown: Teardown | null; refreshLabels: (() => Promise<void>) | null } = {
  teardown: null,
  refreshLabels: null,
};
