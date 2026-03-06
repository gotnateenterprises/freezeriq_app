
"use client";

import { useActionState, useState } from 'react';
import { authenticate } from '@/lib/actions';
import { Eye, EyeOff } from 'lucide-react';

export default function LoginPage() {
    const [errorMessage, dispatch, isPending] = useActionState(authenticate, undefined);
    const [showPassword, setShowPassword] = useState(false);

    return (
        <main className="flex items-center justify-center md:h-screen">
            <div className="relative mx-auto flex w-full max-w-[400px] flex-col space-y-2.5 p-4 md:-mt-32">
                <div className="flex h-20 w-full items-end rounded-lg bg-blue-500 p-3 md:h-36">
                    <div className="w-32 text-white md:w-36">
                        <span className="flex items-baseline">
                            FreezerIQ<span className="text-[0.7em] ml-0.5 self-start mt-0.5 font-black leading-none">™</span> Login
                        </span>
                    </div>
                </div>
                <form action={dispatch} className="space-y-3">
                    <div className="flex-1 rounded-lg bg-gray-50 px-6 pb-4 pt-8">
                        <h1 className="mb-3 text-2xl">
                            Please log in to continue.
                        </h1>
                        <div className="w-full">
                            <div>
                                <label
                                    className="mb-3 mt-5 block text-xs font-medium text-gray-900"
                                    htmlFor="email"
                                >
                                    Email
                                </label>
                                <div className="relative">
                                    <input
                                        className="peer block w-full rounded-md border border-gray-200 py-[9px] pl-10 text-sm outline-2 placeholder:text-gray-500"
                                        id="email"
                                        type="email"
                                        name="email"
                                        placeholder="Enter your email address"
                                        required
                                    />
                                </div>
                            </div>
                            <div className="mt-4">
                                <label
                                    className="mb-3 mt-5 block text-xs font-medium text-gray-900"
                                    htmlFor="password"
                                >
                                    Password
                                </label>
                                <div className="relative">
                                    <input
                                        className="peer block w-full rounded-md border border-gray-200 py-[9px] pl-10 pr-10 text-sm outline-2 placeholder:text-gray-500"
                                        id="password"
                                        type={showPassword ? "text" : "password"}
                                        name="password"
                                        placeholder="Enter password"
                                        required
                                        minLength={6}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowPassword(!showPassword)}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                                    >
                                        {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                                    </button>
                                </div>
                            </div>
                        </div>
                        <button className="mt-4 w-full bg-blue-500 text-white p-2 rounded disabled:opacity-50" disabled={isPending}>
                            {isPending ? "Logging in..." : "Log in"}
                        </button>
                        <div
                            className="flex h-8 items-end space-x-1"
                            aria-live="polite"
                            aria-atomic="true"
                        >
                            {errorMessage && (
                                <>
                                    <p className="text-sm text-red-500">{errorMessage}</p>
                                </>
                            )}
                        </div>
                    </div>
                </form>
            </div >
        </main >
    );
}
