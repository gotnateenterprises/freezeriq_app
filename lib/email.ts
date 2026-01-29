
import { Resend } from 'resend';


export class EmailService {
    private from: string;
    private resend: Resend;

    constructor() {
        this.from = process.env.EMAIL_FROM || 'onboarding@resend.dev';
        this.resend = new Resend(process.env.RESEND_API_KEY);
    }

    async sendWelcomeEmail(to: string, name: string) {
        if (process.env.NODE_ENV === 'development') {
            console.log(`[DEV] Sending Welcome Email to ${to}`);
            return { success: true, id: 'dev-mock-id' };
        }

        try {
            const data = await this.resend.emails.send({
                from: this.from,
                to: [to],
                subject: 'Welcome to FreezerIQ!',
                html: `
                    <h1>Welcome, ${name}!</h1>
                    <p>We are excited to help you optimize your kitchen production.</p>
                    <p>Click <a href="${process.env.NEXTAUTH_URL}/dashboard">here</a> to access your dashboard.</p>
                `
            });
            return { success: true, id: data.data?.id };
        } catch (error) {
            console.error('Failed to send email:', error);
            return { success: false, error };
        }
    }

    async sendInvoice(to: string, orderId: string, amount: string, pdfLink?: string) {
        if (process.env.NODE_ENV === 'development') {
            console.log(`[DEV] Sending Invoice for Order ${orderId} to ${to}`);
            return { success: true, id: 'dev-mock-id' };
        }

        try {
            const data = await this.resend.emails.send({
                from: this.from,
                to: [to],
                subject: `Invoice for Order #${orderId}`,
                html: `
                    <h1>Thank you for your order!</h1>
                    <p>Order #${orderId} has been confirmed.</p>
                    <p><strong>Total: ${amount}</strong></p>
                    ${pdfLink ? `<p><a href="${pdfLink}">Download PDF Invoice</a></p>` : ''}
                    <p>We appreciate your business.</p>
                `
            });
            return { success: true, id: data.data?.id };
        } catch (error) {
            console.error('Failed to send invoice:', error);
            return { success: false, error };
        }
    }

    // Internal Admin Alert
    async sendAdminAlert(subject: string, message: string) {
        const adminEmail = process.env.ADMIN_EMAIL;
        if (!adminEmail) return;

        try {
            await this.resend.emails.send({
                from: this.from,
                to: [adminEmail],
                subject: `[Admin Alert] ${subject}`,
                html: `<p>${message}</p>`
            });
        } catch (error) {
            console.warn('Failed to alert admin:', error);
        }
    }
}
