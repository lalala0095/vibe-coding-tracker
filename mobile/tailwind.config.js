/** @type {import('tailwindcss').Config} */
module.exports = {
  // No custom palette on purpose. `front/` uses the stock Tailwind slate / violet /
  // indigo / blue scales, so the class names stay greppable across both codebases.
  content: ['./app/**/*.{js,jsx,ts,tsx}', './src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {},
  },
  plugins: [],
};
