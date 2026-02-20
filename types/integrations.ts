
// Integration Types

// ==========================================
// 1. Square Integration
// ==========================================

export interface SquareMoney {
    amount: number;
    currency: string;
}

export interface SquareModifier {
    name: string;
    catalog_object_id?: string;
}

export interface SquareLineItem {
    uid: string;
    name: string;
    quantity: string; // Square sends string
    base_price_money?: SquareMoney;
    catalog_object_id?: string; // Maps to Bundle SKU (fallback)
    sku?: string; // Direct mapping to Bundle SKU
    note?: string; // Fallback for custom items where SKU is in note
    modifiers?: SquareModifier[];
}

export interface SquareOrderPayload {
    order_id: string;
    created_at: string;
    customer_id?: string;
    customer_name?: string; // Augmented for internal use
    customer_email?: string;
    customer_phone?: string;
    line_items: SquareLineItem[];
}

// ==========================================
// 2. QuickBooks Online Integration
// ==========================================

export interface QBOCustomerRef {
    value: string; // ID
    name: string; // Org Name
}

export interface QBOItemRef {
    value: string;
    name: string; // Maps to SKU
}

export interface QBOSalesItemLineDetail {
    ItemRef: QBOItemRef;
    Qty: number;
    UnitPrice: number;
}

export interface QBOLine {
    Id: string;
    LineNum: number;
    Description?: string;
    Amount: number;
    DetailType: 'SalesItemLineDetail' | 'SubTotalLineDetail';
    SalesItemLineDetail?: QBOSalesItemLineDetail;
}

export interface QBOInvoice {
    Id: string;
    DocNumber: string;
    TxnDate: string;
    CustomerRef: QBOCustomerRef;
    Line: QBOLine[];
    TotalAmt: number;
    Balance: number; // 0 = Paid
}
