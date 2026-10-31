import type { Metadata } from "next";
import Link from "next/link";
import { ContactForm } from "@/components/contact-form";
import { Facts, InfoPage, InfoSectionBlock } from "@/components/info-page";

export const metadata: Metadata = { title: "Contact us" };

const link = "font-medium text-primary underline-offset-4 hover:underline";

export default function ContactPage() {
  return (
    <InfoPage
      section="Help"
      current="/contact"
      title="Contact us"
      intro="A real person reads every message, usually within one business day."
    >
      <InfoSectionBlock title="Send us a message">
        <ContactForm />
      </InfoSectionBlock>

      <InfoSectionBlock title="Other ways to reach us">
        <Facts
          items={[
            [
              "Email",
              <a key="email" href="mailto:hello@fernhillgoods.example" className={link}>
                hello@fernhillgoods.example
              </a>,
            ],
            ["Phone", "(503) 555-0142"],
            ["Hours", "Monday to Friday, 9 am to 5 pm Pacific"],
            ["Studio", "Portland, Oregon (no walk-ins, sorry)"],
          ]}
        />
        <p>
          Asking about an order? Include your order number and we can answer in one go. For returns, the{" "}
          <Link href="/returns" className={link}>
            returns page
          </Link>{" "}
          has the steps.
        </p>
      </InfoSectionBlock>
    </InfoPage>
  );
}
