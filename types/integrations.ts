
// Integration Types

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
