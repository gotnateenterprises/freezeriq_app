// Reproduce the checkout error and write full output to file
const fs = require('fs');

async function main() {
    const slug = 'freezeriq';
    console.log('Testing slug:', slug);
    
    const res = await fetch('http://localhost:3000/api/checkout/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            slug,
            items: [{
                bundleId: 'test-bundle-id',
                name: 'Test Bundle',
                price: 125,
                quantity: 1,
                serving_tier: 'family'
            }],
            customerName: 'Nathan Hacker',
            customerEmail: 'nate475@gmail.com',
            customerPhone: '555-1234'
        })
    });
    
    const text = await res.text();
    fs.writeFileSync('_debug_output.txt', `Status: ${res.status}\n\n${text}`);
    console.log('Output written to _debug_output.txt');
    console.log('Status:', res.status);
}
main().catch(e => console.error(e));
