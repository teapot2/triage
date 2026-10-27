// Tailwind through PostCSS, the setup Next supports natively. The custom
// @tailwindcss/turbopack loader rule it replaces left edits to globals.css
// (its @theme tokens) unserved until the dev server restarted.
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
