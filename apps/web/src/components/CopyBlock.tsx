import { useState } from "react";

/** A code block with a copy button. Clipboard access can be refused (insecure context, permissions): then the text stays selectable. */
export function CopyBlock({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div>
      <pre tabIndex={0} aria-label={label} className="mono overflow-x-auto whitespace-pre border border-line bg-vault p-3 text-sm">{text}</pre>
      <button
        type="button"
        className="btn btn-quiet mt-2 min-h-10 px-4 py-1 text-sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setState("copied");
          } catch {
            setState("failed");
          }
        }}
      >
        {state === "copied" ? "Copied" : state === "failed" ? "Select and copy" : "Copy"}
      </button>
    </div>
  );
}
