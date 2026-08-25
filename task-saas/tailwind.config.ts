import type { Config } from "tailwindcss";

/**
 * Design tokens.
 *
 * Before this, every component hardcoded its own radius, shadow and color —
 * `rounded-[6px]` here, `rounded-lg` there, a dozen one-off `shadow-sm`s, an accent
 * color that appeared exactly once (`selection:bg-blue-100` on the landing page and
 * nowhere else). Nothing tied those choices together, so "improve the UI" had no
 * shared vocabulary to improve. These tokens are that vocabulary — components should
 * reach for `accent-*`, `shadow-elevated`/`shadow-dropdown`, and `rounded-card` instead
 * of inventing another one-off value.
 *
 * Kept intentionally close to the app's existing light, neutral palette rather than
 * imposing a new visual identity — the goal is polish, not a redesign nobody asked for.
 */
const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      colors: {
        /**
         * Indigo, not Tailwind's stock `blue`. The one existing accent reference
         * (`selection:bg-blue-100`) used the default palette, which is also every
         * Bootstrap/Tailwind starter's default — the "no generic stock colors" the
         * design skill calls out. Same hue family, just not the exact default swatch.
         */
        accent: {
          50: "#eef2ff",
          100: "#e0e7ff",
          200: "#c7d2fe",
          300: "#a5b4fc",
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5",
          700: "#4338ca",
          800: "#3730a3",
          900: "#312e81",
        },
      },
      borderRadius: {
        // A named scale so "which radius" is a choice, not a guess re-made per file.
        card: "10px",
        dialog: "14px",
      },
      boxShadow: {
        /**
         * Layered — a tight contact shadow plus a soft ambient one — rather than the
         * single flat `shadow-sm`/`shadow-lg` used everywhere before. This is what
         * actually reads as "depth" instead of "a gray outline."
         */
        elevated: "0 1px 2px rgba(15, 23, 42, 0.04), 0 4px 16px rgba(15, 23, 42, 0.06)",
        dropdown: "0 2px 4px rgba(15, 23, 42, 0.04), 0 12px 32px rgba(15, 23, 42, 0.10)",
        // For the composer / anything docked to a viewport edge, where the shadow
        // should read upward rather than surround the element.
        "elevated-up": "0 -1px 2px rgba(15, 23, 42, 0.04), 0 -8px 24px rgba(15, 23, 42, 0.05)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        // Deliberately short and ease-out, and every caller composes it with
        // `motion-reduce:animate-none` — see the components that use it.
        "fade-in": "fade-in 150ms ease-out",
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
};
export default config;
