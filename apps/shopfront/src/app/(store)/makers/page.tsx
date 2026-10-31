import type { Metadata } from "next";
import Link from "next/link";
import { InfoPage, InfoSectionBlock } from "@/components/info-page";
import type { Category } from "@/lib/catalog";

export const metadata: Metadata = { title: "Our makers" };

const makers: { name: string; where: string; makes: string; category: Category; story: string }[] = [
  {
    name: "Alder & Ash Pottery",
    where: "Asheville, North Carolina",
    makes: "Mugs, bowls, plates and bud vases",
    category: "Tableware",
    story:
      "Two potters and one big gas kiln. Every mug is thrown, trimmed and handled by the same pair of hands, then glazed in small batches, so no two speckled bowls come out quite alike.",
  },
  {
    name: "Saltmarsh Linen",
    where: "Lisbon, Portugal",
    makes: "Tea towels and napkins",
    category: "Linen",
    story:
      "A family workshop that has woven and finished linen for three generations. They stonewash every piece before it ships, so it arrives soft instead of stiff.",
  },
  {
    name: "Olivar Woodworks",
    where: "Jaén, Spain",
    makes: "Olive wood cutting boards",
    category: "Kitchen",
    story:
      "Their wood comes from olive trees pruned or retired from the groves around them. Nothing is felled for a board, and each one is cut to follow the grain of its branch.",
  },
  {
    name: "Brightwater Glass",
    where: "Bend, Oregon",
    makes: "Storage jars and drinking glasses",
    category: "Kitchen",
    story:
      "A small glass studio that makes our jars and ribbed tumblers. The jars' oak lids are turned by a woodworker down the road.",
  },
  {
    name: "Hollow Hive Candle Co.",
    where: "Hudson Valley, New York",
    makes: "Beeswax pillar candles",
    category: "Home",
    story:
      "Beekeepers first and chandlers second. The wax comes from their own hives and a handful of neighbors', hand-poured with cotton wicks and nothing added.",
  },
];

const link = "font-medium text-primary underline-offset-4 hover:underline";

export default function MakersPage() {
  return (
    <InfoPage
      section="Company"
      current="/makers"
      title="Our makers"
      intro="Most of the shop comes from a handful of small workshops we know by name. We visit, we order in small runs, and we pay on time."
    >
      {makers.map((m) => (
        <InfoSectionBlock key={m.name} title={m.name} aside={m.where}>
          <p>{m.story}</p>
          <p>
            <strong>Makes:</strong> {m.makes}.{" "}
            <Link href={`/?category=${encodeURIComponent(m.category)}#shop`} className={link}>
              Shop {m.category.toLowerCase()}
            </Link>
          </p>
        </InfoSectionBlock>
      ))}

      <InfoSectionBlock title="Want to make for us?">
        <p>
          We add a new workshop or two each year. If you make everyday goods for the kitchen, table or home, send a few
          photos and a line about how you work to{" "}
          <a href="mailto:makers@fernhillgoods.example" className={link}>
            makers@fernhillgoods.example
          </a>
          .
        </p>
      </InfoSectionBlock>
    </InfoPage>
  );
}
