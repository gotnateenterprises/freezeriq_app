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
                background: "var(--background)",
                foreground: "var(--foreground)",
                primary: "var(--primary)",
                secondary: "var(--secondary)",
            },
        },
    },
    plugins: [],
}
// Force rebuild: 2026-01-17
