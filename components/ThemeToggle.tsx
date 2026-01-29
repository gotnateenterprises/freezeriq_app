"use client";

import { useTheme } from "./ThemeProvider";
import { Moon, Sun } from "lucide-react";

export default function ThemeToggle() {
    const { theme, toggleTheme } = useTheme();

    return (
        <button
            onClick={toggleTheme}
            className="p-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition-all active:scale-95 shadow-sm"
            aria-label="Toggle Theme"
        >
            {theme === 'light' ? (
                <Moon size={20} strokeWidth={2.5} />
            ) : (
                <Sun size={20} strokeWidth={2.5} />
            )}
        </button>
    );
}
