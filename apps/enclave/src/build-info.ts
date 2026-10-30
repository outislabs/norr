import { execFileSync } from "node:child_process";

export interface BuildInfo {
  /** Full git commit hash the running code was built from, or null if it cannot be determined. */
  commit: string | null;
  /** True when the working tree has changes that are not in that commit. Always false for NORR_COMMIT. */
  dirty: boolean;
  /** Where the hash came from: the build (NORR_COMMIT, set when the container image is built) or the local git checkout. */
  source: "env" | "git" | "unknown";
}

const git = (args: string[]): string | null => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim();
  } catch {
    return null;
  }
};

/**
 * The code version the service reports on the Verify screen. A deployed image sets NORR_COMMIT at build
 * time; a local run reads the git checkout and says when it has uncommitted changes, because then
 * the hash does not describe the code that is running.
 */
export function resolveBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const fromEnv = env.NORR_COMMIT?.trim();
  if (fromEnv) return { commit: fromEnv, dirty: false, source: "env" };
  const commit = git(["rev-parse", "HEAD"]);
  if (!commit) return { commit: null, dirty: false, source: "unknown" };
  return { commit, dirty: (git(["status", "--porcelain", "--untracked-files=no"]) ?? "") !== "", source: "git" };
}
