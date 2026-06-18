import { Helmet } from "react-helmet-async";
import Navbar from "@/components/landing/Navbar";
import Footer from "@/components/landing/Footer";
import { motion } from "framer-motion";

const DeleteAccount = () => {
  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>Delete Your Account | TribeLife</title>
        <meta name="description" content="How to delete your TribeLife account and associated data. Steps to request account and data deletion from the TribeLife community app." />
        <link rel="canonical" href="https://tribelife.app/delete-account" />
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
              Delete Your <span className="gradient-text">Account</span>
            </h1>
            <p className="text-muted-foreground mb-12">
              You can permanently delete your TribeLife account and associated data at any time.
            </p>

            <div className="space-y-10 text-foreground/90 leading-relaxed">
              <section>
                <h2 className="text-xl font-bold mb-3">Delete your account from the app</h2>
                <p className="text-muted-foreground mb-3">
                  The fastest way to delete your TribeLife account is directly in the app:
                </p>
                <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
                  <li>Open the <strong className="text-foreground">TribeLife</strong> app and sign in.</li>
                  <li>Go to the <strong className="text-foreground">Profile</strong> tab.</li>
                  <li>Scroll down and tap <strong className="text-foreground">Delete Account</strong>.</li>
                  <li>Confirm when prompted. Your account and data are deleted immediately.</li>
                </ol>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">Request deletion by email</h2>
                <p className="text-muted-foreground">
                  If you can no longer access the app, email us at{" "}
                  <a href="mailto:support@tribelife.app" className="text-foreground underline">
                    support@tribelife.app
                  </a>{" "}
                  from the email address associated with your account and ask us to delete your
                  account. We will verify your request and process it within 30 days.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">What gets deleted</h2>
                <p className="text-muted-foreground mb-3">
                  When you delete your account, we permanently remove the data associated with it,
                  including:
                </p>
                <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                  <li>Your account details (name, email address, and sign-in identifiers)</li>
                  <li>Your profile (handle, avatar, timezone, and location used for community features)</li>
                  <li>Your messages, beacons, and other content you created in the app</li>
                  <li>Your notification and push-notification settings</li>
                </ul>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">What may be retained</h2>
                <p className="text-muted-foreground">
                  We may retain a limited amount of information where required to comply with legal
                  obligations, resolve disputes, prevent fraud or abuse, or enforce our terms (for
                  example, records of transactions or moderation actions). Any such data is retained
                  only for as long as necessary for those purposes and is then deleted or anonymized.
                  Purchases and subscriptions are managed by Google Play and are subject to Google's
                  own data retention policies.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">Questions</h2>
                <p className="text-muted-foreground">
                  For more detail on how we handle your data, see our{" "}
                  <a href="/privacy" className="text-foreground underline">Privacy Policy</a>. If you
                  have any questions about deleting your account, contact us at{" "}
                  <a href="mailto:support@tribelife.app" className="text-foreground underline">
                    support@tribelife.app
                  </a>.
                </p>
              </section>
            </div>
          </motion.div>
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default DeleteAccount;
