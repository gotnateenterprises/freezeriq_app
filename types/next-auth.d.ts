
import NextAuth, { DefaultSession } from "next-auth"
import { JWT } from "next-auth/jwt"

declare module "next-auth" {
    interface Session {
        user: {
            id: string
            role: string
            permissions: string[]
            businessId: string
            plan: string
            subscriptionStatus: string
            isSuperAdmin: boolean
        } & DefaultSession["user"]
    }

    interface User {
        role: string
        permissions: string[]
        businessId?: string
        plan?: string
        subscriptionStatus?: string
        isSuperAdmin?: boolean
    }
}

declare module "next-auth/jwt" {
    interface JWT {
        role: string
        permissions: string[]
        businessId?: string
        plan?: string
        subscriptionStatus?: string
        isSuperAdmin?: boolean
    }
}
