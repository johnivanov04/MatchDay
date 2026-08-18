import type { ReactNode } from 'react';
import { BrandLockup } from '@/components/ui/brand';

/**
 * The shell every public authentication screen sits in.
 *
 * Sign in, create account, forgot password and set password are one experience
 * split across four URLs, and before this they were four hand-built layouts
 * that had already started to drift. The turf wash and the chalk arc are the
 * one place in the product where the theme is allowed to be *seen* rather than
 * felt at 3%, so they belong to the whole set, not to whichever page was
 * written first.
 */
export function AuthScreen({
  title,
  description,
  children,
  footer,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main
      id="main"
      className="chalk-arc turf-stripes relative mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-6 py-12"
    >
      <header className="animate-rise flex flex-col items-start gap-4">
        <BrandLockup size={38} />
        <div className="flex flex-col gap-2">
          <h1 className="text-[1.75rem] font-bold leading-[1.15]">{title}</h1>
          {description === undefined ? null : (
            <p className="text-sm leading-relaxed text-secondary">{description}</p>
          )}
        </div>
      </header>

      <div
        className="animate-rise surface-panel flex flex-col gap-4 p-5"
        style={{ animationDelay: '60ms' }}
      >
        {children}
      </div>

      {footer === undefined ? null : <div className="text-sm text-muted">{footer}</div>}
    </main>
  );
}
