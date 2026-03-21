"use client";

import { motion } from 'framer-motion';

interface ProgressThermometerProps {
    current: number;
    goal: number;
}

export default function ProgressThermometer({ current, goal }: ProgressThermometerProps) {
    const progress = Math.min((current / (goal || 1)) * 100, 100);

    return (
        <div className="w-full">
            <div className="flex justify-between items-end mb-3">
                <div>
                    <p className="text-4xl font-black text-slate-900">{current.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 1 })}</p>
                    <p className="text-sm font-bold text-slate-400">Bundles Sold</p>
                </div>
                <div className="text-right">
                    <p className="text-xl font-black text-slate-400">{goal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</p>
                    <p className="text-xs font-black text-slate-300 uppercase tracking-tighter">Bundle Goal</p>
                </div>
            </div>

            {/* Progress Bar Container */}
            <div className="w-full h-6 bg-slate-100 rounded-full overflow-hidden mb-2 relative shadow-inner">
                {/* Background Track Highlights (Marks for 25%, 50%, 75%) */}
                <div className="absolute inset-0 flex justify-between px-4 items-center opacity-20 pointer-events-none">
                    <div className="w-px h-full bg-slate-400" style={{ left: '25%', position: 'absolute' }} />
                    <div className="w-px h-full bg-slate-400" style={{ left: '50%', position: 'absolute' }} />
                    <div className="w-px h-full bg-slate-400" style={{ left: '75%', position: 'absolute' }} />
                </div>

                <motion.div
                    className="h-full bg-gradient-to-r from-indigo-500 to-indigo-600 rounded-full shadow-[inset_0_-2px_4px_rgba(0,0,0,0.1)] relative overflow-hidden"
                    initial={{ width: 0 }}
                    animate={{ width: `${progress}%` }}
                    transition={{ type: 'spring', bounce: 0.25, duration: 1.5, delay: 0.2 }}
                >
                    {/* Shimmer Effect */}
                    <div className="absolute top-0 left-0 right-0 h-1/2 bg-white/20 rounded-t-full" />
                </motion.div>
            </div>
            
            <p className="text-right text-xs font-black text-indigo-600 uppercase italic">
                {progress.toFixed(0)}% Towards Goal!
            </p>
        </div>
    );
}
