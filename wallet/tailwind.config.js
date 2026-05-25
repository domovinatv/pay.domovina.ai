/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          navy: {
            DEFAULT: '#002F6C',
            50: '#EAF1FB',
            100: '#CDDDF3',
            200: '#9BBCE7',
            300: '#6896D6',
            400: '#3D72BE',
            500: '#1F539F',
            600: '#0F3F84',
            700: '#002F6C',
            800: '#002554',
            900: '#001A3D',
          },
          red: {
            DEFAULT: '#FF0000',
            50: '#FFE5E5',
            100: '#FFB8B8',
            300: '#FF6B6B',
            500: '#FF0000',
            700: '#C20000',
          },
        },
        surface: {
          base: 'rgb(var(--surface-base) / <alpha-value>)',
          raised: 'rgb(var(--surface-raised) / <alpha-value>)',
          sunken: 'rgb(var(--surface-sunken) / <alpha-value>)',
          muted: 'rgb(var(--surface-muted) / <alpha-value>)',
          border: 'rgb(var(--surface-border) / <alpha-value>)',
        },
        // Brand-scoped tokens — values come from CSS variables set by
        // `applyBrandCss()` at app boot. The default-brand DOMOVINA palette
        // is identical to brand.navy / brand.red above; per-tenant builds
        // override these vars and the same Tailwind classes pick up the
        // new colors automatically.
        'brand-primary': 'rgb(var(--brand-primary) / <alpha-value>)',
        'brand-primary-fg': 'rgb(var(--brand-primary-fg) / <alpha-value>)',
        'brand-accent': 'rgb(var(--brand-accent) / <alpha-value>)',
        'brand-accent-fg': 'rgb(var(--brand-accent-fg) / <alpha-value>)',
        ink: {
          primary: 'rgb(var(--ink-primary) / <alpha-value>)',
          secondary: 'rgb(var(--ink-secondary) / <alpha-value>)',
          muted: 'rgb(var(--ink-muted) / <alpha-value>)',
          inverse: 'rgb(var(--ink-inverse) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        display: ['system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        pill: '9999px',
      },
      boxShadow: {
        card: '0 1px 0 0 rgb(0 0 0 / 0.04), 0 8px 24px -12px rgb(0 0 0 / 0.12)',
        elevated: '0 1px 0 0 rgb(0 0 0 / 0.04), 0 16px 40px -16px rgb(0 0 0 / 0.18)',
        glow: '0 0 0 4px rgb(0 47 108 / 0.12)',
      },
      transitionTimingFunction: {
        spring: 'cubic-bezier(.34,1.56,.64,1)',
      },
      transitionDuration: {
        250: '250ms',
        350: '350ms',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 200ms ease-out',
        'slide-up': 'slide-up 250ms cubic-bezier(.34,1.56,.64,1)',
        shimmer: 'shimmer 1.6s linear infinite',
      },
    },
  },
  plugins: [],
};
