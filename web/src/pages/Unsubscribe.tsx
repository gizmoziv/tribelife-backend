import { useState } from "react";
import { Helmet } from "react-helmet-async";
import Navbar from "@/components/landing/Navbar";
import Footer from "@/components/landing/Footer";
import { motion } from "framer-motion";
import { useSearchParams } from "react-router-dom";

// Base64url charset the backend's decryptToken also requires (TRIBELIFE-CONTRACT.md
// section 3, decrypt rule 1). This is a client-side SHAPE check only — it can reject
// obvious garbage before a network round trip, but it must never be used to claim a
// token IS valid, and it must never distinguish "empty" from "wrong shape" in copy.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+$/;

// Single shared copy for every "this link doesn't work" case (missing token, bad
// shape, and — implicitly — whatever the backend itself would have rejected had we
// asked it). Rendering two different strings here would reintroduce the
// invalid-vs-unknown-user enumeration signal the backend was built to suppress
// (contract section 3 rule 6 / section 5a).
const INVALID_LINK_MESSAGE =
  "This unsubscribe link is not valid. It may be out of date, or the link may have been copied incorrectly.";

// Single shared copy after any completed POST. Never branches on the response body:
// plan 37-01's endpoint deliberately returns an identical 200 for a valid token, an
// invalid token, and an unknown user id, so there is nothing in the body to key text
// on — doing so anyway would just be reading noise as signal.
const CONFIRMATION_MESSAGE =
  "You have been unsubscribed from TribeLife marketing email. This does not affect your account or your in-app notifications.";

const Unsubscribe = () => {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("t") ?? "";

  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [networkError, setNetworkError] = useState("");

  const tokenLooksValid = token.length > 0 && TOKEN_SHAPE.test(token);

  const handleUnsubscribe = async () => {
    if (submitting || done) return;
    setSubmitting(true);
    setNetworkError("");

    try {
      const res = await fetch(`/api/unsubscribe?t=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      });

      // Any response the browser actually received means the backend handled the
      // request — the endpoint returns the same 200 regardless of token validity, so
      // there is no per-outcome branch to make here. A non-ok response (or a thrown
      // network error, caught below) is a transport failure, not a token verdict.
      if (!res.ok) {
        throw new Error("network");
      }

      setDone(true);
    } catch {
      setNetworkError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>Unsubscribe | TribeLife</title>
        <meta
          name="description"
          content="Manage your TribeLife marketing email preferences."
        />
        <link rel="canonical" href="https://tribelife.app/unsubscribe" />
      </Helmet>
      <Navbar />
      <main className="pt-28 pb-20">
        <div className="container mx-auto px-6 max-w-3xl">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <h1 className="text-4xl md:text-5xl font-bold mb-4">
              <span className="gradient-text">Unsubscribe</span>
            </h1>

            {done ? (
              <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-8 text-center">
                <h2 className="text-2xl font-bold mb-2">You're Unsubscribed</h2>
                <p className="text-muted-foreground">{CONFIRMATION_MESSAGE}</p>
              </div>
            ) : !tokenLooksValid ? (
              <div className="rounded-lg border border-border bg-card p-8 text-center">
                <p className="text-muted-foreground">{INVALID_LINK_MESSAGE}</p>
              </div>
            ) : (
              <div className="space-y-6">
                <p className="text-muted-foreground">
                  This will unsubscribe you from marketing email from TribeLife. It does
                  not affect your account or your in-app notifications.
                </p>

                {networkError && (
                  <p className="text-red-500 text-sm">{networkError}</p>
                )}

                <button
                  type="button"
                  onClick={handleUnsubscribe}
                  disabled={submitting}
                  className="w-full rounded-lg bg-primary px-6 py-3 font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {submitting ? "Unsubscribing..." : "Unsubscribe"}
                </button>
              </div>
            )}
          </motion.div>
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default Unsubscribe;
