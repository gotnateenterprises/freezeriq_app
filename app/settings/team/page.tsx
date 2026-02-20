"use client";

import { useState, useEffect } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { Plus, Trash2, Shield, User, Truck, Check, RefreshCw } from 'lucide-react';

interface UserData {
    id: string;
    name: string;
    email: string;
    role: 'ADMIN' | 'CHEF' | 'DRIVER';
    permissions: string[];
    isActive: boolean;
    firstName?: string;
    lastName?: string;
    phone?: string;
    address?: string;
}

export default function TeamSettingsPage() {
    const { data: session } = useSession();
    const [users, setUsers] = useState<UserData[]>([]);

    // Invite Form State
    const [newUserEmail, setNewUserEmail] = useState('');
    const [newUserRole, setNewUserRole] = useState('CHEF');
    const [firstName, setFirstName] = useState('');
    const [lastName, setLastName] = useState('');
    const [phone, setPhone] = useState('');
    const [address, setAddress] = useState('');

    const [isLoading, setIsLoading] = useState(false);


    useEffect(() => {
        if (session?.user?.role === 'ADMIN') {
            fetchUsers();
        }
    }, [session]);

    async function fetchUsers() {
        const res = await fetch('/api/users');
        if (res.ok) {
            setUsers(await res.json());
        }
    }

    // Only Admin can see this
    if (!session || session.user?.role !== 'ADMIN') {
        return (
            <div className="p-12 text-center max-w-lg mx-auto">
                <div className="bg-red-50 text-red-600 p-6 rounded-xl border border-red-100 mb-6">
                    <Shield size={48} className="mx-auto mb-4 opacity-50" />
                    <h2 className="text-xl font-bold mb-2">Access Denied</h2>
                    <p className="mb-4">This page is restricted to Administrators.</p>
                    <p className="text-sm font-mono bg-red-100/50 p-2 rounded mb-4">
                        Current Role: {session?.user?.role || 'None (Stale Session)'}
                    </p>
                    <button
                        onClick={() => signOut({ callbackUrl: '/login' })}
                        className="bg-red-600 text-white px-6 py-2 rounded-lg hover:bg-red-700 font-medium w-full"
                    >
                        Sign Out & Re-Login
                    </button>
                    <p className="text-xs text-red-400 mt-4">
                        (You likely just need to sign in again to pick up your new Admin permissions)
                    </p>
                </div>
            </div>
        );
    }

    async function inviteUser() {
        if (!newUserEmail) return;
        setIsLoading(true);
        try {
            const res = await fetch('/api/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: newUserEmail,
                    role: newUserRole,
                    firstName,
                    lastName,
                    phone,
                    address
                })
            });
            if (res.ok) {
                // Clear Form
                setNewUserEmail('');
                setFirstName('');
                setLastName('');
                setPhone('');
                setAddress('');
                setNewUserRole('CHEF');

                fetchUsers();
            } else {
                alert('Failed to invite user');
            }
        } finally {
            setIsLoading(false);
        }
    }

    async function deleteUser(id: string) {
        if (!confirm('Are you sure you want to remove this user?')) return;
        await fetch(`/api/users?id=${id}`, { method: 'DELETE' });
        fetchUsers();
    }

    async function togglePermission(userId: string, permission: string) {
        // Optimistic update
        const user = users.find(u => u.id === userId);
        if (!user) return;

        const hasPerm = user.permissions.includes(permission);
        const newPerms = hasPerm
            ? user.permissions.filter(p => p !== permission)
            : [...user.permissions, permission];

        await fetch('/api/users', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: userId, permissions: newPerms })
        });
        fetchUsers();
    }

    async function resetPassword(userId: string, userName: string) {
        if (!confirm(`Are you sure you want to reset the password for ${userName}?`)) return;

        const res = await fetch('/api/users/reset-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId })
        });

        const data = await res.json();

        if (res.ok) {
            alert(`✅ Password Reset Successful!\n\nAn email with the new temporary password has been sent to ${userName}.`);
        } else {
            alert('Failed to reset password: ' + data.error);
        }
    }

    return (
        <div className="max-w-4xl mx-auto p-6 space-y-8">
            <div className="flex justify-between items-center">
                <h1 className="text-2xl font-bold font-outfit text-slate-800">Team Management</h1>
            </div>

            {/* Invite Form */}
            <div className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm space-y-4">
                <h2 className="font-semibold text-slate-700 dark:text-white flex items-center gap-2">
                    <User size={18} /> Invite New Member
                </h2>

                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-inest">First Name</label>
                        <input
                            type="text"
                            value={firstName}
                            onChange={e => setFirstName(e.target.value)}
                            className="w-full p-2 border rounded-lg focus:ring-2 focus:ring-emerald-500/20 outline-none bg-white dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                            placeholder="Jane"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wide">Last Name</label>
                        <input
                            type="text"
                            value={lastName}
                            onChange={e => setLastName(e.target.value)}
                            className="w-full p-2 border rounded-lg focus:ring-2 focus:ring-emerald-500/20 outline-none bg-white dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                            placeholder="Doe"
                        />
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wide">Email Address</label>
                        <input
                            type="email"
                            value={newUserEmail}
                            onChange={e => setNewUserEmail(e.target.value)}
                            className="w-full p-2 border rounded-lg focus:ring-2 focus:ring-emerald-500/20 outline-none bg-white dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                            placeholder="chef@example.com"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wide">Phone Number</label>
                        <input
                            type="tel"
                            value={phone}
                            onChange={e => setPhone(e.target.value)}
                            className="w-full p-2 border rounded-lg focus:ring-2 focus:ring-emerald-500/20 outline-none bg-white dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                            placeholder="(555) 123-4567"
                        />
                    </div>
                </div>

                <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wide">Street Address</label>
                    <input
                        type="text"
                        value={address}
                        onChange={e => setAddress(e.target.value)}
                        className="w-full p-2 border rounded-lg focus:ring-2 focus:ring-emerald-500/20 outline-none bg-white dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                        placeholder="123 Culinary Ln, Food City"
                    />
                </div>

                <div className="flex items-end gap-4 pt-2">
                    <div className="w-48">
                        <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wide">Role</label>
                        <select
                            value={newUserRole}
                            onChange={e => setNewUserRole(e.target.value)}
                            className="w-full p-2 border rounded-lg bg-slate-50 dark:bg-slate-900 dark:border-slate-700 dark:text-white"
                        >
                            <option value="CHEF">Chef</option>
                            <option value="DRIVER">Driver</option>
                            <option value="ADMIN">Admin</option>
                        </select>
                    </div>
                    <button
                        onClick={inviteUser}
                        disabled={isLoading}
                        className="flex-1 bg-emerald-600 text-white px-4 py-2 rounded-lg hover:bg-emerald-700 font-medium flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
                    >
                        {isLoading ? <RefreshCw size={18} className="animate-spin" /> : <Plus size={18} />}
                        Send Invite
                    </button>
                </div>
            </div>

            {/* User List */}
            <div className="space-y-4">
                {users.map(user => (
                    <div key={user.id} className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
                        <div className="flex justify-between items-start mb-4">
                            <div className="flex items-center gap-3">
                                <div className={`w-10 h-10 rounded-full flex items-center justify-center ${user.role === 'ADMIN' ? 'bg-purple-100 text-purple-600' :
                                    user.role === 'DRIVER' ? 'bg-blue-100 text-blue-600' :
                                        'bg-orange-100 text-orange-600'
                                    }`}>
                                    {user.role === 'ADMIN' ? <Shield size={20} /> :
                                        user.role === 'DRIVER' ? <Truck size={20} /> :
                                            <User size={20} />}
                                </div>
                                <div>
                                    <h3 className="font-semibold text-slate-800 dark:text-white">{user.name || 'Pending Invite'}</h3>
                                    <p className="text-sm text-slate-500 dark:text-slate-400">{user.email}</p>
                                    {(user.phone || user.address) && (
                                        <div className="mt-1 space-y-0.5">
                                            {user.phone && <p className="text-xs text-slate-400 flex items-center gap-1">📞 {user.phone}</p>}
                                            {user.address && <p className="text-xs text-slate-400 flex items-center gap-1">📍 {user.address}</p>}
                                        </div>
                                    )}
                                </div>
                            </div>
                            <div className="flex items-center gap-4">
                                <span className="px-3 py-1 bg-slate-100 text-slate-600 rounded-full text-xs font-bold uppercase">
                                    {user.role}
                                </span>
                                {user.id !== session?.user?.id && (
                                    <button onClick={() => deleteUser(user.id)} className="text-red-400 hover:text-red-600" title="Remove User">
                                        <Trash2 size={18} />
                                    </button>
                                )}
                                <button onClick={() => resetPassword(user.id, user.name || user.email)} className="text-slate-400 hover:text-indigo-600" title="Reset Password">
                                    <RefreshCw size={18} />
                                </button>
                            </div>
                        </div>

                        {/* Permissions Overrides */}
                        {user.role !== 'ADMIN' && (
                            <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-700">
                                <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Special Access Overrides</p>
                                <div className="flex gap-4">
                                    <PermissionToggle
                                        label="View Financials"
                                        isActive={user.permissions.includes('VIEW_FINANCIALS')}
                                        onClick={() => togglePermission(user.id, 'VIEW_FINANCIALS')}
                                    />
                                    <PermissionToggle
                                        label="Manage Team"
                                        isActive={user.permissions.includes('MANAGE_TEAM')}
                                        onClick={() => togglePermission(user.id, 'MANAGE_TEAM')}
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

function PermissionToggle({ label, isActive, onClick }: { label: string, isActive: boolean, onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors ${isActive ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-700' : 'bg-slate-50 dark:bg-slate-900 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
        >
            <div className={`w-4 h-4 rounded border flex items-center justify-center ${isActive ? 'bg-indigo-600 border-indigo-600' : 'bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-600'
                }`}>
                {isActive && <Check size={12} className="text-white" />}
            </div>
            {label}
        </button>
    );
}
