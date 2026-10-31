import type { Metadata } from "next";
import Link from "next/link";
import { Facts, InfoPage, InfoSectionBlock } from "@/components/info-page";
import { FREE_SHIPPING_CENTS, SHIPPING_CENTS } from "@/lib/cart-rules";
import { formatPrice } from "@/lib/catalog";

export const metadata: Metadata = { title: "Shipping" };

export default function ShippingPage() {
  return (
    <InfoPage
      section="Help"
      current="/shipping"
      title="Shipping"
      intro={
        <>
          Free on orders over {formatPrice(FREE_SHIPPING_CENTS)}, and a flat {formatPrice(SHIPPING_CENTS)} below that.
          Every order is packed by hand in plastic-free packaging.
        </>
      }
    >
      <InfoSectionBlock title="Rates and times">
        <Facts
          items={[
            [`Standard, orders over ${formatPrice(FREE_SHIPPING_CENTS)}`, "Free"],
            [`Standard, orders under ${formatPrice(FREE_SHIPPING_CENTS)}`, formatPrice(SHIPPING_CENTS)],
            ["Standard delivery", "3 to 5 business days"],
            ["Express delivery", "1 to 2 business days, $18"],
            ["Canada", "5 to 10 business days, $15"],
          ]}
        />
        <p>
          Orders placed before noon Pacific on a business day leave our studio the same day; later orders leave the
          next business day. Delivery times start once your order ships.
        </p>
      </InfoSectionBlock>

      <InfoSectionBlock title="Where we ship">
        <p>
          We ship to all 50 US states, APO/FPO addresses and Canada. We don&apos;t ship elsewhere yet: duties and long
          transit are hard on stoneware and glass, and we&apos;d rather get it right closer to home first.
        </p>
      </InfoSectionBlock>

      <InfoSectionBlock title="Tracking">
        <p>
          You&apos;ll get an email with a tracking link as soon as your parcel is scanned by the carrier, usually the
          evening it ships. Larger orders can arrive in more than one box, each with its own tracking number.
        </p>
      </InfoSectionBlock>

      <InfoSectionBlock title="Arrived damaged?">
        <p>
          We pack every piece to survive a drop, but now and then a box has a bad day. Send us a photo within 7 days
          of delivery and we&apos;ll send a replacement or a refund, whichever you prefer, with no need to return the
          broken piece. See <Link href="/returns" className="font-medium text-primary underline-offset-4 hover:underline">Returns</Link>.
        </p>
      </InfoSectionBlock>
    </InfoPage>
  );
}
