import type { Metadata } from "next";
import Link from "next/link";
import { InfoPage, InfoSectionBlock } from "@/components/info-page";
import { SHIPPING_CENTS } from "@/lib/cart-rules";
import { formatPrice } from "@/lib/catalog";

export const metadata: Metadata = { title: "Returns" };

const link = "font-medium text-primary underline-offset-4 hover:underline";

export default function ReturnsPage() {
  return (
    <InfoPage
      section="Help"
      current="/returns"
      title="Returns"
      intro="Changed your mind? You have 30 days from delivery to send anything back for a full refund."
    >
      <InfoSectionBlock title="What can come back">
        <ul>
          <li>Anything unused, in its original packaging, within 30 days of delivery.</li>
          <li>Linen that has been washed once, if it isn&apos;t what you hoped. We understand you have to try it.</li>
          <li>
            Not candles that have been lit, or pieces marked <strong>final sale</strong>.
          </li>
        </ul>
      </InfoSectionBlock>

      <InfoSectionBlock title="How to return something">
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>
            Email <a href="mailto:hello@fernhillgoods.example" className={link}>hello@fernhillgoods.example</a> with your
            order number and what you&apos;d like to send back.
          </li>
          <li>We reply within one business day with a prepaid return label.</li>
          <li>Pack it the way it came and drop it at any carrier location.</li>
        </ol>
        <p>
          Return shipping is {formatPrice(SHIPPING_CENTS)}, taken from your refund. It&apos;s free when you exchange
          for something else, or when we got it wrong.
        </p>
      </InfoSectionBlock>

      <InfoSectionBlock title="Refunds">
        <p>
          Refunds go back to your original payment method within 5 business days of the parcel reaching us. Your bank
          may take a few more days to show it. Original shipping costs aren&apos;t refunded unless the return is our
          mistake.
        </p>
      </InfoSectionBlock>

      <InfoSectionBlock title="Damaged or defective">
        <p>
          Handmade pieces vary a little, and that&apos;s part of their charm: a speck in a glaze or a knot in the wood
          isn&apos;t a defect. A crack, a chip or a wobble is. Send us a photo within 7 days of delivery and
          we&apos;ll replace it or refund you in full, and you keep the broken piece. More on looking after things in
          the <Link href="/care" className={link}>care guide</Link>.
        </p>
      </InfoSectionBlock>
    </InfoPage>
  );
}
