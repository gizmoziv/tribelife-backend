import { useState } from "react";
import { Helmet } from "react-helmet-async";
import Navbar from "@/components/landing/Navbar";
import Footer from "@/components/landing/Footer";
import { motion } from "framer-motion";
import { trackSupportFormSubmit } from "@/lib/analytics";

const AndroidNotify = () => {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || sending) return;
    setSending(true);
    setError("");
    try {
      const res = await fetch("/api/android-waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to join waitlist");
      }
      setSent(true);
      trackSupportFormSubmit("android-waitlist");
    } catch (err: any) {
      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>Android Coming Soon | TribeLife</title>
        <meta name="description" content="TribeLife is coming to Android. Join the waitlist to be notified when we launch." />
      </Helmet>
      <Navbar />
      <main className="pt-28 pb-20">
        <div className="container mx-auto px-6 max-w-lg text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <div className="text-6xl mb-6">🔥</div>
            <h1 className="text-4xl md:text-5xl font-bold mb-4">
              Android is <span className="gradient-text">Coming Soon</span>
            </h1>
            <p className="text-muted-foreground text-lg mb-10">
              TribeLife for Android is on its way. Leave your email and we'll notify you the moment it's live.
            </p>

            {sent ? (
              <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-8">
                <h2 className="text-2xl font-bold mb-2">You're on the list! 🎉</h2>
                <p className="text-muted-foreground">
                  We'll email you as soon as TribeLife launches on Android.
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  className="w-full rounded-lg border border-border bg-card px-4 py-3 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                />
                {error && <p className="text-red-500 text-sm">{error}</p>}
                <button
                  type="submit"
                  disabled={!email.trim() || sending}
                  className="w-full rounded-lg gradient-bg text-primary-foreground px-6 py-3 font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {sending ? "Joining..." : "Notify Me When Android Launches"}
                </button>
              </form>
            )}

            <p className="text-sm text-muted-foreground mt-6">
              Already on iOS?{" "}
              <a href="https://apps.apple.com/us/app/tribelife-app/id6759845843" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">
                Download now →
              </a>
            </p>
          </motion.div>
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default AndroidNotify;
