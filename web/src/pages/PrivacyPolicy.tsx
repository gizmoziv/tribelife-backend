import Navbar from "@/components/landing/Navbar";
import Footer from "@/components/landing/Footer";
import { motion } from "framer-motion";

const PrivacyPolicy = () => {
  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <main className="pt-28 pb-20">
        <div className="container mx-auto px-6 max-w-3xl">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <h1 className="text-4xl md:text-5xl font-bold mb-4">
              Privacy <span className="gradient-text">Policy</span>
            </h1>
            <p className="text-muted-foreground mb-12">Last updated: March 1, 2026</p>

            <div className="space-y-10 text-foreground/90 leading-relaxed">
              <section>
                <h2 className="text-xl font-bold mb-3">1. Introduction</h2>
                <p className="text-muted-foreground">
                  UBot Labs ("we," "us," or "our") operates the TribeLife mobile application and website. 
                  This Privacy Policy explains how we collect, use, disclose, and safeguard your information 
                  when you use our Service. Please read this policy carefully. By using TribeLife, you consent 
                  to the practices described herein.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">2. Information We Collect</h2>
                <p className="text-muted-foreground mb-3">We collect the following types of information:</p>
                <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                  <li><strong className="text-foreground">Account Information:</strong> Name, email address, phone number, and profile details you provide during registration</li>
                  <li><strong className="text-foreground">Location Data:</strong> Your geographic location to provide local matching and community features</li>
                  <li><strong className="text-foreground">Beacon Data:</strong> Content you create including beacon descriptions, preferences, and matching criteria</li>
                  <li><strong className="text-foreground">Usage Data:</strong> Information about how you interact with the Service, including features used and time spent</li>
                  <li><strong className="text-foreground">Device Information:</strong> Device type, operating system, unique device identifiers, and mobile network information</li>
                </ul>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">3. How We Use Your Information</h2>
                <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                  <li>To provide, maintain, and improve the Service</li>
                  <li>To create intelligent matches between users based on beacons and preferences</li>
                  <li>To personalize your experience and deliver relevant content</li>
                  <li>To communicate with you about updates, security alerts, and support</li>
                  <li>To detect, prevent, and address fraud, abuse, and security issues</li>
                  <li>To comply with legal obligations</li>
                </ul>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">4. Location Data</h2>
                <p className="text-muted-foreground">
                  TribeLife uses your location to connect you with people and opportunities in your community. 
                  We collect location data only when the app is in use (foreground) unless you grant background 
                  location permissions. You can disable location services through your device settings, but this 
                  may limit the functionality of the Service.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">5. Sharing of Information</h2>
                <p className="text-muted-foreground mb-3">We may share your information in the following circumstances:</p>
                <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                  <li><strong className="text-foreground">With Other Users:</strong> Your profile information and beacon content are visible to other users in your community</li>
                  <li><strong className="text-foreground">Service Providers:</strong> Third-party vendors who assist in operating the Service</li>
                  <li><strong className="text-foreground">Legal Requirements:</strong> When required by law or to protect our rights and safety</li>
                  <li><strong className="text-foreground">Business Transfers:</strong> In connection with a merger, acquisition, or sale of assets</li>
                </ul>
                <p className="text-muted-foreground mt-3">
                  We do not sell your personal information to third parties.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">6. Data Security</h2>
                <p className="text-muted-foreground">
                  We implement industry-standard security measures to protect your information, including 
                  encryption in transit and at rest, secure authentication, and regular security audits. 
                  However, no method of transmission over the internet is 100% secure, and we cannot guarantee 
                  absolute security.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">7. Data Retention</h2>
                <p className="text-muted-foreground">
                  We retain your personal information for as long as your account is active or as needed to 
                  provide the Service. You may request deletion of your account and associated data at any time. 
                  We will delete or anonymize your information within 30 days of such a request, except where 
                  retention is required by law.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">8. Your Rights</h2>
                <p className="text-muted-foreground mb-3">Depending on your jurisdiction, you may have the right to:</p>
                <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                  <li>Access the personal information we hold about you</li>
                  <li>Request correction of inaccurate information</li>
                  <li>Request deletion of your information</li>
                  <li>Object to or restrict processing of your information</li>
                  <li>Request data portability</li>
                  <li>Withdraw consent at any time</li>
                </ul>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">9. Children's Privacy</h2>
                <p className="text-muted-foreground">
                  TribeLife is not intended for users under the age of 18. We do not knowingly collect 
                  information from children. If we become aware that we have collected personal information 
                  from a child under 18, we will take steps to delete that information promptly.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">10. Changes to This Policy</h2>
                <p className="text-muted-foreground">
                  We may update this Privacy Policy from time to time. We will notify you of any material 
                  changes by posting the updated policy within the app and updating the "Last updated" date. 
                  Your continued use of the Service after changes constitutes acceptance of the updated policy.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">11. Contact Us</h2>
                <p className="text-muted-foreground">
                  If you have any questions about this Privacy Policy, please contact us at{" "}
                  <a href="mailto:support@tribelife.app" className="text-primary hover:underline">
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

export default PrivacyPolicy;
