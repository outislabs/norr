/** Per-browser conveniences (onboarding ticks). Never required: every read and write tolerates storage being unavailable. */
export function getFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(`norr:${key}`) === "1";
  } catch {
    return false;
  }
}

export function setFlag(key: string): void {
  try {
    window.localStorage.setItem(`norr:${key}`, "1");
  } catch {
    /* private window or blocked storage */
  }
}
