/**
 * Dashboard tests wait for UI to appear (testing-library's findBy and waitFor give up after 1 second by default). On a slow
 * or busy machine, such as a reviewer's laptop running `pnpm judge` while it does other work, that is too short. This
 * only lengthens how long a test waits for something that does appear; a wrong result still fails at once.
 */
if (typeof document !== "undefined") {
  const { configure } = await import("@testing-library/react");
  configure({ asyncUtilTimeout: 10_000 });
}
