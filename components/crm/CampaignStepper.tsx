"use client";

import { useState } from 'react';
import { Check, ChevronRight, Loader2 } from 'lucide-react';
import { useTheme } from '@/components/ThemeProvider';

const STEPS = [
    { id: 'Lead', label: 'Lead' },
    { id: 'Agreement', label: 'Send Info' },
    { id: 'Onboarding', label: 'Marketing Flyers' },
    { id: 'Active', label: 'Active', color: 'bg-emerald-500' },
    { id: 'Production', label: 'Production' },
    { id: 'Delivery', label: 'Delivery' },
    { id: 'Archived', label: 'Complete' }
];

interface CampaignStepperProps {
    campaign: any;
    onUpdateStatus: (newStatus: string) => Promise<void>;
}

export default function CampaignStepper({ campaign, onUpdateStatus }: CampaignStepperProps) {
    const [isUpdating, setIsUpdating] = useState(false);
    const currentStepIndex = STEPS.findIndex(s => s.id === (campaign?.status || 'Lead'));

    const handleStepClick = async (stepId: string, index: number) => {
        if (isUpdating) return;
        if (index === currentStepIndex) return; // No change

        if (confirm(`Move campaign to "${stepId}"?`)) {
            setIsUpdating(true);
            try {
                await onUpdateStatus(stepId);
            } catch (e) {
                console.error(e);
                alert("Failed to update status");
            } finally {
                setIsUpdating(false);
            }
        }
    };

    return (
        <div className="w-full overflow-x-auto pb-4">
            <div className="min-w-[700px] flex items-center justify-between relative px-4">
                {/* Connecting Line */}
                <div className="absolute left-0 top-6 w-full h-1 bg-slate-100 dark:bg-slate-700 -z-10 rounded-full" />

                {/* Active Line Progress */}
                <div
                    className="absolute left-0 top-6 h-1 bg-indigo-500 transition-all duration-500 -z-10 rounded-full"
                    style={{ width: `${(currentStepIndex / (STEPS.length - 1)) * 100}%` }}
                />

                {STEPS.map((step, index) => {
                    const isCompleted = index < currentStepIndex;
                    const isCurrent = index === currentStepIndex;

                    return (
                        <button
                            key={step.id}
                            onClick={() => handleStepClick(step.id, index)}
                            disabled={isUpdating}
                            className={`group flex flex-col items-center gap-3 relative focus:outline-none ${isUpdating ? 'cursor-wait' : 'cursor-pointer'}`}
                        >
                            {/* Circle Indicator */}
                            <div className={`
                                w-12 h-12 rounded-full flex items-center justify-center border-4 transition-all duration-300 z-10
                                ${isCurrent
                                    ? 'bg-white dark:bg-slate-800 border-indigo-500 text-indigo-600 dark:text-indigo-400 scale-110 shadow-lg shadow-indigo-500/20'
                                    : isCompleted
                                        ? 'bg-indigo-500 border-indigo-500 text-white'
                                        : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-300 dark:text-slate-600 hover:border-indigo-300'
                                }
                            `}>
                                {isUpdating && isCurrent ? (
                                    <Loader2 size={20} className="animate-spin" />
                                ) : isCompleted ? (
                                    <Check size={20} strokeWidth={3} />
                                ) : (
                                    <span className={`text-sm font-black ${isCurrent ? 'text-indigo-600 dark:text-indigo-400' : ''}`}>
                                        {index + 1}
                                    </span>
                                )}
                            </div>

                            {/* Label */}
                            <span className={`
                                text-xs font-bold uppercase tracking-wider transition-colors duration-300
                                ${isCurrent
                                    ? 'text-indigo-600 dark:text-indigo-400'
                                    : isCompleted
                                        ? 'text-slate-600 dark:text-slate-400'
                                        : 'text-slate-400 dark:text-slate-600'
                                }
                            `}>
                                {step.label}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
