import { CartProvider } from '@/context/CartContext';
import { Toaster } from 'sonner';

export default function ShopLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <CartProvider>
            {children}
            <Toaster position="top-center" toastOptions={{ duration: 5000 }} />
        </CartProvider>
    );
}
