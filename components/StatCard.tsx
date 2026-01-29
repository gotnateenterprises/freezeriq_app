import Link from 'next/link';

interface StatCardProps {
    title: string;
    value: string | number;
    subtitle?: string;
    trend?: {
        value: number;
        isPositive: boolean;
    };
    icon?: React.ElementType;
    href?: string;
    onClick?: () => void;
}

export default function StatCard({ title, value, subtitle, trend, icon: Icon, href, onClick }: StatCardProps) {
    const Content = (
        <>
            <div className="flex justify-between items-start">
                <div>
                    <p className="text-slate-500 dark:text-slate-400 text-adaptive-subtle text-sm font-bold tracking-wide mb-1 uppercase opacity-70">{title}</p>
                    <h3 className="text-3xl font-black text-slate-900 dark:text-white text-adaptive tracking-tight">{value}</h3>
                    {subtitle && <p className="text-slate-400 text-xs mt-1 font-medium">{subtitle}</p>}
                </div>
                {Icon && (
                    <div className="p-4 bg-indigo-50 dark:bg-indigo-900/40 rounded-2xl text-indigo-600 dark:text-indigo-400 group-hover:scale-110 transition-transform duration-300">
                        <Icon size={24} />
                    </div>
                )}
            </div>

            {trend && (
                <div className={`mt-4 flex items-center text-sm font-bold ${trend.isPositive ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 w-fit px-2 py-1 rounded-lg' : 'text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/30 w-fit px-2 py-1 rounded-lg'
                    }`}>
                    <span>{trend.isPositive ? '↑' : '↓'} {Math.abs(trend.value)}%</span>
                    <span className="text-slate-400 ml-2 font-medium bg-transparent">vs last week</span>
                </div>
            )}
        </>
    );

    const containerClasses = `bg-white dark:bg-slate-800 bg-adaptive rounded-3xl p-6 shadow-soft hover:shadow-lg transition-all duration-300 group block h-full w-full text-left ${(href || onClick) ? 'cursor-pointer' : ''
        }`;

    if (href) {
        return <Link href={href} className={containerClasses}>{Content}</Link>;
    }

    if (onClick) {
        return <button onClick={onClick} className={containerClasses}>{Content}</button>;
    }

    return (
        <div className={containerClasses}>
            {Content}
        </div>
    );
}
