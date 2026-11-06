import Google from "@auth/core/providers/google";
import { convexAuth } from "@convex-dev/auth/server";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Google],
  callbacks: {
    async redirect({ redirectTo }) {
      // Allow Chrome and Firefox extension redirect URLs for identityLaunchWebAuthFlow
      if (
        redirectTo.startsWith("https://") &&
        (redirectTo.includes(".chromiumapp.org") || redirectTo.includes("moz-extension://"))
      ) {
        return redirectTo;
      }
      return process.env.SITE_URL ?? redirectTo;
    },
  },
});
