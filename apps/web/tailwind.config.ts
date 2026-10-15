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
        /**
         * Both resolve through a token, so the fallback stack lives in one
         * place and `next/font` only has to supply the variable.
         *
         * `display` is Fraunces — a variable serif with real optical sizing,
         * used for headings and for the one number on a screen that matters.
         * `sans` is Source Sans 3 for everything read at length. They are from
         * different families on purpose: a high-contrast serif beside a
         * neutral humanist sans is a distinction a reader can feel, which a
         * single family at two weights never is.
         */
        display: ['var(--font-display)', 'Georgia', 'serif'],
        sans: ['var(--font-body)', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'Cascadia Mono', 'SF Mono', 'Consolas', 'Menlo', 'monospace'],
      },

      /**
       * A scale, so sizes are chosen from a set rather than invented per
       * component. The display sizes carry tighter tracking because Fraunces
       * sets wide at large sizes.
       */
      fontSize: {
        'display-lg': ['2.25rem', { lineHeight: '1.1', letterSpacing: '-0.02em' }],
        display: ['1.75rem', { lineHeight: '1.15', letterSpacing: '-0.015em' }],
        'display-sm': ['1.3125rem', { lineHeight: '1.25', letterSpacing: '-0.01em' }],
      },

      maxWidth: {
        /**
         * Running text under 80 characters (SRS §29, Bringhurst).
         *
         * **The only width cap left, and the one that has to stay.** A page
         * inside the sidebar shell no longer caps itself at all — it fills the
         * content column — so the thing that stops a paragraph becoming a
         * 1600px line is this, applied to the paragraph rather than to the
         * page. `PageHeader` and `MessageState` already carry it, which is why
         * removing the page caps did not produce unreadable prose.
         */
        measure: 'var(--measure)',
      },
    },
  },
  plugins: [],
};

export default config;
