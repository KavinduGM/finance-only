/** @type {import('tailwindcss').Config} */

// Every colour is a CSS variable (see src/index.css), so the dark and light
// themes share the same class names and opacity modifiers keep working.
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: token('bg'),
        surface: { DEFAULT: token('surface'), 2: token('surface-2'), 3: token('surface-3') },
        line: { DEFAULT: token('line'), strong: token('line-strong') },
        ink: { DEFAULT: token('ink'), 2: token('ink-2'), 3: token('ink-3') },
        accent: { DEFAULT: token('accent'), ink: token('accent-ink') },
        good: token('good'),
        warn: token('warn'),
        bad: token('bad'),
        info: token('info'),
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      boxShadow: {
        card: '0 1px 2px rgb(0 0 0 / 0.06)',
        pop: '0 16px 48px -12px rgb(0 0 0 / 0.45), 0 0 0 1px rgb(var(--line) / 1)',
        glow: '0 0 0 1px rgb(var(--accent) / 0.35), 0 8px 24px -8px rgb(var(--accent) / 0.45)',
      },
      keyframes: {
        'fade-up': { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
      },
      animation: {
        'fade-up': 'fade-up 0.25s ease-out backwards',
        'fade-in': 'fade-in 0.15s ease-out backwards',
      },
    },
  },
  plugins: [],
}
