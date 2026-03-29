'use client';

export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    return (
        <html>
            <body style={{ fontFamily: 'system-ui, sans-serif', display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', backgroundColor: '#f8fafc', margin: 0, padding: '2rem' }}>
                <div style={{ maxWidth: '500px', width: '100%', backgroundColor: 'white', borderRadius: '1.5rem', padding: '2.5rem', boxShadow: '0 10px 40px rgba(0,0,0,0.1)', textAlign: 'center' }}>
                    <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#1e293b', marginBottom: '1rem' }}>Something went wrong</h2>
                    <p style={{ color: '#64748b', marginBottom: '0.5rem' }}>The storefront encountered an unexpected error.</p>
                    <pre style={{ backgroundColor: '#fef2f2', color: '#dc2626', padding: '1rem', borderRadius: '0.75rem', fontSize: '0.75rem', textAlign: 'left', overflow: 'auto', maxHeight: '200px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: '1.5rem' }}>
                        {error.message}
                        {error.digest && `\n\nDigest: ${error.digest}`}
                        {error.stack && `\n\nStack: ${error.stack}`}
                    </pre>
                    <button
                        onClick={reset}
                        style={{ backgroundColor: '#10b981', color: 'white', border: 'none', padding: '0.75rem 2rem', borderRadius: '2rem', fontWeight: 'bold', fontSize: '0.875rem', cursor: 'pointer' }}
                    >
                        Try Again
                    </button>
                </div>
            </body>
        </html>
    );
}
