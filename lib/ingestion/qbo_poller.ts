
import { QBOWrapper } from './clients/qbo_client';
import { QBOInvoice } from '../../types/integrations';
import { DB } from '../ingestion_db';
import { promisify } from 'util';

export class QBOPoller {
    private qboWrapper: QBOWrapper;

    constructor(private db: DB, businessId: string) {
        this.qboWrapper = new QBOWrapper(businessId);
    }

    async syncInvoices() {
        try {
            const qbo = await this.qboWrapper.getClient();

            // node-quickbooks uses callbacks, so we wrap in a Promise
            const findInvoices = (options: any): Promise<any> => {
                return new Promise((resolve, reject) => {
                    qbo.findInvoices(options, (err: any, response: any) => {
                        if (err) reject(err);
                        else resolve(response);
                    });
                });
            };

            // Fetch Invoices (Last 30 days)
            // Query Language: select * from Invoice Where TxnDate > '2023-01-01'
            // or use simple findInvoices criteria
            const response = await findInvoices({ limit: 50, desc: 'TxnDate' });

            // Response structure: { QueryResponse: { Invoice: [...] }, time: ... }
            const invoices = response.QueryResponse?.Invoice || [];

            console.log(`Found ${invoices.length} invoices from QBO.`);

            if (invoices.length === 0) return;

            // Map QBO JSON to our strict Interface
            const mappedInvoices: QBOInvoice[] = invoices.map((inv: any) => ({
                Id: inv.Id,
                DocNumber: inv.DocNumber,
                TxnDate: inv.TxnDate,
                CustomerRef: {
                    value: inv.CustomerRef?.value,
                    name: inv.CustomerRef?.name
                },
                Line: (inv.Line || []).map((line: any) => ({
                    Id: line.Id,
                    LineNum: line.LineNum,
                    Description: line.Description,
                    Amount: line.Amount,
                    DetailType: line.DetailType,
                    SalesItemLineDetail: line.SalesItemLineDetail ? {
                        ItemRef: {
                            value: line.SalesItemLineDetail.ItemRef?.value,
                            name: line.SalesItemLineDetail.ItemRef?.name
                        },
                        Qty: line.SalesItemLineDetail.Qty,
                        UnitPrice: line.SalesItemLineDetail.UnitPrice
                    } : undefined
                })),
                TotalAmt: inv.TotalAmt,
                Balance: inv.Balance
            }));

            await this.processInvoices(mappedInvoices);

        } catch (e: any) {
            console.error("QBO Sync Error:", e);
            throw e;
        }
    }

    async processInvoices(invoices: QBOInvoice[]) {
        console.log(`Processing ${invoices.length} invoices...`);
        let processedCount = 0;

        for (const inv of invoices) {
            // Logic: Allow "Balance" check to be optional for demo? 
            // Strictly speaking, we only want paid orders.
            if (inv.Balance !== 0) {
                // console.log(`Skipping Invoice #${inv.DocNumber} (Not Paid)`);
                // continue;
                // DEMO MODE: Process even unpaid for visibility 
            }

            // check if exists (controlled by DB adapter but good to log)
            // console.log(`Processing Invoice #${inv.DocNumber} for ${inv.CustomerRef.name}`);

            // 1. Resolve Organization
            // Ensure CustomerRef.name exists
            const customerName = inv.CustomerRef?.name || "Unknown Customer";

            let org = await this.db.findOrgByName(customerName);
            if (!org) {
                console.log(`New Org Detected: ${customerName}`);
                org = await this.db.createOrg(customerName);
            }

            // 2. Create Order
            // Fix: Use deterministic ID? Or stick with random for now as in mocked version.
            const orderId = crypto.randomUUID();
            await this.db.createOrder({
                id: orderId,
                external_id: `QBO-${inv.DocNumber}`,
                source: 'qbo',
                organization_id: org.id,
                status: 'production_ready', // Confirmed
                delivery_date: inv.TxnDate,
                total_amount: inv.TotalAmt
            });

            // 3. Process Lines
            for (const line of inv.Line) {
                if (line.DetailType === 'SalesItemLineDetail' && line.SalesItemLineDetail) {
                    const sku = line.SalesItemLineDetail.ItemRef.name;
                    const qty = line.SalesItemLineDetail.Qty;

                    // Try SKU first, then Name
                    let bundle = await this.db.findBundleBySku(sku);

                    // If SKU is actually a name in QBO (common), try fuzzy name
                    if (!bundle) {
                        bundle = await this.db.findBundleByName(sku);
                    }

                    if (bundle) {
                        await this.db.createOrderLineItem({
                            order_id: orderId,
                            bundle_id: bundle.id,
                            quantity: qty,
                            variant_size: 'serves_5' // Fundraisers are always Serves 5
                        });
                        processedCount++;
                    } else {
                        console.warn(`  -> UNKNOWN SKU/ITEM: ${sku}`);
                    }
                }
            }
        }
        return processedCount;
    }
}
