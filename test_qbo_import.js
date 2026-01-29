const OAuthClient = require('intuit-oauth');
console.log('Export type:', typeof OAuthClient);
console.log('Keys:', Object.keys(OAuthClient));
try {
    const client = new OAuthClient({ clientId: 'test', clientSecret: 'test' });
    console.log('Instance creation successful');
} catch (e) {
    console.log('Instance creation failed:', e.message);
}
