import type { ReactNode } from "react";

/** A hash-route link. Plain anchor: routing is hash-based, so there is nothing to intercept. */
export function Link({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return (
    <a href={href} className={className}>
      {children}
    </a>
  );
}
