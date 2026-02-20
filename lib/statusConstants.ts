
export type CustomerStatus =
    | 'LEAD'
    | 'SEND_INFO'
    | 'FLYERS'
    | 'ACTIVE'
    | 'PRODUCTION'
    | 'DELIVERY'
    | 'COMPLETE'
    | 'INACTIVE';

export const STATUS_FLOW: Record<CustomerStatus, CustomerStatus | null> = {
    LEAD: 'SEND_INFO',
    SEND_INFO: 'FLYERS',
    FLYERS: 'ACTIVE',
    ACTIVE: 'PRODUCTION',
    PRODUCTION: 'DELIVERY',
    DELIVERY: 'COMPLETE',
    COMPLETE: null, // Terminal state
    INACTIVE: null, // Terminal state
};

export const STATUS_LABELS: Record<CustomerStatus, string> = {
    LEAD: 'Lead',
    SEND_INFO: 'Send Info',
    FLYERS: 'Send Marketing Tools',
    ACTIVE: 'In Progress',
    PRODUCTION: 'Production',
    DELIVERY: 'Delivery',
    COMPLETE: 'Active',
    INACTIVE: 'Inactive',
};

export const STATUS_COLORS: Record<CustomerStatus, { bg: string; text: string; border: string }> = {
    LEAD: { bg: 'bg-slate-100 dark:bg-slate-800', text: 'text-slate-600 dark:text-slate-400', border: 'border-slate-200 dark:border-slate-700' },
    SEND_INFO: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-400', border: 'border-blue-200 dark:border-blue-800' },
    FLYERS: { bg: 'bg-indigo-100 dark:bg-indigo-900/30', text: 'text-indigo-700 dark:text-indigo-400', border: 'border-indigo-200 dark:border-indigo-800' },
    ACTIVE: { bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-400', border: 'border-emerald-200 dark:border-emerald-800' },
    PRODUCTION: { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-400', border: 'border-amber-200 dark:border-amber-800' },
    DELIVERY: { bg: 'bg-purple-100 dark:bg-purple-900/30', text: 'text-purple-700 dark:text-purple-400', border: 'border-purple-200 dark:border-purple-800' },
    COMPLETE: { bg: 'bg-indigo-600', text: 'text-white', border: 'border-indigo-700' },
    INACTIVE: { bg: 'bg-slate-500', text: 'text-white', border: 'border-slate-600' },
};
