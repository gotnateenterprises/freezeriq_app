/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        "./app/**/*.{js,ts,jsx,tsx,mdx}",
        "./components/**/*.{js,ts,jsx,tsx,mdx}",
    ],
    darkMode: 'selector',
    theme: {
        extend: {
            colors: {
                background: "var(--background)",
                foreground: "var(--foreground)",
                primary: "#10b981", // Emerald 500
                secondary: "#6366f1", // Indigo 500
            },
        },
    },
    plugins: [],
}
// Force rebuild: 2026-01-17
