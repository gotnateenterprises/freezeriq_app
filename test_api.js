const fetch = require('node-fetch');

async function testApi() {
    const slug = 'my-freezer-chef';
    const url = `http://localhost:3000/api/public/tenant/${slug}`;

    console.log(`Testing API: ${url}`);
    try {
        const response = await fetch(url);
        const data = await response.json();
        console.log('Status:', response.status);
        console.log('Response:', JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Fetch error:', e.message);
    }
}

testApi();
