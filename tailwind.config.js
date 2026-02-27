/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        "./app/**/*.{js,ts,jsx,tsx,mdx}",
        "./components/**/*.{js,ts,jsx,tsx,mdx}",
    ],
    darkMode: 'class',
    theme: {
        extend: {
            fontFamily: {
                sans: ['var(--font-jakarta)', 'ui-sans-serif', 'system-ui'],
                serif: ['var(--font-playfair)', 'ui-serif', 'Georgia'],
            },
            colors: {
                background: "rgba(var(--background), <alpha-value>)",
                foreground: "rgba(var(--foreground), <alpha-value>)",
                primary: "rgba(var(--primary), <alpha-value>)",
                secondary: "rgba(var(--secondary), <alpha-value>)",
            },
        },
    },
    plugins: [],
}
// Force rebuild: 2026-01-17
