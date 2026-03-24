import { Helmet } from "react-helmet-async";
import Navbar from "@/components/landing/Navbar";
import Footer from "@/components/landing/Footer";
import { motion } from "framer-motion";

const TermsOfService = () => {
  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>Terms of Service | TribeLife</title>
        <meta name="description" content="Read TribeLife's terms of service. Understand the rules and guidelines for using our community matching platform." />
        <link rel="canonical" href="https://tribelife.app/terms" />
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
              Terms of <span className="gradient-text">Service</span>
            </h1>
            <p className="text-muted-foreground mb-12">Last updated: March 1, 2026</p>

            <div className="space-y-10 text-foreground/90 leading-relaxed">
              <section>
                <h2 className="text-xl font-bold mb-3">1. Acceptance of Terms</h2>
                <p className="text-muted-foreground">
                  By accessing or using the TribeLife mobile application and website (collectively, the "Service"), 
                  you agree to be bound by these Terms of Service. If you do not agree to these terms, please do not 
                  use the Service. TribeLife is operated by UBot Labs ("we," "us," or "our").
                </p>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">2. Description of Service</h2>
                <p className="text-muted-foreground">
                  TribeLife is a community-based matching platform that allows users to connect with real people 
                  in their local area. Users can create "beacons" describing specific needs — such as finding 
                  activity partners, service providers, or community connections — and receive intelligent matches 
                  from other users within their community.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">3. User Accounts</h2>
                <p className="text-muted-foreground">
                  To use TribeLife, you must create an account and provide accurate, complete information. You are 
                  responsible for maintaining the confidentiality of your account credentials and for all activities 
                  that occur under your account. You must be at least 16 years old to create an account. You agree 
                  to notify us immediately of any unauthorized use of your account.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">4. User Conduct & Zero-Tolerance Policy</h2>
                <p className="text-muted-foreground mb-3">
                  TribeLife has a <strong>zero-tolerance policy</strong> for objectionable content and abusive behavior.
                  Any user who violates these standards will have their content removed and their account permanently
                  terminated. You agree not to:
                </p>
                <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                  <li>Use the Service for any unlawful purpose or in violation of any applicable laws</li>
                  <li>Harass, abuse, threaten, bully, or harm other users</li>
                  <li>Post objectionable, offensive, sexually explicit, or pornographic content</li>
                  <li>Post content that promotes violence, self-harm, terrorism, or hate speech</li>
                  <li>Post discriminatory content targeting race, ethnicity, religion, gender, sexual orientation, disability, or national origin</li>
                  <li>Post content related to illegal drugs, weapons, or gambling</li>
                  <li>Create false or misleading profiles or beacons</li>
                  <li>Impersonate any person or entity</li>
                  <li>Attempt to gain unauthorized access to the Service or other users' accounts</li>
                  <li>Use the Service to spam, solicit, or advertise without authorization</li>
                  <li>Upload or transmit any malicious code or content</li>
                </ul>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">5. Child Safety Standards</h2>
                <p className="text-muted-foreground mb-3">
                  TribeLife is intended for users aged 16 and older. You must be at least 16 years old to use the Service.
                  TribeLife maintains a <strong>strict zero-tolerance policy toward child sexual abuse and exploitation
                  (CSAE)</strong> in any form. This includes, but is not limited to:
                </p>
                <ul className="list-disc list-inside space-y-2 text-muted-foreground mb-3">
                  <li>Any content that sexualizes, exploits, or endangers minors</li>
                  <li>Sharing, soliciting, or distributing child sexual abuse material (CSAM)</li>
                  <li>Grooming, solicitation, or any predatory behavior toward minors</li>
                  <li>Any content that facilitates or promotes the exploitation of children</li>
                </ul>
                <p className="text-muted-foreground">
                  We proactively screen content using automated moderation systems and human review. Any user found
                  to be in violation of this policy will have their account immediately and permanently terminated,
                  their content removed, and the incident reported to the National Center for Missing & Exploited
                  Children (NCMEC) and applicable law enforcement authorities. To report suspected CSAE content or
                  behavior, contact us immediately at{" "}
                  <a href="mailto:info@tribelife.app" className="text-primary hover:underline">
                    info@tribelife.app
                  </a>{" "}
                  or use the in-app reporting feature.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">6. Content Moderation & Reporting</h2>
                <p className="text-muted-foreground">
                  We actively moderate content on TribeLife using automated systems and human review. All beacons are
                  screened before being published. Users can report objectionable content or abusive behavior directly
                  within the app. We commit to reviewing all reports within 24 hours and will remove offending content
                  and terminate the accounts of users who violate these terms. Users may also block other users at any
                  time, which immediately removes that user's content from their experience.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">7. Beacons and Matching</h2>
                <p className="text-muted-foreground">
                  Beacons created on TribeLife are visible to other users within your community. We use intelligent 
                  matching algorithms to connect users based on relevance, proximity, and preferences. We do not 
                  guarantee the quality, safety, or reliability of any match. Users are solely responsible for 
                  evaluating and interacting with their matches.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">8. Intellectual Property</h2>
                <p className="text-muted-foreground">
                  The Service and its original content, features, and functionality are owned by UBot Labs and are 
                  protected by international copyright, trademark, and other intellectual property laws. You retain 
                  ownership of content you post but grant us a non-exclusive, worldwide license to use, display, 
                  and distribute such content in connection with the Service.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">9. Termination</h2>
                <p className="text-muted-foreground">
                  We reserve the right to suspend or terminate your account at any time, with or without cause, 
                  and with or without notice. You may delete your account at any time through the app settings. 
                  Upon termination, your right to use the Service will immediately cease.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">10. Disclaimers</h2>
                <p className="text-muted-foreground">
                  The Service is provided "as is" and "as available" without warranties of any kind. We do not 
                  warrant that the Service will be uninterrupted, secure, or error-free. We are not responsible 
                  for any interactions between users, including any disputes, damages, or injuries arising from 
                  in-person meetings facilitated through the Service.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">11. Limitation of Liability</h2>
                <p className="text-muted-foreground">
                  To the maximum extent permitted by law, UBot Labs shall not be liable for any indirect, 
                  incidental, special, consequential, or punitive damages arising out of or relating to your 
                  use of the Service.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">12. Changes to Terms</h2>
                <p className="text-muted-foreground">
                  We reserve the right to modify these terms at any time. We will notify users of material changes 
                  through the app or via email. Your continued use of the Service after changes constitutes 
                  acceptance of the updated terms.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-bold mb-3">13. Contact Us</h2>
                <p className="text-muted-foreground">
                  If you have any questions about these Terms of Service, please contact us at{" "}
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

export default TermsOfService;
