/** @type {import('tailwindcss').Config} */
// Palette and fonts match dmiflow.com: ink backgrounds, amber accent, green "live" signal.
module.exports = {
  content: ["./views/**/*.ejs"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['"Space Grotesk"', 'Inter', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        // Amber (dmiflow.com --amber #FF8A2B / --amber2 #FFB16A)
        brand: {
          50: '#FFF4EA',
          100: '#FFE4CC',
          200: '#FFC999',
          300: '#FFB16A',
          400: '#FF9D47',
          500: '#FF8A2B',
          600: '#F07413',
          700: '#C75C0C',
          800: '#9A470D',
          900: '#6E3410',
        },
        // Ink neutrals (dmiflow.com --ink, --panel, --text, --dim, --faint)
        surface: {
          50: '#F7F9FB',
          100: '#EEF2F7',
          200: '#D5DCE5',
          300: '#B4BFCC',
          400: '#909DAD',
          500: '#6B7888',
          600: '#4A5563',
          700: '#2A3340',
          800: '#1A222D',
          900: '#141A23',
          950: '#0A0D12',
        },
        // Green "live" signal (dmiflow.com --green #2FE08A)
        emerald: {
          50: '#E9FCF3',
          100: '#C9F8E2',
          200: '#9EF2CA',
          300: '#73F0B0',
          400: '#2FE08A',
          500: '#22C97A',
          600: '#16A863',
          700: '#12844F',
          800: '#10673F',
          900: '#0D5233',
        },
      },
      boxShadow: {
        amber: '0 16px 42px rgba(255,138,43,.32)',
      },
    },
  },
  plugins: [],
}
