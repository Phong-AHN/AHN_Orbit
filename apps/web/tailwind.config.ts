import type { Config } from 'tailwindcss';

/**
 * Every colour resolves through a CSS variable defined in
 * @orbit/ui/tokens.css. Nothing here hardcodes a value, so both themes stay in
 * step and a palette change is a one-file change (SRS §29 design tokens).
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}', './app/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: 'hsl(var(--canvas))',
        surface: {
          DEFAULT: 'hsl(var(--surface))',
          sunken: 'hsl(var(--surface-sunken))',
          raised: 'hsl(var(--surface-raised))',
        },
        ink: {
          DEFAULT: 'hsl(var(--ink))',
          secondary: 'hsl(var(--ink-secondary))',
          muted: 'hsl(var(--ink-muted))',
          inverse: 'hsl(var(--ink-inverse))',
        },
        line: {
          DEFAULT: 'hsl(var(--line))',
          strong: 'hsl(var(--line-strong))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          hover: 'hsl(var(--accent-hover))',
          soft: 'hsl(var(--accent-soft))',
          ink: 'hsl(var(--accent-ink))',
        },
        success: { DEFAULT: 'hsl(var(--success))', soft: 'hsl(var(--success-soft))' },
        warning: { DEFAULT: 'hsl(var(--warning))', soft: 'hsl(var(--warning-soft))' },
        danger: { DEFAULT: 'hsl(var(--danger))', soft: 'hsl(var(--danger-soft))' },
        info: { DEFAULT: 'hsl(var(--info))', soft: 'hsl(var(--info-soft))' },
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        lg: 'var(--radius-lg)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow)',
        lg: 'var(--shadow-lg)',
      },
      fontFamily: {
        sans: ['Segoe UI', 'system-ui', '-apple-system', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'Cascadia Mono', 'SF Mono', 'Consolas', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
