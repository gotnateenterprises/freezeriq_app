export default function PrivacyPage() {
    return (
        <div className="max-w-3xl mx-auto py-12 px-6">
            <h1 className="text-3xl font-bold mb-6">Privacy Policy</h1>
            <div className="space-y-4 text-slate-700">
                <p><strong>Last Updated:</strong> {new Date().toLocaleDateString()}</p>
                <p>Your privacy is important to us. It is our policy to respect your privacy regarding any information we may collect from you across our application.</p>

                <h2 className="text-xl font-bold mt-6">1. Information We Collect</h2>
                <p>We may ask for personal information, such as your: Name, Email, Phone number, Payment information.</p>

                <h2 className="text-xl font-bold mt-6">2. How We Use Information</h2>
                <p>We use the information we collect in various ways, including to: Provide, operate, and maintain our website; Improve, personalize, and expand our website; Understand and analyze how you use our website.</p>

                <h2 className="text-xl font-bold mt-6">3. Data Retention</h2>
                <p>We will retain your personal information only for as long as is necessary for the purposes set out in this Privacy Policy.</p>

                <h2 className="text-xl font-bold mt-6">4. Contact Us</h2>
                <p>If you have any questions about our Privacy Policy, please contact us.</p>
            </div>
        </div>
    );
}
