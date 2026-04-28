/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
      },
      colors: {
        bg: {
          0: '#08080b',
          1: '#0d0d11',
          2: '#12121a',
        },
        fg: {
          0: '#f0f0f5',
          1: '#a8a8b3',
          2: '#6b6b75',
          dim: '#8a8a96',
        },
        border: {
          0: '#1f1f25',
          1: '#2a2a32',
        },
        accent: {
          green: '#4ade80',
          cyan: '#22d3ee',
        },
        status: {
          ok: '#4ade80',
          warn: '#fbbf24',
          bad: '#f87171',
          info: '#a78bfa',
        },
      },
      boxShadow: {
        'glow-ok': '0 0 6px #4ade80',
        'glow-warn': '0 0 6px #fbbf24',
        'glow-bad': '0 0 6px #f87171',
        'glow-accent': '0 0 8px rgba(74, 222, 128, 0.5)',
      },
      borderWidth: {
        '0.5': '0.5px',
      },
    },
  },
  plugins: [],
};
