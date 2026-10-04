/** Centered card on the app backdrop, used by the sign-in and password screens. */
export default function AuthShell({ title, subtitle, children }: {
  title: string
  subtitle?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen app-backdrop flex items-center justify-center p-4">
      <div className="w-full max-w-sm animate-fade-up">
        <div className="flex items-center gap-3 mb-6">
          <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-accent/10 border border-accent/25">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.25"
              strokeLinecap="round" strokeLinejoin="round" className="text-accent">
              <path d="M4 17l5-5 4 3 7-8" />
            </svg>
          </span>
          <div className="leading-tight">
            <p className="text-base font-semibold text-ink">GroovyMark</p>
            <p className="text-2xs uppercase tracking-[0.16em] text-ink-3">Finance</p>
          </div>
        </div>

        <div className="card p-6">
          <h1 className="text-lg font-semibold tracking-tight text-ink">{title}</h1>
          {subtitle && <p className="text-sm text-ink-3 mt-1">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
      </div>
    </div>
  )
}
