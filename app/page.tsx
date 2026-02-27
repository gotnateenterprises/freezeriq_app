import { auth } from '@/auth';
import DashboardClient from './DashboardClient';

export default async function Page() {
    const session = await auth();

    // The LayoutWrapper handles hiding the sidebar if there is no session,
    // and the middleware usually handles actual protection.
    // If they land here without a session, we just render the client which will 
    // handle its own loading/empty states or the Next.js middleware will catch them.
    return <DashboardClient session={session} />;
}
