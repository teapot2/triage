import type { Metadata } from "next";
import { Facts, InfoPage, InfoSectionBlock } from "@/components/info-page";

export const metadata: Metadata = { title: "Wholesale" };

const link = "font-medium text-primary underline-offset-4 hover:underline";

export default function WholesalePage() {
  return (
    <InfoPage
      section="Company"
      current="/wholesale"
      title="Wholesale"
      intro="We supply independent shops, cafés and restaurants with the same pieces we sell here, in small quantities that suit small businesses."
    >
      <InfoSectionBlock title="Terms">
        <Facts
          items={[
            ["Wholesale price", "50% of retail"],
            ["Opening order", "$300 minimum"],
            ["Reorders", "$150 minimum"],
            ["Payment", "Card on first order, then net 30"],
            ["Lead time", "1 to 2 weeks in stock, 6 to 8 weeks for larger runs"],
            ["Shipping", "Free on orders over $750"],
          ]}
        />
      </InfoSectionBlock>

      <InfoSectionBlock title="For cafés and restaurants">
        <p>
          The stoneware mugs, plates and bowls are made for daily commercial use: dishwasher safe and fired hard enough
          for a busy service. We can hold a glaze for you so replacements match for years, and we sell seconds at a
          further 20% off for back-of-house use.
        </p>
      </InfoSectionBlock>

      <InfoSectionBlock title="How to apply">
        <p>
          Email{" "}
          <a href="mailto:wholesale@fernhillgoods.example" className={link}>
            wholesale@fernhillgoods.example
          </a>{" "}
          with your business name, where you&apos;re based, a link to your shop or menu, and what you&apos;re interested
          in. We reply within a week with our line sheet and an account.
        </p>
        <p>We keep one stockist per neighborhood, so ask early.</p>
      </InfoSectionBlock>
    </InfoPage>
  );
}
