/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./index.html', './help.html', './help-ru.html'],
  theme: {
    extend: {
      textColor: {
        heading: '#1e293b',
      },
    },
  },
  plugins: [],
}