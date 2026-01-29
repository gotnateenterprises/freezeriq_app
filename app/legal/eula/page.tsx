export default function EULAPage() {
    return (
        <div className="max-w-3xl mx-auto py-12 px-6">
            <h1 className="text-3xl font-bold mb-6">End User License Agreement (EULA)</h1>
            <div className="space-y-4 text-slate-700">
                <p><strong>Last Updated:</strong> {new Date().toLocaleDateString()}</p>
                <p>This End User License Agreement ("Agreement") is between you and the Application Owner and governs use of this app made available through the Apple App Store or Google Play Store.</p>

                <h2 className="text-xl font-bold mt-6">1. Acceptance of Terms</h2>
                <p>By installing or using the Application, you agree to be bound by this Agreement. If you do not agree, do not use the Application.</p>

                <h2 className="text-xl font-bold mt-6">2. License Grant</h2>
                <p>We grant you a revocable, non-exclusive, non-transferable, limited license to download, install, and use the Application strictly in accordance with the terms of this Agreement.</p>

                <h2 className="text-xl font-bold mt-6">3. Restrictions</h2>
                <p>You agree not to license, sell, rent, lease, assignment, distribute, transmit, host, outsource, disclose, or otherwise commercially exploit the Application.</p>

                <h2 className="text-xl font-bold mt-6">4. Disclaimer of Warranty</h2>
                <p>The Application is provided "AS IS" without warranty of any kind. We disclaim all warranties, whether express or implied.</p>
            </div>
        </div>
    );
}
