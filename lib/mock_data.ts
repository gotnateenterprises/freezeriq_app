
import { SquareOrderPayload } from '../types/integrations';

// Mock Square Payloads
export const MOCK_SQUARE_PAYLOADS: SquareOrderPayload[] = [
    {
        order_id: 'sq_order_998877',
        created_at: new Date().toISOString(),
        customer_name: 'Alice Johnson',
        line_items: [
            {
                uid: 'li_1',
                name: 'Comfort Classics (Serves 5)',
                quantity: '1',
                base_price_money: { amount: 8500, currency: 'USD' }
            }
        ]
    },
    {
        order_id: 'sq_order_665544',
        created_at: new Date().toISOString(),
        customer_name: 'Bob Smith',
        line_items: [
            {
                uid: 'li_2',
                name: 'Taco Tuesday Bundle (Serves 2)',
                quantity: '2',
                base_price_money: { amount: 8400, currency: 'USD' }
            }
        ]
    }
];
