"use client";

import { CheckCircle } from 'lucide-react';
import { STATUS_LABELS, STATUS_COLORS, type CustomerStatus } from '@/lib/statusConstants';

interface StatusPipelineProps {
    currentStatus: CustomerStatus;
    onStatusClick?: (status: CustomerStatus) => void;
    allowManualChange?: boolean;
}

const PIPELINE_STAGES: CustomerStatus[] = [
    'LEAD',
    'SEND_INFO',
    'FLYERS',
    'ACTIVE',
    'PRODUCTION',
    'DELIVERY',
    'COMPLETE',
    'INACTIVE'
];

export default function StatusPipeline({
    currentStatus,
    onStatusClick,
    allowManualChange = false
}: StatusPipelineProps) {
    const currentIndex = PIPELINE_STAGES.indexOf(currentStatus);

    return (
        <div className="w-full py-6">
            {/* Pipeline Container */}
            <div className="flex items-center justify-between relative">
                {/* Progress Line */}
                <div className="absolute top-6 left-0 right-0 h-1 bg-slate-200 dark:bg-slate-700" style={{ zIndex: 0 }}>
                    <div
                        className="h-full bg-indigo-500 transition-all duration-500"
                        style={{ width: `${(currentIndex / (PIPELINE_STAGES.length - 1)) * 100}%` }}
                    />
                </div>

                {/* Pipeline Stages */}
                {PIPELINE_STAGES.map((status, index) => {
                    const isCompleted = index < currentIndex;
                    const isCurrent = index === currentIndex;
                    const isPending = index > currentIndex;
                    const colors = STATUS_COLORS[status];

                    return (
                        <div
                            key={status}
                            className="flex flex-col items-center relative"
                            style={{ zIndex: 1, flex: 1 }}
                        >
                            {/* Circle */}
                            <button
                                onClick={() => allowManualChange && onStatusClick?.(status)}
                                disabled={!allowManualChange}
                                className={`
                  w-12 h-12 rounded-full flex items-center justify-center font-black text-sm
                  transition-all duration-300 border-4
                  ${isCurrent ? 'scale-110 shadow-lg' : ''}
                  ${isCompleted ? 'bg-indigo-500 border-indigo-500 text-white' : ''}
                  ${isCurrent ? `${colors.bg} ${colors.border} ${colors.text} shadow-xl` : ''}
                  ${isPending ? 'bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-600 text-slate-400 dark:text-slate-500' : ''}
                  ${allowManualChange && !isPending ? 'cursor-pointer hover:scale-105' : 'cursor-default'}
                `}
                            >
                                {isCompleted ? (
                                    <CheckCircle size={24} className="text-white" />
                                ) : (
                                    <span>{index + 1}</span>
                                )}
                            </button>

                            {/* Label */}
                            <div className="mt-3 text-center">
                                <p className={`
                  text-xs font-bold uppercase tracking-wider whitespace-nowrap
                  ${isCurrent ? colors.text : ''}
                  ${isCompleted ? 'text-indigo-600 dark:text-indigo-400' : ''}
                  ${isPending ? 'text-slate-400 dark:text-slate-500' : ''}
                `}>
                                    {STATUS_LABELS[status]}
                                </p>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
