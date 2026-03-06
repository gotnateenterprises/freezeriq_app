"use client";

import { useState, useEffect } from 'react';
import { Timer, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface CountdownBannerProps {
    targetDate: string | Date | null;
    primaryColor: string;
}

export default function CountdownBanner({ targetDate, primaryColor }: CountdownBannerProps) {
    const [timeLeft, setTimeLeft] = useState<{ days: number; hours: number; minutes: number; seconds: number } | null>(null);
    const [isExpired, setIsExpired] = useState(false);

    useEffect(() => {
        if (!targetDate) return;

        // Force expiration to be midnight on the target date (or read exact time if provided)
        const target = new Date(targetDate);
        target.setHours(23, 59, 59, 999);

        const calculateTimeLeft = () => {
            const now = new Date();
            const difference = target.getTime() - now.getTime();

            if (difference <= 0) {
                setIsExpired(true);
                setTimeLeft(null);
                return;
            }

            setTimeLeft({
                days: Math.floor(difference / (1000 * 60 * 60 * 24)),
                hours: Math.floor((difference / (1000 * 60 * 60)) % 24),
                minutes: Math.floor((difference / 1000 / 60) % 60),
                seconds: Math.floor((difference / 1000) % 60)
            });
        };

        calculateTimeLeft();
        const timer = setInterval(calculateTimeLeft, 1000);

        return () => clearInterval(timer);
    }, [targetDate]);

    if (!targetDate) return null;

    const monthName = new Date(targetDate).toLocaleString('en-US', { month: 'long' });

    return (
        <AnimatePresence>
            {!isExpired && timeLeft && (
                <motion.div
                    initial={{ y: -50, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: -50, opacity: 0 }}
                    transition={{ type: "spring", stiffness: 300, damping: 30 }}
                    className="w-full relative z-40 px-4 py-3 md:py-4 flex items-center justify-center gap-4 md:gap-8 shadow-xl overflow-hidden"
                    style={{ backgroundColor: primaryColor }}
                >
                    {/* Pulsing glow effect behind text */}
                    <div className="absolute inset-0 bg-white/20 animate-pulse pointer-events-none" />

                    <div className="flex items-center gap-2 md:gap-3 text-white font-black tracking-widest text-xs md:text-sm lg:text-base uppercase text-center sm:text-left drop-shadow-md">
                        <Timer className="hidden sm:block animate-bounce shrink-0 w-5 h-5 md:w-6 md:h-6" />
                        <span className="hidden sm:inline">Last Chance to Order {monthName} Bundles:</span>
                        <span className="sm:hidden text-[10px] leading-tight flex-1">{monthName} Deadline:</span>
                    </div>

                    <div className="flex items-center gap-2 md:gap-4 font-mono font-black text-white text-base md:text-2xl lg:text-3xl drop-shadow-lg">
                        {timeLeft.days > 0 && (
                            <div className="flex items-baseline gap-1 md:gap-1.5">
                                <span>{timeLeft.days}</span>
                                <span className="text-xs md:text-sm lg:text-base opacity-80">D</span>
                            </div>
                        )}
                        <div className="flex items-baseline gap-1 md:gap-1.5">
                            <span>{timeLeft.hours.toString().padStart(2, '0')}</span>
                            <span className="text-xs md:text-sm lg:text-base opacity-80">H</span>
                        </div>
                        <span className="opacity-50 text-sm md:text-lg lg:text-2xl -translate-y-0.5 md:-translate-y-1">:</span>
                        <div className="flex items-baseline gap-1 md:gap-1.5">
                            <span>{timeLeft.minutes.toString().padStart(2, '0')}</span>
                            <span className="text-xs md:text-sm lg:text-base opacity-80">M</span>
                        </div>
                        <span className="opacity-50 text-sm md:text-lg lg:text-2xl -translate-y-0.5 md:-translate-y-1">:</span>
                        <div className="flex items-baseline gap-1 md:gap-1.5">
                            <span>{timeLeft.seconds.toString().padStart(2, '0')}</span>
                            <span className="text-xs md:text-sm lg:text-base opacity-80">S</span>
                        </div>
                    </div>
                </motion.div>
            )}

            {isExpired && (
                <motion.div
                    initial={{ y: -50, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    className="w-full relative z-40 bg-zinc-900 px-4 py-2 flex items-center justify-center gap-3 shadow-md"
                >
                    <AlertCircle size={16} className="text-rose-500" />
                    <span className="text-white font-black tracking-widest text-xs uppercase">Ordering Window Closed</span>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
