
import { SquareOrderPayload, QBOInvoice } from '../types/integrations';

// Mock QBO Invoices
export const MOCK_QBO_INVOICES: QBOInvoice[] = [
    {
        Id: '1001',
        DocNumber: '1089',
        TxnDate: '2026-01-15',
        CustomerRef: { value: '55', name: 'Westside High School Band' },
        TotalAmt: 4500.00,
        Balance: 0,
        Line: [
            {
                Id: '1',
                LineNum: 1,
                DetailType: 'SalesItemLineDetail',
                Amount: 4500.00,
                SalesItemLineDetail: {
                    ItemRef: { value: 'sku-123', name: 'Comfort Classics Bundle' }, // Will match by name finding 'Comfort Classics'
                    Qty: 50,
                    UnitPrice: 90.00
                }
            }
        ]
    },
    {
        Id: '1002',
        DocNumber: '1092',
        TxnDate: '2026-01-16',
        CustomerRef: { value: '56', name: 'Valley View PTA' },
        TotalAmt: 1200.00,
        Balance: 0,
        Line: [
            {
                Id: '1',
                LineNum: 1,
                DetailType: 'SalesItemLineDetail',
                Amount: 1200.00,
                SalesItemLineDetail: {
                    ItemRef: { value: 'sku-456', name: 'Taco Tuesday' }, // Needs to match valid bundle name
                    Qty: 20,
                    UnitPrice: 60.00
                }
            }
        ]
    }
];

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
