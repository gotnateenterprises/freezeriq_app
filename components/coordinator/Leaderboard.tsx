import { Trophy, Medal, Award, User } from 'lucide-react';

interface Order {
    id: string;
    participant_name?: string | null;
    total_amount: number | string;
    items?: any[];
}

interface LeaderboardProps {
    orders: Order[];
    participantLabel?: string;
}

export default function Leaderboard({ orders, participantLabel = 'Seller' }: LeaderboardProps) {
    // 1. Aggregate Data
    const stats: Record<string, { name: string; total: number; count: number }> = {};

    orders.forEach(order => {
        // Normalize name: trim whitespace, case-insensitive logic could be added if needed
        // If no participant name, ignore or group under "General Sales"
        const rawName = order.participant_name;
        if (!rawName) return;

        const name = rawName.trim();
        if (!stats[name]) {
            stats[name] = { name, total: 0, count: 0 };
        }

        stats[name].total += Number(order.total_amount);
        stats[name].count += 1;
    });

    // 2. Sort & Rank
    const rankings = Object.values(stats)
        .sort((a, b) => b.total - a.total)
        .slice(0, 10); // Top 10

    if (rankings.length === 0) {
        return (
            <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm text-center">
                <div className="w-16 h-16 bg-yellow-50 rounded-full flex items-center justify-center mx-auto mb-4 text-yellow-500">
                    <Trophy size={32} />
                </div>
                <h3 className="text-lg font-black text-slate-900 mb-2">Top {participantLabel}s Leaderboard</h3>
                <p className="text-slate-500 text-sm">
                    No {participantLabel.toLowerCase()} sales recorded yet. Tell your {participantLabel.toLowerCase()}s to enter their name at checkout!
                </p>
            </div>
        );
    }

    return (
        <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm">
            <div className="flex items-center gap-3 mb-6">
                <div className="p-2 bg-yellow-100 text-yellow-600 rounded-xl">
                    <Trophy size={20} />
                </div>
                <h2 className="text-xl font-black text-slate-900">Top {participantLabel}s</h2>
            </div>

            <div className="space-y-4">
                {rankings.map((student, index) => {
                    const isTop3 = index < 3;
                    let RankIcon = null;
                    let rankColor = "bg-slate-100 text-slate-500";

                    if (index === 0) {
                        RankIcon = <Trophy size={16} />;
                        rankColor = "bg-yellow-100 text-yellow-600";
                    } else if (index === 1) {
                        RankIcon = <Medal size={16} />;
                        rankColor = "bg-slate-200 text-slate-600";
                    } else if (index === 2) {
                        RankIcon = <Award size={16} />;
                        rankColor = "bg-orange-100 text-orange-600";
                    } else {
                        RankIcon = <span className="text-xs font-black">{index + 1}</span>;
                    }

                    return (
                        <div key={student.name} className="flex items-center justify-between group">
                            <div className="flex items-center gap-4">
                                <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold ${rankColor}`}>
                                    {RankIcon}
                                </div>
                                <div>
                                    <p className="font-black text-slate-900">{student.name}</p>
                                    <p className="text-xs font-bold text-slate-400">{student.count} orders</p>
                                </div>
                            </div>
                            <div className="text-right">
                                <p className="font-black text-indigo-600 bg-indigo-50 px-3 py-1 rounded-lg">
                                    ${student.total.toFixed(0)}
                                </p>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
