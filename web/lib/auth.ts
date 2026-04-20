import NextAuth, { type DefaultSession } from 'next-auth';
import Keycloak from 'next-auth/providers/keycloak';

declare module 'next-auth' {
  interface Session {
    user: DefaultSession['user'] & { id: string };
  }
}

/**
 * Auth.js configuration.
 *
 * Why JWT strategy: we don't want to stand up a second database adapter for
 * sessions — ted already owns the Postgres. The Keycloak subject (sub) is
 * the only identity fact we need, and it lives inside the JWT.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: process.env.NEXTAUTH_SECRET,
  trustHost: true,
  session: { strategy: 'jwt' },
  providers: [
    Keycloak({
      clientId: process.env.AUTH_KEYCLOAK_ID,
      clientSecret: process.env.AUTH_KEYCLOAK_SECRET,
      issuer: process.env.AUTH_KEYCLOAK_ISSUER,
    }),
  ],
  callbacks: {
    // Copy Keycloak `sub` into the JWT. `token.sub` is already the user id
    // from the provider; we just expose it on the client session.
    async session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
});
