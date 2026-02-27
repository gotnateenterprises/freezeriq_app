"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

export function LogoutButton({ slug }: { slug: string }) {
    const router = useRouter();

    const handleLogout = async () => {
        try {
            await fetch("/api/public/customer/auth/logout", { method: "POST" });
            toast.success("Logged out successfully");
            router.push(`/shop/${slug}`);
            router.refresh();
        } catch (error) {
            console.error("Logout failed", error);
        }
    };

    return (
        <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400 font-bold transition-colors text-left"
        >
            <LogOut size={18} /> Sign Out
        </button>
    );
}
