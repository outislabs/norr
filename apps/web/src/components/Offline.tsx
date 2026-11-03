const README_VERIFY = "https://github.com/outislabs/norr#verify-it-yourself";
const linkClass = "text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg";

/**
 * Shown when the service cannot be reached. The demo engine runs on demand, so this is a normal state and is
 * worded calmly. It does not offer a "last attestation": an attestation is only meaningful fresh, from the
 * running service, so the honest fallback is the public code and the published way to check it.
 */
export function Offline({ onVerifyPage = false, compact = false }: { onVerifyPage?: boolean; compact?: boolean }) {
  return (
    <div role="status" className="border-l border-line-strong pl-4">
      <p className="flex items-center gap-2 text-sm text-fg">
        <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full border border-mute" />
        Norr is offline right now.
      </p>
      {compact ? (
        <p className="mt-1 text-sm text-mute">The engine runs on demand.</p>
      ) : (
        <p className="mt-1 text-sm text-mute">
          The engine runs on demand, so it is switched off between sessions.{" "}
          {onVerifyPage ? "When it is back, this page asks it for a fresh attestation and checks it here." : <>When it is back, <a href="#/verify" className={linkClass}>Verify</a> checks its attestation in your browser.</>}{" "}
          Meanwhile the code and the exact image it runs are public: <a href={README_VERIFY} className={linkClass}>how to verify it</a>.
        </p>
      )}
    </div>
  );
}
