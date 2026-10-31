import type { Metadata } from "next";
import { InfoPage, InfoSectionBlock } from "@/components/info-page";

export const metadata: Metadata = { title: "Journal" };

// Short notes, newest first, kept whole on one page.
const posts = [
  {
    title: "New this autumn: sage and clay",
    date: "October 2026",
    body: [
      "Alder & Ash spent the summer testing glazes, and two made the cut: a soft sage green and a warm, iron-flecked clay. Both are on the mug, the serving bowl and the dinner plates now.",
      "Because each piece is glazed by hand, the color pools a little darker where the glaze runs thick. The photos show the range; yours will be somewhere in it.",
    ],
  },
  {
    title: "How we pack a mug",
    date: "August 2026",
    body: [
      "Stoneware travels badly in loose fill, so we stopped using it. Every piece now goes into a molded pulp sleeve that holds it off the walls of the box, and the box goes into a second one.",
      "No plastic anywhere: the sleeves, the boxes and the paper tape all go in the recycling, and the sleeves compost.",
    ],
  },
  {
    title: "A visit to the olive groves",
    date: "May 2026",
    body: [
      "We spent a week in Jaén with Olivar Woodworks during pruning season. The branches cut to keep the trees fruiting are the ones that become boards; the trunks of old trees taken out of production make the big ones.",
      "It takes about a year for the wood to dry before it can be cut, which is why we can only order a few hundred boards at a time.",
    ],
  },
  {
    title: "Why we wash linen before it ships",
    date: "February 2026",
    body: [
      "New linen is stiff and a little shiny. Saltmarsh stonewashes every towel and napkin, which softens the fibers and pre-shrinks them, so what you buy is the size it will stay.",
      "It also means the creases you see are the real thing. Linen wrinkles; we've learned to like it.",
    ],
  },
];

export default function JournalPage() {
  return (
    <InfoPage
      section="Company"
      current="/journal"
      title="Journal"
      intro="Notes from the studio and our makers' workshops: new pieces, how things are made, and the occasional visit."
    >
      {posts.map((p) => (
        <InfoSectionBlock key={p.title} title={p.title} aside={p.date}>
          {p.body.map((para) => (
            <p key={para}>{para}</p>
          ))}
        </InfoSectionBlock>
      ))}
    </InfoPage>
  );
}
